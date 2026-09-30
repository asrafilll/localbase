import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { detectPackageManager } from "./detect";
import { isInside } from "./paths";
import {
	nextFreePort,
	nodeCommandForPort,
	type PortedCommand,
	retargetCommand,
} from "./portalloc";
import { listeningPorts } from "./ports";
import { type LoadedProject, loadProjects, PROJECT_FILE } from "./registry";
import type { ServiceConfig } from "./schema";

type ValidProject = Extract<LoadedProject, { ok: true }>;

function localPort(url: string | undefined) {
	if (!url) return undefined;
	try {
		const u = new URL(url);
		if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))
			return undefined;
		return Number(u.port || 80);
	} catch {
		return undefined;
	}
}

const portOf = (s: ServiceConfig) => s.port ?? localPort(s.url);

/**
 * Ports this project must not use: ones configured by other registered
 * projects, and ones held by processes running outside this repository.
 */
export async function takenPorts(excludeRoot?: string) {
	const [projects, ports] = await Promise.all([
		loadProjects(),
		listeningPorts(),
	]);
	const taken = new Map<number, string>();
	for (const p of projects) {
		if (!p.ok || p.root === excludeRoot) continue;
		for (const s of Object.values(p.config.services ?? {})) {
			const port = portOf(s);
			if (port) taken.set(port, p.config.name);
		}
	}
	for (const lp of ports) {
		if (excludeRoot && lp.cwd && isInside(lp.cwd, excludeRoot)) continue;
		if (!taken.has(lp.port))
			taken.set(lp.port, `${lp.process} (pid ${lp.pid})`);
	}
	return taken;
}

/** The start command for `port`, derived from the current command and package.json. */
async function startCommandFor(
	project: ValidProject,
	current: string,
	port: number,
): Promise<PortedCommand | null> {
	const retargeted = retargetCommand(current, port);
	if (retargeted) return { command: retargeted };
	const pkg = JSON.parse(
		(await fs
			.readFile(path.join(project.root, "package.json"), "utf8")
			.catch(() => "{}")) || "{}",
	) as {
		scripts?: Record<string, string>;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const scripts = pkg.scripts ?? {};
	const scriptName = Object.keys(scripts).find(
		(name) => current.endsWith(` ${name}`) || current.endsWith(`run ${name}`),
	);
	if (!scriptName) return null;
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	const framework = [
		["next", "Next.js"],
		["nuxt", "Nuxt"],
		["@sveltejs/kit", "SvelteKit"],
		["astro", "Astro"],
		["@remix-run/dev", "Remix"],
		["@react-router/dev", "React Router"],
		["@tanstack/react-start", "TanStack Start"],
		["@angular/core", "Angular"],
		["gatsby", "Gatsby"],
		["vite", "Vite"],
	].find(([dep]) => dep in deps)?.[1];
	const ported = nodeCommandForPort({
		pm: await detectPackageManager(project.root),
		framework,
		scriptName,
		script: scripts[scriptName],
		port,
	});
	if (!ported) return null;
	// Keep anything that ran before the dev server (e.g. `docker compose up -d && `).
	const cut = current.lastIndexOf(" && ");
	const prefix = cut >= 0 ? current.slice(0, cut + 4) : "";
	return { ...ported, command: `${prefix}${ported.command}` };
}

/**
 * Moves a project's main web service to a free port: updates the service
 * URL, `url`, a Magic Login endpoint on that port, and the start command, in
 * `.dev/project.yaml` (comments preserved). Changing the start command means
 * the user reviews and trusts it again, which is intended.
 */
export async function reassignPort(project: ValidProject) {
	const services = project.config.services ?? {};
	const entry =
		Object.entries(services).find(([, s]) => s.kind === "web" && portOf(s)) ??
		Object.entries(services).find(([, s]) => s.url && portOf(s));
	if (!entry)
		throw new Error(`${project.config.name} has no local web service to move`);
	const [key, service] = entry;
	const oldPort = portOf(service) as number;
	const taken = await takenPorts(project.root);
	const port = nextFreePort(oldPort, taken);

	const startRaw = project.config.commands?.start;
	const ported = startRaw
		? await startCommandFor(project, startRaw.command, port)
		: null;
	if (startRaw && !ported) {
		throw new Error(
			`Can't change the port in "${startRaw.command}" automatically (the dev script sets it). Edit package.json to use port ${port}.`,
		);
	}

	const file = path.join(project.root, PROJECT_FILE);
	const doc = YAML.parseDocument(await fs.readFile(file, "utf8"));
	const swap = (url: unknown) =>
		typeof url === "string" && localPort(url) === oldPort
			? url.replace(`:${oldPort}`, `:${port}`)
			: url;
	if (service.url) doc.setIn(["services", key, "url"], swap(service.url));
	if (service.port === oldPort) doc.setIn(["services", key, "port"], port);
	if (service.healthcheck)
		doc.setIn(["services", key, "healthcheck"], swap(service.healthcheck));
	if (project.config.url) doc.setIn(["url"], swap(project.config.url));
	const ml = project.config.magicLogin;
	if (ml?.endpoint) doc.setIn(["magicLogin", "endpoint"], swap(ml.endpoint));
	for (const [k, link] of (project.config.links ?? []).entries())
		doc.setIn(["links", k, "url"], swap(link.url));
	if (ported && startRaw) {
		const node = doc.getIn(["commands", "start"]);
		if (YAML.isScalar(node) || typeof node === "string") {
			doc.setIn(
				["commands", "start"],
				ported.env
					? { command: ported.command, env: ported.env }
					: ported.command,
			);
		} else {
			doc.setIn(["commands", "start", "command"], ported.command);
			if (ported.env)
				doc.setIn(["commands", "start", "env"], {
					...startRaw.env,
					...ported.env,
				});
		}
	}
	await fs.writeFile(file, doc.toString());
	return {
		from: oldPort,
		to: port,
		command: ported?.command,
		usedBy: taken.get(oldPort),
	};
}
