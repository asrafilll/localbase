import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import * as actions from "#/server/actions";
import { allPorts, overview, projectDetail } from "#/server/status";

/**
 * The dashboard's RPC surface. Handlers run on the server only; TanStack Start
 * replaces them with fetch calls in the client bundle. The logic lives in
 * server/actions.ts so the REST API, CLI and MCP server behave identically.
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

export const getSettings = createServerFn({ method: "GET" }).handler(() =>
	actions.settings(),
);

export const previewRegistration = createServerFn({ method: "POST" })
	.validator(
		z.object({ path: z.string().min(1), port: z.number().int().optional() }),
	)
	.handler(({ data }) => actions.previewRegistration(data.path, data.port));

export const registerProject = createServerFn({ method: "POST" })
	.validator(
		z.object({
			path: z.string().min(1),
			port: z.number().int().optional(),
			yaml: z.string().optional(),
		}),
	)
	.handler(({ data }) =>
		actions.registerProject(data.path, data.port, data.yaml),
	);

export const unregisterProject = createServerFn({ method: "POST" })
	.validator(projectInput)
	.handler(({ data }) => actions.unregisterProject(data.id));

export const trustProject = createServerFn({ method: "POST" })
	.validator(projectInput)
	.handler(({ data }) => actions.trustProject(data.id));

export const runCommand = createServerFn({ method: "POST" })
	.validator(z.object({ id: z.string(), key: z.string() }))
	.handler(({ data }) => actions.runCommand(data.id, data.key));

export const stopCommandRun = createServerFn({ method: "POST" })
	.validator(z.object({ runId: z.string() }))
	.handler(({ data }) => actions.stopCommandRun(data.runId));

export const startProject = createServerFn({ method: "POST" })
	.validator(
		z.object({
			id: z.string(),
			force: z.boolean().optional(),
			killConflicts: z.boolean().optional(),
		}),
	)
	.handler(({ data }) =>
		actions.startProject(data.id, {
			force: data.force,
			killConflicts: data.killConflicts,
		}),
	);

export const stopProject = createServerFn({ method: "POST" })
	.validator(projectInput)
	.handler(({ data }) => actions.stopProject(data.id));

export const restartProject = createServerFn({ method: "POST" })
	.validator(projectInput)
	.handler(({ data }) => actions.restartProject(data.id));

export const openRepo = createServerFn({ method: "POST" })
	.validator(
		z.object({
			id: z.string(),
			target: z.enum(["editor", "finder", "terminal"]),
		}),
	)
	.handler(({ data }) => actions.openRepo(data.id, data.target));

export const magicLogin = createServerFn({ method: "POST" })
	.validator(z.object({ id: z.string(), persona: z.string() }))
	.handler(async ({ data }) => ({
		url: await actions.magicLoginUrl(data.id, data.persona),
	}));

export const loadScenario = createServerFn({ method: "POST" })
	.validator(z.object({ id: z.string(), scenario: z.string() }))
	.handler(({ data }) => actions.loadScenario(data.id, data.scenario));

export const killPort = createServerFn({ method: "POST" })
	.validator(z.object({ port: z.number().int().min(1).max(65535) }))
	.handler(({ data }) => actions.killPort(data.port));

export const snapshotAction = createServerFn({ method: "POST" })
	.validator(
		z.object({
			id: z.string(),
			action: z.enum(["save", "restore", "delete"]),
			name: z.string().min(1),
		}),
	)
	.handler(async ({ data }) => {
		await actions.snapshotAction(data.id, data.action, data.name);
	});
