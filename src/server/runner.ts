import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { run as execRun } from "./exec";
import { hubPaths, isInside } from "./paths";
import type { LoadedProject } from "./registry";
import { readHubConfig } from "./registry";

/**
 * Runs project commands and keeps track of them across hub restarts.
 *
 * Output goes to a log file per run instead of a pipe, so a dev server keeps
 * running (and logging) when the hub restarts or crashes. On boot the hub reads
 * runs.json and re-attaches ("adopts") every process group that is still alive.
 */

/** `exited` = ended while the hub wasn't its parent, so the exit code is unknown. */
export type RunStatus =
	| "running"
	| "succeeded"
	| "failed"
	| "stopped"
	| "exited";

export type Run = {
	id: string;
	projectId: string;
	commandKey: string;
	command: string;
	cwd: string;
	longRunning: boolean;
	/** Process group id (the spawned shell's pid). */
	pid?: number;
	status: RunStatus;
	exitCode: number | null;
	startedAt: number;
	endedAt?: number;
	/** True when this hub instance re-attached to a run started by a previous one. */
	adopted?: boolean;
};

type RunState = Run & {
	logFile: string;
	child?: ChildProcess;
	events: EventEmitter;
	/** Bytes of the log file already turned into lines. */
	offset: number;
	partial: string;
};

const MAX_RUNS = 100;
const MAX_REPLAY_BYTES = 512 * 1024;

// Kept on globalThis so runs survive Vite hot reloads of this module in dev.
const store = globalThis as typeof globalThis & {
	__devhubRuns?: Map<string, RunState>;
	__devhubShellEnv?: Promise<NodeJS.ProcessEnv>;
	__devhubRunnerBooted?: boolean;
	__devhubStopOnExit?: boolean;
};
store.__devhubRuns ??= new Map();
const runs = store.__devhubRuns;

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

/**
 * GUI/launchd processes on macOS don't load ~/.zshrc, so `node`, `pnpm`, nvm and
 * friends are missing from PATH. Capture the environment of an interactive login
 * shell once and reuse it for every command.
 */
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

// Strip ANSI color/cursor codes so logs render as plain text.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
	`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\][^${BEL}]*${BEL}`,
	"g",
);

export function toLines(text: string) {
	return text
		.replace(ANSI, "")
		.split(/\r?\n|\r/)
		.filter((l) => l !== "");
}

function publicRun(r: RunState): Run {
	const {
		child: _c,
		events: _e,
		offset: _o,
		partial: _p,
		logFile: _l,
		...rest
	} = r;
	return rest;
}

/** True while any process in the group is alive. */
function groupAlive(pgid: number) {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function killGroup(pgid: number, signal: NodeJS.Signals) {
	try {
		process.kill(-pgid, signal);
	} catch {
		try {
			process.kill(pgid, signal);
		} catch {
			// Already gone.
		}
	}
}

/** Parses ps `etime` ([[dd-]hh:]mm:ss) into seconds. */
export function parseEtime(etime: string) {
	const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
	if (!m) return null;
	const [, d, h, min, s] = m;
	return (
		Number(d ?? 0) * 86400 +
		Number(h ?? 0) * 3600 +
		Number(min) * 60 +
		Number(s)
	);
}

/**
 * Is the process group we recorded still the same one? A live group leader must
 * have started around `startedAt` (guards against pid reuse). A group whose
 * leader already exited can't be reused while members live, so it's ours.
 */
async function isSameRun(pid: number, startedAt: number) {
	if (!groupAlive(pid)) return false;
	const out = await execRun("ps", ["-o", "etime=", "-p", String(pid)]);
	if (!out?.trim()) return true;
	const seconds = parseEtime(out);
	if (seconds === null) return true;
	return Math.abs(Date.now() - seconds * 1000 - startedAt) < 15_000;
}

// ---------------------------------------------------------------- persistence

let saveTimer: NodeJS.Timeout | null = null;
function save() {
	if (saveTimer) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		const data = [...runs.values()].map((r) => ({
			...publicRun(r),
			adopted: undefined,
			logFile: r.logFile,
		}));
		try {
			fs.mkdirSync(path.dirname(hubPaths.runs()), { recursive: true });
			fs.writeFileSync(hubPaths.runs(), JSON.stringify(data, null, 2));
		} catch {
			// Best effort: persistence must never break running commands.
		}
	}, 100);
	saveTimer.unref();
}

function finish(
	run: RunState,
	status: RunStatus,
	exitCode: number | null,
	note: string,
) {
	if (run.status === "running" || run.status === "stopped") {
		run.status = run.status === "stopped" ? "stopped" : status;
	}
	run.exitCode = exitCode;
	run.endedAt = Date.now();
	run.child = undefined;
	readNew(run);
	flushPartial(run);
	fs.appendFileSync(run.logFile, `[devhub] ${note}\n`);
	readNew(run);
	run.events.emit("end", publicRun(run));
	prune();
	save();
}

async function boot() {
	let saved: (Run & { logFile: string })[] = [];
	try {
		saved = JSON.parse(fs.readFileSync(hubPaths.runs(), "utf8"));
	} catch {
		return;
	}
	for (const s of saved) {
		if (runs.has(s.id)) continue;
		const run: RunState = {
			...s,
			events: new EventEmitter(),
			offset: fileSize(s.logFile),
			partial: "",
		};
		if (s.status === "running" && s.pid) {
			// Decide before publishing the run, so nobody sees a half-restored state.
			if (await isSameRun(s.pid, s.startedAt)) run.adopted = true;
			else {
				run.status = "exited";
				run.endedAt = Date.now();
			}
		} else {
			// The previous hub may have died while this run was being stopped.
			run.endedAt ??= Date.now();
		}
		if (!runs.has(run.id)) runs.set(run.id, run);
	}
	save();
}

function fileSize(file: string) {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------- log tailing

function readNew(run: RunState) {
	const size = fileSize(run.logFile);
	if (size < run.offset) run.offset = 0; // truncated
	if (size === run.offset) return;
	const fd = fs.openSync(run.logFile, "r");
	try {
		const buf = Buffer.alloc(size - run.offset);
		fs.readSync(fd, buf, 0, buf.length, run.offset);
		run.offset = size;
		const text = run.partial + buf.toString("utf8");
		const lastBreak = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
		run.partial = text.slice(lastBreak + 1);
		for (const line of toLines(text.slice(0, lastBreak + 1)))
			run.events.emit("line", line);
	} finally {
		fs.closeSync(fd);
	}
}

function flushPartial(run: RunState) {
	if (!run.partial) return;
	for (const line of toLines(run.partial)) run.events.emit("line", line);
	run.partial = "";
}

// One timer for all runs: tail running logs and notice adopted runs exiting.
function tick() {
	for (const run of runs.values()) {
		if (run.endedAt) continue;
		readNew(run);
		if (!run.child && run.pid && !groupAlive(run.pid)) {
			finish(run, "exited", null, "process exited");
		}
	}
}

if (!store.__devhubRunnerBooted) {
	store.__devhubRunnerBooted = true;
	void boot();
	setInterval(tick, 300).unref();
	readHubConfig()
		.then((c) => {
			store.__devhubStopOnExit = c.stopProcessesOnExit;
		})
		.catch(() => {});
	const stopAll = () => {
		if (!store.__devhubStopOnExit) return;
		for (const run of runs.values())
			if (run.pid && run.status === "running") killGroup(run.pid, "SIGTERM");
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

function prune() {
	const finished = [...runs.values()]
		.filter((r) => r.status !== "running")
		.sort((a, b) => a.startedAt - b.startedAt);
	for (const r of finished.slice(0, Math.max(0, runs.size - MAX_RUNS))) {
		runs.delete(r.id);
		fs.rm(r.logFile, { force: true }, () => {});
	}
}

// ---------------------------------------------------------------- public API

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
	const id = randomUUID();
	fs.mkdirSync(hubPaths.logs(), { recursive: true });
	const logFile = path.join(hubPaths.logs(), `${id}.log`);
	fs.writeFileSync(logFile, `$ ${cmd.command}\n`);
	const fd = fs.openSync(logFile, "a");
	let child: ChildProcess;
	try {
		child = spawn(env.SHELL || "/bin/sh", ["-c", cmd.command], {
			cwd: cmd.cwd,
			env: { ...env, ...cmd.env, FORCE_COLOR: "0", DEVHUB: "1" },
			// Own process group, so Stop can kill the whole tree and a hub
			// restart (or Ctrl-C in the hub's terminal) doesn't take it down.
			detached: true,
			stdio: ["ignore", fd, fd],
		});
	} finally {
		fs.closeSync(fd);
	}
	const run: RunState = {
		id,
		projectId: project.id,
		commandKey: key,
		command: cmd.command,
		cwd: cmd.cwd,
		longRunning: Boolean(cmd.longRunning),
		pid: child.pid,
		status: "running",
		exitCode: null,
		startedAt: Date.now(),
		logFile,
		child,
		events: new EventEmitter(),
		offset: 0,
		partial: "",
	};
	runs.set(run.id, run);
	child.unref();
	child.on("error", (err) =>
		fs.appendFileSync(logFile, `[devhub] ${err.message}\n`),
	);
	child.on("exit", (code, signal) => {
		finish(
			run,
			code === 0 ? "succeeded" : "failed",
			code,
			`exited with ${signal ?? `code ${code}`}`,
		);
	});
	save();
	return publicRun(run);
}

export function stopRun(id: string) {
	const run = runs.get(id);
	if (!run?.pid || run.status !== "running") return;
	run.status = "stopped";
	const pid = run.pid;
	killGroup(pid, "SIGTERM");
	save();
	setTimeout(() => {
		if (groupAlive(pid)) killGroup(pid, "SIGKILL");
	}, 5000).unref();
}

export function waitForRun(id: string, timeoutMs = 5 * 60_000) {
	const run = runs.get(id);
	if (!run) return Promise.reject(new Error("Unknown run"));
	if (run.endedAt) return Promise.resolve(publicRun(run));
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

export function getRun(id: string) {
	const run = runs.get(id);
	return run ? publicRun(run) : null;
}

export function listRuns(projectId?: string) {
	return [...runs.values()]
		.filter((r) => !projectId || r.projectId === projectId)
		.sort((a, b) => b.startedAt - a.startedAt)
		.map(publicRun);
}

/** Processes still running for a project (hub-started or adopted). */
export function activeRuns(projectId?: string) {
	return [...runs.values()]
		.filter(
			(r) =>
				(!projectId || r.projectId === projectId) && r.status === "running",
		)
		.map(publicRun);
}

function readTail(file: string, maxBytes: number, end = fileSize(file)) {
	const size = Math.min(end, fileSize(file));
	if (size === 0) return "";
	const start = Math.max(0, size - maxBytes);
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(size - start);
		fs.readSync(fd, buf, 0, buf.length, start);
		const text = buf.toString("utf8");
		// Drop the first (possibly cut) line when we didn't start at 0.
		return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
	} finally {
		fs.closeSync(fd);
	}
}

/** Last `limit` lines of a run's output. */
export function runLogTail(id: string, limit = 200) {
	const run = runs.get(id);
	if (!run) return null;
	return toLines(readTail(run.logFile, MAX_REPLAY_BYTES)).slice(-limit);
}

/** Replays the log so far, then streams new lines. Returns an unsubscribe fn. */
export function subscribeRun(
	id: string,
	onLine: (line: string) => void,
	onEnd: (run: Run) => void,
) {
	const run = runs.get(id);
	if (!run) return null;
	const live = !run.endedAt;
	if (live) readNew(run);
	// Lines up to `offset` were already emitted as events, so replay exactly that
	// range from the file (minus the unfinished last line), then listen for more.
	let replay = readTail(
		run.logFile,
		MAX_REPLAY_BYTES,
		live ? run.offset : undefined,
	);
	if (live)
		replay = replay.slice(
			0,
			Math.max(replay.lastIndexOf("\n"), replay.lastIndexOf("\r")) + 1,
		);
	for (const line of toLines(replay)) onLine(line);
	if (!live) {
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
