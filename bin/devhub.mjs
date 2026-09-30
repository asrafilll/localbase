#!/usr/bin/env node
/**
 * devhub - Local Dev Hub from the terminal.
 * Talks to a running hub over its REST API (DEVHUB_URL, default http://127.0.0.1:6969).
 */
import { spawn } from "node:child_process";
import {
	api,
	followRun,
	HUB_URL,
	HubError,
	resolveProject,
} from "./lib/client.mjs";

const HELP = `devhub - Local Dev Hub CLI

Usage: devhub <command> [args] [--json]

  status                        all projects (default command)
  ports [--all]                 listening ports and who owns them
  info [project]                services, personas, commands of a project
  start [project] [--kill|--force] [-f]
                                start; --kill stops processes holding its ports,
                                --force starts anyway, -f follows the output
  stop [project]                stop
  restart [project] [-f]        restart
  run [project] <command>       run a command from .dev/project.yaml and stream it
  logs [project|run-id] [-f]    last output of a run (-f to follow)
  open [project] [service]      open the app (or a service) in the browser
  login [project] <persona> [--print]
                                Magic Login: open the app signed in as a persona
  scenario [project] <scenario> load a scenario, then log in
  snapshot [project] save|restore|delete <name>
  kill-port <port>              free a port

[project] may be an id, a name or a unique prefix. Omit it inside a
registered repository to use that project.
`;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = paint(2);
const bold = paint(1);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const cyan = paint(36);

const statusDot = {
	running: green("●"),
	partial: yellow("◐"),
	stopped: dim("○"),
	unknown: dim("·"),
	invalid: red("✕"),
	error: red("●"),
};

function parseArgs(argv) {
	const flags = new Set();
	const args = [];
	for (const a of argv) {
		if (a.startsWith("-")) flags.add(a.replace(/^-+/, ""));
		else args.push(a);
	}
	return { args, flags };
}

// Built from a string so the escape character stays out of a regex literal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function table(rows) {
	const strip = (s) => String(s).replace(ANSI, "");
	const widths = [];
	for (const row of rows)
		row.forEach((cell, i) => {
			widths[i] = Math.max(widths[i] ?? 0, strip(cell).length);
		});
	for (const row of rows)
		console.log(
			row
				.map((cell, i) =>
					i === row.length - 1
						? cell
						: `${cell}${" ".repeat(widths[i] - strip(cell).length)}`,
				)
				.join("  ")
				.trimEnd(),
		);
}

function openInBrowser(url) {
	const cmd =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "explorer"
				: "xdg-open";
	spawn(cmd, [url], { stdio: "ignore", detached: true })
		.on("error", () => console.log(url))
		.unref();
}

const fmtUsage = (u) =>
	u ? `${u.cpu.toFixed(1)}% ${Math.round(u.memoryMb)}MB` : "";

/** First positional arg is a project unless only `need` args were given. */
async function projectAndRest(args, need) {
	if (args.length > need)
		return { project: await resolveProject(args[0]), rest: args.slice(1) };
	return { project: await resolveProject(undefined), rest: args };
}

async function streamRun(run, { json }) {
	if (json) return run;
	const final = await followRun(run.id, (line) => console.log(line));
	return final;
}

async function main() {
	const { args, flags } = parseArgs(process.argv.slice(2));
	const json = flags.has("json");
	const cmd = args.shift() ?? "status";
	const out = (data, human) =>
		json ? console.log(JSON.stringify(data, null, 2)) : human(data);

	switch (cmd) {
		case "help":
		case "--help":
			console.log(HELP);
			return;

		case "status": {
			const data = await api("GET", "overview");
			return out(data, ({ projects, unknownPorts }) => {
				if (!projects.length)
					console.log(
						dim(`No projects registered. Add one at ${HUB_URL}/settings`),
					);
				table(
					projects.map((p) => [
						`${statusDot[p.status] ?? "·"} ${bold(p.name)}`,
						dim(p.id),
						p.mainUrl ? cyan(p.mainUrl.replace(/^https?:\/\//, "")) : "",
						p.git ? dim(p.git.branch) : "",
						dim(fmtUsage(p.usage)),
						p.envMissing ? yellow(`⚠ ${p.envMissing} env`) : "",
					]),
				);
				const unknown = unknownPorts.filter((p) => !p.system);
				if (unknown.length)
					console.log(
						dim(
							`\n${unknown.length} unknown service(s): ${unknown.map((p) => `:${p.port} ${p.process}`).join(", ")}`,
						),
					);
			});
		}

		case "ports": {
			const data = await api("GET", "ports");
			return out(data, ({ ports }) =>
				table(
					ports
						.filter((p) => flags.has("all") || !p.system)
						.map((p) => [
							bold(`:${p.port}`),
							p.container
								? `🐳 ${p.container}`
								: `${p.type ?? p.process} ${dim(`pid ${p.pid}`)}`,
							p.projectName
								? green(
										p.projectName + (p.serviceKey ? `/${p.serviceKey}` : ""),
									)
								: p.isHub
									? dim("(hub)")
									: yellow("unknown"),
							dim(p.cwd ?? ""),
						]),
				),
			);
		}

		case "info": {
			const { project } = await projectAndRest(args, 0);
			const d = await api("GET", `projects/${project.id}`);
			return out(d, () => {
				console.log(
					`${statusDot[d.status] ?? ""} ${bold(d.name)} ${dim(d.rootDisplay)}`,
				);
				if (d.git)
					console.log(
						dim(
							`branch ${d.git.branch}${d.git.changes ? `, ${d.git.changes} changed` : ""}`,
						),
					);
				if (d.proxyUrl) console.log(`url    ${cyan(d.proxyUrl)}`);
				console.log(bold("\nservices"));
				table(
					d.services.map((s) => [
						`  ${statusDot[s.status] ?? ""} ${s.label}`,
						s.url ?? (s.port ? `:${s.port}` : ""),
						dim(s.detail ?? ""),
					]),
				);
				if (d.personas.length) {
					console.log(bold("\npersonas"));
					table(d.personas.map((p) => [`  ${p.key}`, p.label, dim(p.user)]));
				}
				if (d.commands.length) {
					console.log(
						bold(
							`\ncommands${d.trusted ? "" : yellow("  (not trusted yet: review them in the dashboard)")}`,
						),
					);
					table(d.commands.map((c) => [`  ${c.key}`, dim(c.command)]));
				}
				if (d.scenarios.length) {
					console.log(bold("\nscenarios"));
					table(d.scenarios.map((s) => [`  ${s.key}`, s.label]));
				}
			});
		}

		case "start": {
			const { project } = await projectAndRest(args, 0);
			const res = await api("POST", `projects/${project.id}/start`, {
				force: flags.has("force"),
				killConflicts: flags.has("kill"),
			});
			if (!res.ok) {
				if (json) return out(res);
				console.error(red(`${project.name}: port(s) already in use:`));
				for (const c of res.conflicts)
					console.error(
						`  :${c.port}  ${c.container ? `container ${c.container}` : `${c.process} (pid ${c.pid})`}${c.projectName ? ` from ${c.projectName}` : c.cwd ? ` in ${c.cwd}` : ""}`,
					);
				console.error(
					dim(
						"Re-run with --kill to stop them first, or --force to start anyway.",
					),
				);
				process.exitCode = 1;
				return;
			}
			if (json) return out(res);
			console.log(
				green(`Started ${project.name}`) + dim(` (run ${res.run.id})`),
			);
			if (flags.has("f")) await streamRun(res.run, { json });
			return;
		}

		case "stop": {
			const { project } = await projectAndRest(args, 0);
			await api("POST", `projects/${project.id}/stop`, {});
			return out({ ok: true }, () => console.log(`Stopped ${project.name}`));
		}

		case "restart": {
			const { project } = await projectAndRest(args, 0);
			const run = await api("POST", `projects/${project.id}/restart`, {});
			if (json) return out(run);
			console.log(green(`Restarted ${project.name}`) + dim(` (run ${run.id})`));
			if (flags.has("f")) await streamRun(run, { json });
			return;
		}

		case "run": {
			const { project, rest } = await projectAndRest(args, 1);
			if (!rest[0]) throw new HubError("Usage: devhub run [project] <command>");
			const run = await api(
				"POST",
				`projects/${project.id}/commands/${encodeURIComponent(rest[0])}`,
				{},
			);
			if (json) return out(run);
			const final = await streamRun(run, { json });
			if (final && final.status !== "succeeded")
				process.exitCode = final.exitCode || 1;
			return;
		}

		case "logs": {
			let runId = args[0];
			if (!runId || !/^[0-9a-f-]{36}$/.test(runId)) {
				const project = await resolveProject(args[0]);
				const d = await api("GET", `projects/${project.id}`);
				runId = d.runs[0]?.id;
				if (!runId) throw new HubError(`${project.name} has no runs yet`);
			}
			if (flags.has("f") && !json) {
				await followRun(runId, (line) => console.log(line));
				return;
			}
			const info = await api("GET", `runs/${runId}?tail=200`);
			return out(info, ({ run, lines }) => {
				console.log(
					dim(
						`# ${run.commandKey}: ${run.status}${run.exitCode !== null ? ` (exit ${run.exitCode})` : ""}`,
					),
				);
				for (const l of lines) console.log(l);
			});
		}

		case "open": {
			const { project, rest } = await projectAndRest(
				args,
				args.length >= 2 ? 1 : 0,
			);
			const service = rest[0]
				? project.services.find(
						(s) =>
							s.key === rest[0] ||
							s.label.toLowerCase() === rest[0].toLowerCase(),
					)
				: null;
			if (rest[0] && !service)
				throw new HubError(`${project.name} has no service "${rest[0]}"`);
			const url = service?.url ?? project.mainUrl;
			if (!url) throw new HubError(`${project.name} has no URL`);
			if (json) return out({ url });
			openInBrowser(url);
			console.log(url);
			return;
		}

		case "login": {
			const { project, rest } = await projectAndRest(args, 1);
			if (!rest[0])
				throw new HubError(
					`Usage: devhub login [project] <persona>  (${project.personas.map((p) => p.key).join(", ")})`,
				);
			const persona = project.personas.find(
				(p) =>
					p.key === rest[0] || p.label.toLowerCase() === rest[0].toLowerCase(),
			);
			const { url } = await api("POST", `projects/${project.id}/login`, {
				persona: persona?.key ?? rest[0],
			});
			if (json || flags.has("print"))
				return out({ url }, () => console.log(url));
			openInBrowser(url);
			console.log(
				`Opening ${project.name} as ${persona?.label ?? rest[0]} (link valid for 60s)`,
			);
			return;
		}

		case "scenario": {
			const { project, rest } = await projectAndRest(args, 1);
			if (!rest[0])
				throw new HubError("Usage: devhub scenario [project] <scenario>");
			if (!json) console.log(dim(`Preparing ${rest[0]}…`));
			const { url } = await api(
				"POST",
				`projects/${project.id}/scenarios/${encodeURIComponent(rest[0])}`,
				{},
			);
			if (json || flags.has("print"))
				return out({ url }, () => console.log(url ?? "ready"));
			if (url) openInBrowser(url);
			console.log(
				green(`Scenario ${rest[0]} ready`) + (url ? " — logging in" : ""),
			);
			return;
		}

		case "snapshot": {
			const { project, rest } = await projectAndRest(args, 2);
			const [action, name] = rest;
			if (!["save", "restore", "delete"].includes(action) || !name)
				throw new HubError(
					"Usage: devhub snapshot [project] save|restore|delete <name>",
				);
			const res = await api("POST", `projects/${project.id}/snapshots`, {
				action,
				name,
			});
			return out(res, () => console.log(green(`${action} ${name}: done`)));
		}

		case "kill-port": {
			const port = Number(args[0]);
			if (!Number.isInteger(port))
				throw new HubError("Usage: devhub kill-port <port>");
			const res = await api("POST", `ports/${port}/kill`, {});
			return out(res, ({ stopped }) =>
				console.log(`Freed :${port} (stopped ${stopped.join(", ")})`),
			);
		}

		default:
			console.error(`Unknown command "${cmd}"\n`);
			console.log(HELP);
			process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(
		red(err instanceof HubError ? err.message : (err.stack ?? String(err))),
	);
	process.exitCode = 1;
});
