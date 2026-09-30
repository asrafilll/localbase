#!/usr/bin/env node
/**
 * Local Dev Hub MCP server (stdio). Lets AI coding agents ask the hub which
 * port a project runs on, start/stop it, run its commands, read logs and get
 * Magic Login URLs.
 *
 *   claude mcp add devhub -- node /path/to/localbase/bin/devhub-mcp.mjs
 *
 * It only talks to the hub's REST API (DEVHUB_URL, default http://127.0.0.1:6969),
 * so the hub's rules apply: commands run only after a human trusted them in
 * the dashboard, and there is deliberately no tool to grant that trust.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { api, followRun, resolveProject } from "./lib/client.mjs";

const server = new McpServer({ name: "local-dev-hub", version: "0.2.0" });

const text = (data) => ({
	content: [
		{
			type: "text",
			text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
		},
	],
});

/** Wraps a handler so hub errors come back as tool errors, not crashes. */
const tool = (fn) => async (args) => {
	try {
		return text(await fn(args ?? {}));
	} catch (err) {
		return {
			...text(err instanceof Error ? err.message : String(err)),
			isError: true,
		};
	}
};

const projectArg = z
	.string()
	.optional()
	.describe(
		"Project id, name or unique prefix. Omit to use the project containing the agent's working directory.",
	);

const summarize = (p) => ({
	id: p.id,
	name: p.name,
	status: p.status,
	url: p.mainUrl,
	stableUrl: p.proxyUrl,
	repo: p.root,
	branch: p.git?.branch,
	services: p.services.map((s) => ({
		key: s.key,
		label: s.label,
		status: s.status,
		url: s.url,
		port: s.port,
		detail: s.detail,
	})),
	personas: p.personas.map((x) => x.key),
	commands: p.commandKeys,
	usage: p.usage,
	envMissing: p.envMissing,
});

const readOnly = { readOnlyHint: true, openWorldHint: false };

server.registerTool(
	"list_projects",
	{
		title: "List local projects",
		description:
			"All projects registered in Local Dev Hub with status, URLs, ports, branch and resource usage. Also lists unknown services listening on this machine.",
		annotations: readOnly,
	},
	tool(async () => {
		const o = await api("GET", "overview");
		return {
			projects: o.projects.map(summarize),
			unknownServices: o.unknownPorts
				.filter((p) => !p.system)
				.map((p) => ({
					port: p.port,
					process: p.type ?? p.process,
					pid: p.pid,
					cwd: p.cwd,
				})),
		};
	}),
);

server.registerTool(
	"get_project",
	{
		title: "Project details",
		description:
			"Services (with status and ports), personas, commands, scenarios, .env problems, database and recent runs of one project.",
		inputSchema: { project: projectArg },
		annotations: readOnly,
	},
	tool(async ({ project }) => {
		const p = await resolveProject(project);
		const d = await api("GET", `projects/${p.id}`);
		return {
			...summarize(d),
			commands: d.commands,
			commandsTrusted: d.trusted,
			scenarios: d.scenarios,
			env: d.env,
			database: d.database,
			snapshots: d.snapshots.map((s) => s.name),
			recentRuns: d.runs.slice(0, 10).map((r) => ({
				id: r.id,
				command: r.commandKey,
				status: r.status,
				exitCode: r.exitCode,
			})),
		};
	}),
);

server.registerTool(
	"list_ports",
	{
		title: "Who is using which port",
		description:
			"Every TCP port listening on this machine with its process, working directory and owning project.",
		inputSchema: {
			port: z.number().int().optional().describe("Only this port"),
			include_system: z
				.boolean()
				.optional()
				.describe("Include OS/background processes"),
		},
		annotations: readOnly,
	},
	tool(async ({ port, include_system }) => {
		const { ports } = await api("GET", "ports");
		return ports
			.filter((p) => (port ? p.port === port : include_system || !p.system))
			.map((p) => ({
				port: p.port,
				process: p.type ?? p.process,
				pid: p.pid,
				cwd: p.cwd,
				container: p.container,
				project: p.projectId,
				service: p.serviceKey,
			}));
	}),
);

server.registerTool(
	"start_project",
	{
		title: "Start a project",
		description:
			"Runs the project's `start` command. If other processes hold its ports, returns them instead of starting unless kill_conflicts is true.",
		inputSchema: {
			project: projectArg,
			kill_conflicts: z
				.boolean()
				.optional()
				.describe("Stop processes holding the project's ports first"),
		},
	},
	tool(async ({ project, kill_conflicts }) => {
		const p = await resolveProject(project);
		return api("POST", `projects/${p.id}/start`, {
			killConflicts: Boolean(kill_conflicts),
		});
	}),
);

server.registerTool(
	"stop_project",
	{
		title: "Stop a project",
		description:
			"Stops the project's processes (and runs its `stop` command if it has one).",
		inputSchema: { project: projectArg },
	},
	tool(async ({ project }) => {
		const p = await resolveProject(project);
		await api("POST", `projects/${p.id}/stop`, {});
		return `Stopped ${p.name}`;
	}),
);

server.registerTool(
	"restart_project",
	{
		title: "Restart a project",
		description: "Stop, then start.",
		inputSchema: { project: projectArg },
	},
	tool(async ({ project }) => {
		const p = await resolveProject(project);
		return api("POST", `projects/${p.id}/restart`, {});
	}),
);

server.registerTool(
	"run_command",
	{
		title: "Run a project command",
		description:
			"Runs a command defined in the project's .dev/project.yaml (e.g. test, seed, migrate) and waits for it, returning status and the last lines of output. Long-running commands return after the timeout while they keep running.",
		inputSchema: {
			project: projectArg,
			command: z.string().describe("Command key from .dev/project.yaml"),
			timeout_seconds: z
				.number()
				.int()
				.min(1)
				.max(600)
				.optional()
				.describe("Default 120"),
			lines: z
				.number()
				.int()
				.min(1)
				.max(1000)
				.optional()
				.describe("Output lines to return (default 100)"),
		},
	},
	tool(async ({ project, command, timeout_seconds, lines }) => {
		const p = await resolveProject(project);
		const run = await api(
			"POST",
			`projects/${p.id}/commands/${encodeURIComponent(command)}`,
			{},
		);
		const abort = new AbortController();
		const timer = setTimeout(
			() => abort.abort(),
			(timeout_seconds ?? 120) * 1000,
		);
		const final = await followRun(run.id, () => {}, abort.signal).catch(
			() => null,
		);
		clearTimeout(timer);
		const info = await api("GET", `runs/${run.id}?tail=${lines ?? 100}`);
		return {
			runId: run.id,
			status: info.run.status,
			exitCode: info.run.exitCode,
			finished: Boolean(final),
			output: info.lines.join("\n"),
		};
	}),
);

server.registerTool(
	"get_logs",
	{
		title: "Read command output",
		description:
			"Last lines of a run's output. Give run_id, or a project to read its most recent run (optionally of a given command).",
		inputSchema: {
			project: projectArg,
			run_id: z.string().optional(),
			command: z
				.string()
				.optional()
				.describe("Most recent run of this command key"),
			lines: z
				.number()
				.int()
				.min(1)
				.max(2000)
				.optional()
				.describe("Default 150"),
		},
		annotations: readOnly,
	},
	tool(async ({ project, run_id, command, lines }) => {
		let id = run_id;
		if (!id) {
			const p = await resolveProject(project);
			const d = await api("GET", `projects/${p.id}`);
			id = d.runs.find((r) => !command || r.commandKey === command)?.id;
			if (!id)
				throw new Error(
					`${p.name} has no ${command ? `"${command}" ` : ""}runs yet`,
				);
		}
		const info = await api("GET", `runs/${id}?tail=${lines ?? 150}`);
		return {
			run: {
				id,
				command: info.run.commandKey,
				status: info.run.status,
				exitCode: info.run.exitCode,
			},
			output: info.lines.join("\n"),
		};
	}),
);

server.registerTool(
	"magic_login_url",
	{
		title: "Magic Login URL",
		description:
			"A one-time URL (valid 60s) that signs into the local app as a development persona. Open it in a browser (e.g. with a browser automation tool) to test as that user.",
		inputSchema: {
			project: projectArg,
			persona: z.string().describe("Persona key, e.g. admin or member"),
		},
	},
	tool(async ({ project, persona }) => {
		const p = await resolveProject(project);
		return api("POST", `projects/${p.id}/login`, { persona });
	}),
);

server.registerTool(
	"load_scenario",
	{
		title: "Load a scenario",
		description:
			"Prepares a development scenario (restores its snapshot and/or runs its seed), then returns a Magic Login URL for its persona.",
		inputSchema: { project: projectArg, scenario: z.string() },
		annotations: { destructiveHint: true },
	},
	tool(async ({ project, scenario }) => {
		const p = await resolveProject(project);
		return api(
			"POST",
			`projects/${p.id}/scenarios/${encodeURIComponent(scenario)}`,
			{},
		);
	}),
);

server.registerTool(
	"database_snapshot",
	{
		title: "Save or restore a database snapshot",
		description:
			"save: dump the project's dev database under a name. restore: replace the database with that snapshot (destructive). delete: remove a snapshot.",
		inputSchema: {
			project: projectArg,
			action: z.enum(["save", "restore", "delete"]),
			name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
		},
		annotations: { destructiveHint: true },
	},
	tool(async ({ project, action, name }) => {
		const p = await resolveProject(project);
		await api("POST", `projects/${p.id}/snapshots`, { action, name });
		return `${action} ${name}: done`;
	}),
);

server.registerTool(
	"kill_port",
	{
		title: "Free a port",
		description:
			"Stops whatever listens on a port (the Docker container publishing it, or the process). Never touches the hub or Docker itself.",
		inputSchema: { port: z.number().int().min(1).max(65535) },
		annotations: { destructiveHint: true },
	},
	tool(({ port }) => api("POST", `ports/${port}/kill`, {})),
);

await server.connect(new StdioServerTransport());
