import path from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	createMagicLoginUrl,
	publicKeyEnvValue,
	publicKeyPem,
} from "#/server/magic-login";
import { openPath } from "#/server/open";
import { expandHome, hubHome, hubPaths, tildify } from "#/server/paths";
import {
	getProject,
	getValidProject,
	loadProjects,
	readHubConfig,
	removeProjectRoot,
	scaffoldProject,
} from "#/server/registry";
import { activeRuns, startRun, stopRun, waitForRun } from "#/server/runner";
import { allPorts, overview, projectDetail } from "#/server/status";
import { isTrusted, trust } from "#/server/trust";

/**
 * The hub's RPC surface. Handlers run on the server only; TanStack Start
 * replaces them with fetch calls in the client bundle.
 */

const projectInput = z.object({ id: z.string() });

export const getOverview = createServerFn({ method: "GET" }).handler(() =>
	overview(),
);

export const getPorts = createServerFn({ method: "GET" }).handler(() =>
	allPorts(),
);

export const getProjectDetail = createServerFn({ method: "GET" })
	.validator(projectInput)
	.handler(({ data }) => projectDetail(data.id));

export const getSettings = createServerFn({ method: "GET" }).handler(
	async () => {
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
	},
);

export const registerProject = createServerFn({ method: "POST" })
	.validator(
		z.object({ path: z.string().min(1), port: z.number().int().optional() }),
	)
	.handler(async ({ data }) => {
		const root = await scaffoldProject(expandHome(data.path), data.port);
		const project = (await loadProjects()).find((p) => p.root === root);
		return { id: project?.id ?? null };
	});

export const unregisterProject = createServerFn({ method: "POST" })
	.validator(projectInput)
	.handler(async ({ data }) => {
		const project = await getProject(data.id);
		await removeProjectRoot(project.root);
	});

export const trustProject = createServerFn({ method: "POST" })
	.validator(projectInput)
	.handler(async ({ data }) => {
		const project = await getValidProject(data.id);
		await trust(project.root, project.config);
	});

async function trustedProject(id: string) {
	const project = await getValidProject(id);
	if (!(await isTrusted(project.root, project.config))) {
		throw new Error(
			"Review and trust this project's commands before running them.",
		);
	}
	return project;
}

export const runCommand = createServerFn({ method: "POST" })
	.validator(z.object({ id: z.string(), key: z.string() }))
	.handler(async ({ data }) =>
		startRun(await trustedProject(data.id), data.key),
	);

export const stopCommandRun = createServerFn({ method: "POST" })
	.validator(z.object({ runId: z.string() }))
	.handler(({ data }) => stopRun(data.runId));

export const startProject = createServerFn({ method: "POST" })
	.validator(projectInput)
	.handler(async ({ data }) =>
		startRun(await trustedProject(data.id), "start"),
	);

async function stop(id: string) {
	const project = await trustedProject(id);
	// Hub-owned long-running processes are always killed; a `stop` command
	// additionally handles anything started elsewhere (e.g. docker compose down).
	for (const run of activeRuns(id)) stopRun(run.id);
	if (project.config.commands?.stop) {
		const run = await startRun(project, "stop");
		await waitForRun(run.id);
	}
	return project;
}

export const stopProject = createServerFn({ method: "POST" })
	.validator(projectInput)
	.handler(async ({ data }) => {
		await stop(data.id);
	});

export const restartProject = createServerFn({ method: "POST" })
	.validator(projectInput)
	.handler(async ({ data }) => {
		const project = await trustedProject(data.id);
		if (project.config.commands?.restart) return startRun(project, "restart");
		await stop(data.id);
		// Give killed dev servers a moment to release their ports.
		await new Promise((r) => setTimeout(r, 750));
		return startRun(project, "start");
	});

export const openRepo = createServerFn({ method: "POST" })
	.validator(
		z.object({
			id: z.string(),
			target: z.enum(["editor", "finder", "terminal"]),
		}),
	)
	.handler(async ({ data }) => {
		const project = await getProject(data.id);
		await openPath(project.root, data.target);
	});

export const magicLogin = createServerFn({ method: "POST" })
	.validator(z.object({ id: z.string(), persona: z.string() }))
	.handler(async ({ data }) => ({
		url: await createMagicLoginUrl(
			await getValidProject(data.id),
			data.persona,
		),
	}));

export const loadScenario = createServerFn({ method: "POST" })
	.validator(z.object({ id: z.string(), scenario: z.string() }))
	.handler(async ({ data }) => {
		const project = await getValidProject(data.id);
		const scenario = project.config.scenarios?.[data.scenario];
		if (!scenario) throw new Error(`Unknown scenario: ${data.scenario}`);
		if (scenario.seed) {
			await trustedProject(data.id);
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
	});
