import fs from "node:fs/promises";
import { cached, run } from "./exec";

export type ListeningPort = {
	port: number;
	/** Addresses the port is bound on, e.g. `*`, `127.0.0.1`, `[::1]`. */
	addresses: string[];
	pid: number;
	/** Short process name as reported by lsof (`node`, `postgres`, `com.docker.backend`). */
	process: string;
	/** Full command line, when readable. */
	commandLine?: string;
	cwd?: string;
};

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output. */
export function parseLsofListen(output: string) {
	const byKey = new Map<string, ListeningPort>();
	let pid = 0;
	let command = "";
	for (const line of output.split("\n")) {
		const tag = line[0];
		const value = line.slice(1);
		if (tag === "p") pid = Number(value);
		else if (tag === "c") command = value;
		else if (tag === "n") {
			const idx = value.lastIndexOf(":");
			const port = Number(value.slice(idx + 1));
			if (idx <= 0 || !Number.isInteger(port)) continue;
			const address = value.slice(0, idx);
			const key = `${pid}:${port}`;
			const existing = byKey.get(key);
			if (existing) {
				if (!existing.addresses.includes(address))
					existing.addresses.push(address);
			} else {
				byKey.set(key, { port, addresses: [address], pid, process: command });
			}
		}
	}
	return [...byKey.values()].sort((a, b) => a.port - b.port);
}

/** Parses `lsof -a -d cwd -p <pids> -F pn` output into pid -> cwd. */
export function parseLsofCwd(output: string) {
	const cwds = new Map<number, string>();
	let pid = 0;
	for (const line of output.split("\n")) {
		if (line[0] === "p") pid = Number(line.slice(1));
		else if (line[0] === "n" && pid) cwds.set(pid, line.slice(1));
	}
	return cwds;
}

/** Parses `ps -o pid=,args= -p <pids>` output into pid -> command line. */
export function parsePsArgs(output: string) {
	const args = new Map<number, string>();
	for (const line of output.split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(.*)$/);
		if (m) args.set(Number(m[1]), m[2]);
	}
	return args;
}

async function readCwds(pids: number[]) {
	const cwds = new Map<number, string>();
	if (pids.length === 0) return cwds;
	if (process.platform === "linux") {
		await Promise.all(
			pids.map(async (pid) => {
				const cwd = await fs.readlink(`/proc/${pid}/cwd`).catch(() => null);
				if (cwd) cwds.set(pid, cwd);
			}),
		);
		return cwds;
	}
	// macOS has no /proc; lsof reads the cwd of processes owned by the current user.
	const out = await run("lsof", [
		"-a",
		"-d",
		"cwd",
		"-p",
		pids.join(","),
		"-F",
		"pn",
	]);
	return out ? parseLsofCwd(out) : cwds;
}

async function readCommandLines(pids: number[]) {
	if (pids.length === 0) return new Map<number, string>();
	const out = await run("ps", ["-o", "pid=,args=", "-p", pids.join(",")]);
	return out ? parsePsArgs(out) : new Map<number, string>();
}

async function detect(): Promise<ListeningPort[]> {
	const out = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
	if (out === null) return [];
	const ports = parseLsofListen(out);
	const pids = [...new Set(ports.map((p) => p.pid))];
	const [cwds, commandLines] = await Promise.all([
		readCwds(pids),
		readCommandLines(pids),
	]);
	for (const p of ports) {
		p.cwd = cwds.get(p.pid);
		p.commandLine = commandLines.get(p.pid);
	}
	return ports;
}

export const listeningPorts = cached(1500, detect);

/** Best-effort label for what a process is, from its command line. */
export function guessServiceType(
	p: Pick<ListeningPort, "process" | "commandLine">,
) {
	const cmd = `${p.process} ${p.commandLine ?? ""}`.toLowerCase();
	const rules: [RegExp, string][] = [
		[/next(-server|\/dist|\s+dev|\s+start)/, "Next.js"],
		[/vite/, "Vite"],
		[/nuxt/, "Nuxt"],
		[/astro/, "Astro"],
		[/remix|react-router/, "React Router"],
		[/storybook/, "Storybook"],
		[/artisan|php-fpm|php\s/, "Laravel / PHP"],
		[/rails|puma/, "Rails"],
		[/manage\.py|django|gunicorn|uvicorn/, "Python"],
		[/postgres/, "PostgreSQL"],
		[/mysqld|mariadb/, "MySQL"],
		[/redis/, "Redis"],
		[/mongod/, "MongoDB"],
		[/mailpit|mailhog/, "Mail viewer"],
		[/com\.docker|docker-proxy|vpnkit|orbstack/, "Docker"],
		[/\bgo\b|\/go-build/, "Go"],
		[/\bnode\b|\bbun\b|\bdeno\b/, "Node.js"],
	];
	return rules.find(([re]) => re.test(cmd))?.[1];
}
