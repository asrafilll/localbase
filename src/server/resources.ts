import { cached, run } from "./exec";

export type ProcInfo = {
	pid: number;
	ppid: number;
	pgid: number;
	/** Resident memory in KB. */
	rss: number;
	cpu: number;
};

/** Parses `ps -axo pid=,ppid=,pgid=,rss=,pcpu=`. */
export function parseProcTable(output: string): ProcInfo[] {
	const procs: ProcInfo[] = [];
	for (const line of output.split("\n")) {
		const f = line.trim().split(/\s+/);
		if (f.length < 5) continue;
		const [pid, ppid, pgid, rss, cpu] = f.map(Number);
		if ([pid, ppid, pgid, rss].some((n) => !Number.isFinite(n))) continue;
		procs.push({ pid, ppid, pgid, rss, cpu: Number.isFinite(cpu) ? cpu : 0 });
	}
	return procs;
}

/** Parses docker's "12.5MiB / 7.6GiB" into MB. */
export function parseDockerMem(usage: string) {
	const m = usage.trim().match(/^([\d.]+)\s*([KMGT]?i?B)/i);
	if (!m) return 0;
	const n = Number(m[1]);
	const unit = m[2].toUpperCase().replace("I", "");
	const factor: Record<string, number> = {
		B: 1 / 1024 / 1024,
		KB: 1 / 1024,
		MB: 1,
		GB: 1024,
		TB: 1024 * 1024,
	};
	return n * (factor[unit] ?? 1);
}

export const procTable = cached(2500, async () => {
	const out = await run("ps", ["-axo", "pid=,ppid=,pgid=,rss=,pcpu="]);
	return out ? parseProcTable(out) : [];
});

export type ContainerStats = { name: string; cpu: number; memoryMb: number };

async function readDockerStats(): Promise<ContainerStats[]> {
	const out = await run(
		"docker",
		["stats", "--no-stream", "--format", "{{json .}}"],
		{ timeoutMs: 4000 },
	);
	if (!out) return [];
	const stats: ContainerStats[] = [];
	for (const line of out.split("\n")) {
		try {
			const s = JSON.parse(line);
			stats.push({
				name: s.Name,
				cpu: Number.parseFloat(s.CPUPerc) || 0,
				memoryMb: parseDockerMem(String(s.MemUsage ?? "")),
			});
		} catch {
			// skip
		}
	}
	return stats;
}

// `docker stats` takes ~2s, so never block a dashboard refresh on it: return
// the last result immediately and refresh in the background.
let statsCache: { at: number; value: ContainerStats[] } = { at: 0, value: [] };
let statsInFlight: Promise<void> | null = null;
export function latestDockerStats() {
	if (!statsInFlight && Date.now() - statsCache.at > 5000) {
		statsInFlight = readDockerStats()
			.then((value) => {
				statsCache = { at: Date.now(), value };
			})
			.catch(() => {})
			.finally(() => {
				statsInFlight = null;
			});
	}
	return statsCache.value;
}

export type Usage = { cpu: number; memoryMb: number; processes: number };

/**
 * Sums CPU/RSS over a project's processes: every member of the given process
 * groups (hub-started commands) plus the given root pids (listening processes)
 * and all their descendants.
 */
export function sumUsage(
	procs: ProcInfo[],
	rootPids: number[],
	pgids: number[],
): Usage {
	const children = new Map<number, number[]>();
	for (const p of procs) {
		const list = children.get(p.ppid) ?? [];
		list.push(p.pid);
		children.set(p.ppid, list);
	}
	const byPid = new Map(procs.map((p) => [p.pid, p]));
	const seen = new Set<number>();
	const stack = [
		...rootPids,
		...procs.filter((p) => pgids.includes(p.pgid)).map((p) => p.pid),
	];
	while (stack.length) {
		const pid = stack.pop() as number;
		if (seen.has(pid) || !byPid.has(pid) || pid <= 1) continue;
		seen.add(pid);
		stack.push(...(children.get(pid) ?? []));
	}
	let cpu = 0;
	let rss = 0;
	for (const pid of seen) {
		const p = byPid.get(pid);
		if (!p) continue;
		cpu += p.cpu;
		rss += p.rss;
	}
	return { cpu, memoryMb: rss / 1024, processes: seen.size };
}
