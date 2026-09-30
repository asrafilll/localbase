import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { isInside } from "./paths";
import type { LoadedProject } from "./registry";

export type RunStatus = "running" | "succeeded" | "failed" | "stopped";

export type Run = {
	id: string;
	projectId: string;
	commandKey: string;
	command: string;
	cwd: string;
	longRunning: boolean;
	pid?: number;
	status: RunStatus;
	exitCode: number | null;
	startedAt: number;
	endedAt?: number;
	lines: string[];
};

type RunState = Run & { child?: ChildProcess; events: EventEmitter };

const MAX_LINES = 5000;
const MAX_RUNS = 100;

// Kept on globalThis so runs survive Vite hot reloads of this module in dev.
const store = globalThis as typeof globalThis & {
	__devhubRuns?: Map<string, RunState>;
	__devhubShellEnv?: Promise<NodeJS.ProcessEnv>;
	__devhubExitHook?: boolean;
};
store.__devhubRuns ??= new Map();
const runs = store.__devhubRuns;

/**
 * GUI/launchd processes on macOS don't load ~/.zshrc, so `node`, `pnpm`, nvm and
 * friends are missing from PATH. Capture the environment of an interactive login
 * shell once and reuse it for every command.
 */
/**
 * The hub's own server settings must not leak into project commands: an
 * inherited PORT makes dev servers collide with the hub, and NODE_ENV=production
 * would switch apps (and their Magic Login endpoint) out of development mode.
 */
export function withoutHubEnv(env: NodeJS.ProcessEnv) {
	const clean: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (
			/^(PORT|HOST|NODE_ENV|NITRO_.*|VITE_.*|npm_.*|PNPM_.*|INIT_CWD)$/.test(
				key,
			)
		)
			continue;
		clean[key] = value;
	}
	return clean;
}

export function shellEnv() {
	store.__devhubShellEnv ??= new Promise((resolve) => {
		const shell = process.env.SHELL || "/bin/zsh";
		const marker = "__DEVHUB_ENV__";
		execFile(
			shell,
			["-ilc", `echo ${marker}; env; echo ${marker}`],
			{
				timeout: 5000,
				env: { ...withoutHubEnv(process.env), DISABLE_AUTO_UPDATE: "true" },
			},
			(_err, stdout) => {
				const section = stdout?.split(marker)[1];
				if (!section) return resolve(withoutHubEnv(process.env));
				const env: NodeJS.ProcessEnv = {};
				for (const line of section.split("\n")) {
					const eq = line.indexOf("=");
					if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
				}
				// The shell started from a clean env, so anything it exports is the user's own.
				resolve({ ...withoutHubEnv(process.env), ...env });
			},
		);
	});
	return store.__devhubShellEnv;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
	if (!child.pid) return;
	try {
		// Negative pid = the whole process group (dev servers spawn children).
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

if (!store.__devhubExitHook) {
	store.__devhubExitHook = true;
	// Don't leave orphaned dev servers holding ports when the hub quits.
	const stopAll = () => {
		for (const run of runs.values())
			if (run.child && run.status === "running")
				killGroup(run.child, "SIGTERM");
	};
	process.once("exit", stopAll);
	// A signal kills Node without firing "exit" (launchd and Ctrl-C both send one).
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.once(signal, () => {
			stopAll();
			// Keep the default "terminate" behaviour unless the server has its own handler.
			if (process.listenerCount(signal) === 0)
				process.kill(process.pid, signal);
		});
	}
}

// Strip ANSI color/cursor codes so logs render as plain text.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
	`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\][^${BEL}]*${BEL}`,
	"g",
);

function publicRun(r: RunState): Run {
	const { child: _child, events: _events, ...rest } = r;
	return { ...rest, lines: [] };
}

function append(run: RunState, text: string) {
	for (const line of text.replace(ANSI, "").split(/\r?\n/)) {
		if (line === "") continue;
		run.lines.push(line);
		run.events.emit("line", line);
	}
	if (run.lines.length > MAX_LINES)
		run.lines.splice(0, run.lines.length - MAX_LINES);
}

function prune() {
	const finished = [...runs.values()].filter((r) => r.status !== "running");
	for (const r of finished.slice(0, Math.max(0, runs.size - MAX_RUNS)))
		runs.delete(r.id);
}

export function resolveCommand(
	project: Extract<LoadedProject, { ok: true }>,
	key: string,
) {
	const cmd = project.config.commands?.[key];
	if (!cmd) throw new Error(`${project.id} has no "${key}" command`);
	const cwd = path.resolve(project.root, cmd.cwd ?? ".");
	if (!isInside(cwd, project.root))
		throw new Error(`cwd of "${key}" escapes the repository`);
	return { ...cmd, cwd };
}

export async function startRun(
	project: Extract<LoadedProject, { ok: true }>,
	key: string,
) {
	const cmd = resolveCommand(project, key);
	const active = [...runs.values()].find(
		(r) =>
			r.projectId === project.id &&
			r.commandKey === key &&
			r.status === "running",
	);
	if (active) return publicRun(active);

	const env = await shellEnv();
	const child = spawn(env.SHELL || "/bin/sh", ["-c", cmd.command], {
		cwd: cmd.cwd,
		env: { ...env, FORCE_COLOR: "0", DEVHUB: "1" },
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const run: RunState = {
		id: randomUUID(),
		projectId: project.id,
		commandKey: key,
		command: cmd.command,
		cwd: cmd.cwd,
		longRunning: Boolean(cmd.longRunning),
		pid: child.pid,
		status: "running",
		exitCode: null,
		startedAt: Date.now(),
		lines: [],
		child,
		events: new EventEmitter(),
	};
	runs.set(run.id, run);
	append(run, `$ ${cmd.command}`);
	child.stdout?.on("data", (d: Buffer) => append(run, d.toString()));
	child.stderr?.on("data", (d: Buffer) => append(run, d.toString()));
	child.on("error", (err) => append(run, `[devhub] ${err.message}`));
	child.on("close", (code, signal) => {
		if (run.status === "running")
			run.status = code === 0 ? "succeeded" : "failed";
		run.exitCode = code;
		run.endedAt = Date.now();
		run.child = undefined;
		append(run, `[devhub] exited with ${signal ?? `code ${code}`}`);
		run.events.emit("end", publicRun(run));
		prune();
	});
	return publicRun(run);
}

export function stopRun(id: string) {
	const run = runs.get(id);
	if (!run?.child || run.status !== "running") return;
	run.status = "stopped";
	const child = run.child;
	killGroup(child, "SIGTERM");
	setTimeout(() => {
		if (run.child === child) killGroup(child, "SIGKILL");
	}, 5000).unref();
}

export function waitForRun(id: string, timeoutMs = 5 * 60_000) {
	const run = runs.get(id);
	if (!run) return Promise.reject(new Error("Unknown run"));
	if (run.status !== "running") return Promise.resolve(publicRun(run));
	return new Promise<Run>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Timed out waiting for command")),
			timeoutMs,
		);
		run.events.once("end", (r: Run) => {
			clearTimeout(timer);
			resolve(r);
		});
	});
}

export function listRuns(projectId?: string) {
	return [...runs.values()]
		.filter((r) => !projectId || r.projectId === projectId)
		.sort((a, b) => b.startedAt - a.startedAt)
		.map(publicRun);
}

/** Hub-owned processes still running for a project (started with `longRunning`). */
export function activeRuns(projectId: string) {
	return [...runs.values()].filter(
		(r) => r.projectId === projectId && r.status === "running",
	);
}

/** Replays buffered lines, then streams new ones. Returns an unsubscribe fn. */
export function subscribeRun(
	id: string,
	onLine: (line: string) => void,
	onEnd: (run: Run) => void,
) {
	const run = runs.get(id);
	if (!run) return null;
	for (const line of run.lines) onLine(line);
	if (run.status !== "running") {
		onEnd(publicRun(run));
		return () => {};
	}
	run.events.on("line", onLine);
	run.events.once("end", onEnd);
	return () => {
		run.events.off("line", onLine);
		run.events.off("end", onEnd);
	};
}
