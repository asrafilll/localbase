import { dockerContainers } from "./docker";
import { run } from "./exec";
import { listeningPorts } from "./ports";

/**
 * Frees a port: stops the Docker container publishing it, or sends SIGTERM
 * (then SIGKILL after 3s) to the processes listening on it. Never touches the
 * hub itself or Docker's own VM/proxy processes (killing those takes down
 * every container).
 */

const DOCKER_INFRA =
	/com\.docker|docker-proxy|vpnkit|orbstack|colima|limactl|qemu/i;

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function killPort(port: number) {
	const [ports, docker] = await Promise.all([
		listeningPorts(),
		dockerContainers(),
	]);
	const container = docker.containers.find(
		(c) => c.state === "running" && c.hostPorts.includes(port),
	);
	if (container) {
		const out = await run("docker", ["stop", container.name], {
			timeoutMs: 30_000,
		});
		if (out === null) throw new Error(`docker stop ${container.name} failed`);
		return { stopped: [`container ${container.name}`] };
	}
	const owners = ports.filter((p) => p.port === port);
	if (owners.length === 0)
		throw new Error(`Nothing of yours is listening on :${port}`);
	const stopped: string[] = [];
	for (const p of owners) {
		if (p.pid === process.pid)
			throw new Error(`:${port} is Local Dev Hub itself`);
		if (DOCKER_INFRA.test(p.process)) {
			throw new Error(
				`:${port} belongs to Docker (${p.process}); stop the container instead`,
			);
		}
		try {
			process.kill(p.pid, "SIGTERM");
			stopped.push(`${p.process} (pid ${p.pid})`);
		} catch (err) {
			throw new Error(`Could not stop pid ${p.pid}: ${(err as Error).message}`);
		}
	}
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline && owners.some((p) => alive(p.pid))) {
		await new Promise((r) => setTimeout(r, 150));
	}
	for (const p of owners) if (alive(p.pid)) process.kill(p.pid, "SIGKILL");
	return { stopped };
}
