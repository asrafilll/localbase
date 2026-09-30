import net from "node:net";
import type {
	GitView,
	HubOverview,
	PortView,
	ProjectDetail,
	ProjectSummary,
	ServiceStatus,
	ServiceView,
} from "#/lib/types";
import { type DockerContainer, dockerContainers } from "./docker";
import { gitInfo } from "./git";
import { isLoopbackHost } from "./magic-login";
import { isInside, tildify } from "./paths";
import { guessServiceType, type ListeningPort, listeningPorts } from "./ports";
import { type LoadedProject, loadProjects } from "./registry";
import { activeRuns, listRuns } from "./runner";
import type { ServiceConfig } from "./schema";
import { isTrusted } from "./trust";

type ValidProject = Extract<LoadedProject, { ok: true }>;

type Snapshot = {
	ports: ListeningPort[];
	docker: { available: boolean; containers: DockerContainer[] };
};

async function snapshot(): Promise<Snapshot> {
	const [ports, docker] = await Promise.all([
		listeningPorts(),
		dockerContainers(),
	]);
	return { ports, docker };
}

/** Port a service is expected on: explicit `port`, else from a loopback `url`. */
export function servicePort(service: ServiceConfig) {
	if (service.port) return service.port;
	if (!service.url) return undefined;
	const url = new URL(service.url);
	if (!isLoopbackHost(url.hostname)) return undefined;
	return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

function tcpOpen(port: number, host: string) {
	return new Promise<boolean>((resolve) => {
		const socket = net.connect({ port, host });
		const done = (ok: boolean) => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(300, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

async function healthcheck(url: string) {
	try {
		const res = await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(1500),
		});
		return { ok: res.status < 400, detail: `healthcheck ${res.status}` };
	} catch (err) {
		return { ok: false, detail: `healthcheck failed: ${(err as Error).name}` };
	}
}

function containerStatus(c: DockerContainer): ServiceStatus {
	if (c.state === "running") return "running";
	if (c.state === "restarting" || c.state === "dead") return "error";
	if (c.state === "exited" && !/Exited \(0\)/.test(c.status)) return "error";
	return "stopped";
}

async function serviceView(
	project: ValidProject,
	key: string,
	service: ServiceConfig,
	snap: Snapshot,
): Promise<ServiceView> {
	const port = servicePort(service);
	const base: ServiceView = {
		key,
		label: service.label ?? key,
		kind: service.kind,
		url: service.url,
		port,
		connection: service.connection,
		status: "unknown",
	};

	if (service.container) {
		if (!snap.docker.available)
			return { ...base, detail: "Docker is not running" };
		const c = snap.docker.containers.find((x) => x.name === service.container);
		if (!c)
			return {
				...base,
				status: "stopped",
				detail: `container ${service.container} not found`,
			};
		return {
			...base,
			status: containerStatus(c),
			detail: `${c.name}: ${c.status}`,
		};
	}

	if (port) {
		const owner = snap.ports.find((p) => p.port === port);
		let listening = Boolean(owner);
		// lsof only sees our own user's processes; fall back to a TCP probe.
		if (!listening)
			listening =
				(await tcpOpen(port, "127.0.0.1")) || (await tcpOpen(port, "::1"));
		if (!listening)
			return {
				...base,
				status: "stopped",
				detail: `nothing listening on :${port}`,
			};
		const who = owner ? `${owner.process}, pid ${owner.pid}` : "port open";
		if (service.healthcheck) {
			const hc = await healthcheck(service.healthcheck);
			return {
				...base,
				status: hc.ok ? "running" : "error",
				detail: `${who}; ${hc.detail}`,
			};
		}
		return { ...base, status: "running", detail: `listening (${who})` };
	}

	if (service.healthcheck) {
		const hc = await healthcheck(service.healthcheck);
		return {
			...base,
			status: hc.ok ? "running" : "stopped",
			detail: hc.detail,
		};
	}

	if (service.command) {
		const run = activeRuns(project.id).find(
			(r) => r.commandKey === service.command,
		);
		return run
			? { ...base, status: "running", detail: `hub-managed, pid ${run.pid}` }
			: {
					...base,
					status: "stopped",
					detail: `"${service.command}" not running`,
				};
	}

	return {
		...base,
		detail: "no port, container, healthcheck or command to check",
	};
}

function projectStatus(
	services: ServiceView[],
	hasActiveRuns: boolean,
): ProjectSummary["status"] {
	const known = services.filter((s) => s.status !== "unknown");
	const running = known.filter((s) => s.status === "running").length;
	if (known.length === 0) return hasActiveRuns ? "running" : "unknown";
	if (running === known.length) return "running";
	if (running > 0 || hasActiveRuns) return "partial";
	return "stopped";
}

const gitCache = new Map<
	string,
	{ at: number; value: Promise<GitView | null> }
>();
function cachedGit(root: string) {
	const hit = gitCache.get(root);
	if (hit && Date.now() - hit.at < 3000) return hit.value;
	const value = gitInfo(root);
	gitCache.set(root, { at: Date.now(), value });
	return value;
}

async function summarize(
	project: LoadedProject,
	snap: Snapshot,
): Promise<ProjectSummary> {
	const common = {
		id: project.id,
		root: project.root,
		rootDisplay: tildify(project.root),
	};
	if (!project.ok) {
		return {
			...common,
			name: project.id,
			status: "invalid",
			error: project.error,
			git: await cachedGit(project.root),
			services: [],
			links: [],
			personas: [],
			magicLogin: false,
			commandKeys: [],
			stack: [],
		};
	}
	const c = project.config;
	const [services, git] = await Promise.all([
		Promise.all(
			Object.entries(c.services ?? {}).map(([k, s]) =>
				serviceView(project, k, s, snap),
			),
		),
		cachedGit(project.root),
	]);
	return {
		...common,
		name: c.name,
		description: c.description,
		type: c.type,
		stack: c.stack ?? [],
		status: projectStatus(services, activeRuns(project.id).length > 0),
		mainUrl: c.url ?? Object.values(c.services ?? {}).find((s) => s.url)?.url,
		git,
		services,
		links: c.links ?? [],
		personas: Object.entries(c.personas ?? {}).map(([key, p]) => ({
			key,
			...p,
		})),
		magicLogin: Boolean(c.magicLogin),
		commandKeys: Object.keys(c.commands ?? {}),
	};
}

/** Maps every listening port to a project/service when it can. */
function classifyPorts(projects: LoadedProject[], snap: Snapshot): PortView[] {
	const valid = projects.filter((p): p is ValidProject => p.ok);
	return snap.ports.map((p) => {
		const container = snap.docker.containers.find(
			(c) => c.state === "running" && c.hostPorts.includes(p.port),
		);
		// Docker-published ports are owned by the Docker VM process, so its cwd is
		// meaningless; the compose working_dir label tells us the real project.
		const cwd = container?.composeDir ?? p.cwd;
		let match: { project: ValidProject; serviceKey?: string } | undefined;
		for (const project of valid) {
			const serviceKey = Object.entries(project.config.services ?? {}).find(
				([, s]) =>
					servicePort(s) === p.port ||
					(container && s.container === container.name),
			)?.[0];
			if (serviceKey) {
				match = { project, serviceKey };
				break;
			}
		}
		match ??= (() => {
			if (!cwd) return undefined;
			// Deepest root wins so nested repos (monorepo/app) map correctly.
			const owner = valid
				.filter((project) => isInside(cwd, project.root))
				.sort((a, b) => b.root.length - a.root.length)[0];
			return owner ? { project: owner } : undefined;
		})();
		return {
			port: p.port,
			addresses: p.addresses,
			pid: p.pid,
			process: p.process,
			commandLine: p.commandLine,
			cwd: cwd ? tildify(cwd) : undefined,
			type: container ? `Docker · ${container.image}` : guessServiceType(p),
			container: container?.name,
			projectId: match?.project.id,
			projectName: match?.project.config.name,
			serviceKey: match?.serviceKey,
			system: !container && (!p.cwd || p.cwd === "/"),
			isHub: p.pid === process.pid,
		};
	});
}

export async function overview(): Promise<HubOverview> {
	const [projects, snap] = await Promise.all([loadProjects(), snapshot()]);
	const summaries = await Promise.all(projects.map((p) => summarize(p, snap)));
	const unknownPorts = classifyPorts(projects, snap).filter(
		(p) => !p.projectId && !p.isHub,
	);
	return {
		projects: summaries,
		unknownPorts,
		dockerAvailable: snap.docker.available,
	};
}

export async function allPorts() {
	const [projects, snap] = await Promise.all([loadProjects(), snapshot()]);
	return {
		ports: classifyPorts(projects, snap),
		dockerAvailable: snap.docker.available,
	};
}

export async function projectDetail(id: string): Promise<ProjectDetail> {
	const [projects, snap] = await Promise.all([loadProjects(), snapshot()]);
	const project = projects.find((p) => p.id === id);
	if (!project) throw new Error(`Unknown project: ${id}`);
	const summary = await summarize(project, snap);
	const extraPorts = classifyPorts(projects, snap).filter(
		(p) => p.projectId === id && !p.serviceKey,
	);
	if (!project.ok) {
		return {
			...summary,
			commands: [],
			trusted: false,
			scenarios: [],
			runs: listRuns(id),
			extraPorts,
		};
	}
	const c = project.config;
	return {
		...summary,
		commands: Object.entries(c.commands ?? {}).map(([key, cmd]) => ({
			key,
			label: cmd.label ?? key,
			command: cmd.command,
			cwd: cmd.cwd,
			longRunning: Boolean(cmd.longRunning),
		})),
		trusted: await isTrusted(project.root, c),
		scenarios: Object.entries(c.scenarios ?? {}).map(([key, s]) => ({
			key,
			...s,
		})),
		runs: listRuns(id),
		extraPorts,
	};
}
