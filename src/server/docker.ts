import { cached, run } from "./exec";

export type DockerContainer = {
	id: string;
	name: string;
	image: string;
	/** `running`, `exited`, `restarting`, ... */
	state: string;
	status: string;
	/** Host ports published by the container. */
	hostPorts: number[];
	/** Compose project directory, from the `com.docker.compose.project.working_dir` label. */
	composeDir?: string;
	composeService?: string;
};

/** Parses the `Ports` column, e.g. `0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp`. */
export function parseDockerPorts(ports: string) {
	const out = new Set<number>();
	for (const m of ports.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
		const from = Number(m[1]);
		const to = m[2] ? Number(m[2]) : from;
		for (let p = from; p <= to && p - from < 1000; p++) out.add(p);
	}
	return [...out];
}

function parseLabels(labels: string) {
	const map = new Map<string, string>();
	for (const pair of labels.split(",")) {
		const eq = pair.indexOf("=");
		if (eq > 0) map.set(pair.slice(0, eq), pair.slice(eq + 1));
	}
	return map;
}

/** Parses `docker ps -a --format '{{json .}}'` (one JSON object per line). */
export function parseDockerPs(output: string): DockerContainer[] {
	const containers: DockerContainer[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		try {
			const c = JSON.parse(line);
			const labels = parseLabels(c.Labels ?? "");
			containers.push({
				id: c.ID,
				name: c.Names,
				image: c.Image,
				state: String(c.State ?? "").toLowerCase(),
				status: c.Status ?? "",
				hostPorts: parseDockerPorts(c.Ports ?? ""),
				composeDir: labels.get("com.docker.compose.project.working_dir"),
				composeService: labels.get("com.docker.compose.service"),
			});
		} catch {
			// Skip malformed lines rather than failing the whole dashboard.
		}
	}
	return containers;
}

async function detect() {
	// Short timeout: when Docker Desktop is stopped the CLI can hang.
	const out = await run("docker", ["ps", "-a", "--format", "{{json .}}"], {
		timeoutMs: 3000,
	});
	return out === null
		? { available: false, containers: [] }
		: { available: true, containers: parseDockerPs(out) };
}

export const dockerContainers = cached(2000, detect);
