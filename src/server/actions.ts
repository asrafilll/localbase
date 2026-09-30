import path from "node:path";
import type { StartResult } from "#/lib/types";
import { deleteSnapshot, restoreSnapshot, saveSnapshot } from "./database";
import { killPort } from "./killport";
import {
	createMagicLoginUrl,
	publicKeyEnvValue,
	publicKeyPem,
} from "./magic-login";
import type { Persona } from "./magic-setup";
import { type OpenTarget, openPath } from "./open";
import { expandHome, hubHome, hubPaths, tildify } from "./paths";
import { proxyPortInUse } from "./proxy";
import { reassignPort as reassignPortIn, takenPorts } from "./reassign";
import {
	getProject,
	getValidProject,
	loadProjects,
	previewProject,
	readHubConfig,
	removeProjectRoot,
	scaffoldProject,
} from "./registry";
import {
	activeRuns,
	getRun,
	runLogTail,
	startRun,
	stopRun,
	waitForRun,
} from "./runner";
import { conflictsFor } from "./status";
import { isTrusted, trust } from "./trust";

/**
 * Everything the hub can *do*, shared by the dashboard's server functions,
 * the REST API (/api/v1), the CLI and the MCP server.
 */

export async function trustedProject(id: string) {
	const project = await getValidProject(id);
	if (!(await isTrusted(project.root, project.config))) {
		throw new Error(
			`Review and trust ${project.config.name}'s commands in Local Dev Hub before running them.`,
		);
	}
	return project;
}

export async function runCommand(id: string, key: string) {
	return startRun(await trustedProject(id), key);
}

/**
 * Starts a project. Unless `force`, first checks that no other process holds
 * its ports; `killConflicts` frees them first.
 */
export async function startProject(
	id: string,
	opts: { force?: boolean; killConflicts?: boolean } = {},
): Promise<StartResult> {
	const project = await trustedProject(id);
	if (!opts.force) {
		const conflicts = await conflictsFor(project);
		if (conflicts.length && !opts.killConflicts)
			return { ok: false, conflicts };
		for (const port of new Set(conflicts.map((c) => c.port)))
			await killPort(port);
	}
	return { ok: true, run: await startRun(project, "start") };
}

export async function stopProject(id: string) {
	const project = await trustedProject(id);
	// Hub-owned processes are always stopped; a `stop` command additionally
	// handles anything started elsewhere (e.g. docker compose down).
	const running = activeRuns(id);
	for (const run of running) stopRun(run.id);
	await Promise.all(running.map((r) => waitForRun(r.id, 8000).catch(() => {})));
	if (project.config.commands?.stop) {
		const run = await startRun(project, "stop");
		await waitForRun(run.id);
	}
}

export async function restartProject(id: string) {
	const project = await trustedProject(id);
	if (project.config.commands?.restart) return startRun(project, "restart");
	await stopProject(id);
	// Give killed dev servers a moment to release their ports.
	await new Promise((r) => setTimeout(r, 500));
	return startRun(project, "start");
}

export function stopCommandRun(runId: string) {
	stopRun(runId);
}

export function runInfo(runId: string, tail = 200) {
	const run = getRun(runId);
	if (!run) throw new Error(`Unknown run ${runId}`);
	return { run, lines: runLogTail(runId, tail) ?? [] };
}

export async function magicLoginUrl(id: string, persona: string) {
	return createMagicLoginUrl(await getValidProject(id), persona);
}

/** Prepares a scenario (snapshot restore and/or seed), then returns its login URL. */
export async function loadScenario(id: string, scenarioKey: string) {
	const project = await getValidProject(id);
	const scenario = project.config.scenarios?.[scenarioKey];
	if (!scenario) throw new Error(`Unknown scenario: ${scenarioKey}`);
	if (scenario.snapshot) {
		await trustedProject(id);
		await restoreSnapshot(project, scenario.snapshot);
	}
	if (scenario.seed) {
		await trustedProject(id);
		const run = await waitForRun((await startRun(project, scenario.seed)).id);
		if (run.status !== "succeeded") {
			throw new Error(
				`Seed "${scenario.seed}" ${run.status} (exit ${run.exitCode}). See its logs.`,
			);
		}
	}
	const url =
		scenario.persona && project.config.magicLogin
			? await createMagicLoginUrl(project, scenario.persona)
			: null;
	return { url };
}

export async function snapshotAction(
	id: string,
	action: "save" | "restore" | "delete",
	name: string,
) {
	const project = await trustedProject(id);
	if (action === "save") return saveSnapshot(project, name);
	if (action === "restore") return restoreSnapshot(project, name);
	return deleteSnapshot(project, name);
}

export async function openRepo(id: string, target: OpenTarget) {
	const project = await getProject(id);
	await openPath(project.root, target);
}

export async function trustProject(id: string) {
	const project = await getValidProject(id);
	await trust(project.root, project.config);
}

export async function registerProject(p: string, port?: number, yaml?: string) {
	const root = await scaffoldProject(
		expandHome(p),
		port,
		yaml,
		await takenPorts(path.resolve(expandHome(p))),
	);
	const project = (await loadProjects()).find((x) => x.root === root);
	return { id: project?.id ?? null };
}

export async function previewRegistration(p: string, port?: number) {
	const root = path.resolve(expandHome(p));
	return previewProject(root, port, await takenPorts(root));
}

/** Moves the project's web service to a free port (see reassign.ts). */
export async function reassignPort(id: string) {
	return reassignPortIn(await getValidProject(id));
}

/** What "Set up Magic Login" would write (nothing is changed). */
export async function planMagicLoginSetup(id: string) {
	const { planMagicLogin } = await import("./magic-setup");
	return planMagicLogin(await getValidProject(id));
}

/** Writes the Magic Login setup planned above, with the reviewed personas. */
export async function applyMagicLoginSetup(id: string, personas: Persona[]) {
	const { applyMagicLogin } = await import("./magic-setup");
	return applyMagicLogin(await getValidProject(id), personas);
}

export async function unregisterProject(id: string) {
	const project = await getProject(id);
	await removeProjectRoot(project.root);
}

export { killPort };

export async function settings() {
	const [config, projects, pem, envValue] = await Promise.all([
		readHubConfig(),
		loadProjects(),
		publicKeyPem(),
		publicKeyEnvValue(),
	]);
	return {
		hubHome: tildify(hubHome()),
		configPath: tildify(hubPaths.config()),
		editor: config.editor,
		scanDirs: config.scanDirs,
		proxyPort: proxyPortInUse(),
		configuredProxyPort: config.proxyPort,
		stopProcessesOnExit: config.stopProcessesOnExit,
		projects: projects.map((p) => ({
			id: p.id,
			root: p.root,
			rootDisplay: tildify(p.root),
			ok: p.ok,
			error: p.ok ? undefined : p.error,
			// Only explicit entries can be removed; scanned ones come from scanDirs.
			explicit: config.projects.some(
				(c) => path.resolve(expandHome(c)) === p.root,
			),
		})),
		publicKeyPem: pem,
		publicKeyEnv: envValue,
	};
}
