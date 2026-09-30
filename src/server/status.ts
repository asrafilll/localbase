import net from "node:net";
import type {
	GitView,
	HubOverview,
	PortConflict,
	PortView,
	ProjectDetail,
	ProjectSummary,
	ServiceStatus,
	ServiceView,
} from "#/lib/types";
import { describeDatabase, listSnapshots, resolveDatabase } from "./database";
import { type DockerContainer, dockerContainers } from "./docker";
import { checkEnv } from "./envcheck";
import { gitInfo } from "./git";
import { isLoopbackHost } from "./magic-login";
import { isInside, tildify } from "./paths";
import { guessServiceType, type ListeningPort, listeningPorts } from "./ports";
import { proxyPortInUse, proxyUrlFor } from "./proxy";
import { type LoadedProject, loadProjects } from "./registry";
import { latestDockerStats, procTable, sumUsage } from "./resources";
import { activeRuns, listRuns } from "./runner";
import type { ServiceConfig } from "./schema";
import { isTrusted } from "./trust";

type ValidProject = Extract<LoadedProject, { ok: true }>;

type Snapshot = {
	ports: ListeningPort[];
	docker: { available: boolean; containers: DockerContainer[] };
};

async function snapshot(): Promise<Snapshot> {
	const [ports, docker] = await Promise.all([
		listeningPorts(),
		dockerContainers(),
	]);
	return { ports, docker };
}

/** Port a service is expected on: explicit `port`, else from a loopback `url`. */
export function servicePort(service: ServiceConfig) {
	if (service.port) return service.port;
	if (!service.url) return undefined;
	const url = new URL(service.url);
	if (!isLoopbackHost(url.hostname) || url.hostname.endsWith(".localhost"))
		return undefined;
	return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

function tcpOpen(port: number, host: string) {
	return new Promise<boolean>((resolve) => {
		const socket = net.connect({ port, host });
		const done = (ok: boolean) => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(300, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

async function healthcheck(url: string) {
	try {
		const res = await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(1500),
		});
		return { ok: res.status < 400, detail: `healthcheck ${res.status}` };
	} catch (err) {
		return { ok: false, detail: `healthcheck failed: ${(err as Error).name}` };
	}
}

function containerStatus(c: DockerContainer): ServiceStatus {
	if (c.state === "running") return "running";
	if (c.state === "restarting" || c.state === "dead") return "error";
	if (c.state === "exited" && !/Exited \(0\)/.test(c.status)) return "error";
	return "stopped";
}

/** Containers that belong to a project: named by a service, or started from its compose file. */
function projectContainers(
	project: ValidProject,
	containers: DockerContainer[],
) {
	const named = new Set(
		Object.values(project.config.services ?? {})
			.map((s) => s.container)
			.filter(Boolean),
	);
	return containers.filter(
		(c) =>
			named.has(c.name) ||
			(c.composeDir && isInside(c.composeDir, project.root)),
	);
}

async function serviceView(
	project: ValidProject,
	key: string,
	service: ServiceConfig,
	snap: Snapshot,
	proxyPort: number,
): Promise<ServiceView> {
	const port = servicePort(service);
	const base: ServiceView = {
		key,
		label: service.label ?? key,
		kind: service.kind,
		url: service.url,
		port,
		connection: service.connection,
		status: "unknown",
		proxyUrl:
			port && service.url ? proxyUrlFor(project.id, proxyPort, key) : undefined,
		container:
			service.container ??
			snap.docker.containers.find(
				(c) =>
					port !== undefined &&
					c.hostPorts.includes(port) &&
					c.composeDir &&
					isInside(c.composeDir, project.root),
			)?.name,
	};

	if (service.container) {
		if (!snap.docker.available)
			return { ...base, detail: "Docker is not running" };
		const c = snap.docker.containers.find((x) => x.name === service.container);
		if (!c)
			return {
				...base,
				status: "stopped",
				detail: `container ${service.container} not found`,
			};
		return {
			...base,
			status: containerStatus(c),
			detail: `${c.name}: ${c.status}`,
		};
	}

	if (port) {
		const owner = snap.ports.find((p) => p.port === port);
		let listening = Boolean(owner);
		// lsof only sees our own user's processes; fall back to a TCP probe.
		if (!listening)
			listening =
				(await tcpOpen(port, "127.0.0.1")) || (await tcpOpen(port, "::1"));
		if (!listening)
			return {
				...base,
				status: "stopped",
				detail: `nothing listening on :${port}`,
			};
		if (
			owner &&
			isForeignListener(
				project,
				service,
				owner,
				snap.docker.containers,
				runPgidsOf(project.id),
			)
		) {
			return {
				...base,
				status: "error",
				detail: `port taken by ${owner.process} (pid ${owner.pid})${owner.cwd ? ` from ${tildify(owner.cwd)}` : ""}`,
			};
		}
		const who = owner ? `${owner.process}, pid ${owner.pid}` : "port open";
		if (service.healthcheck) {
			const hc = await healthcheck(service.healthcheck);
			return {
				...base,
				status: hc.ok ? "running" : "error",
				detail: `${who}; ${hc.detail}`,
			};
		}
		return { ...base, status: "running", detail: `listening (${who})` };
	}

	if (service.healthcheck) {
		const hc = await healthcheck(service.healthcheck);
		return {
			...base,
			status: hc.ok ? "running" : "stopped",
			detail: hc.detail,
		};
	}

	if (service.command) {
		const run = activeRuns(project.id).find(
			(r) => r.commandKey === service.command,
		);
		return run
			? { ...base, status: "running", detail: `hub-managed, pid ${run.pid}` }
			: {
					...base,
					status: "stopped",
					detail: `"${service.command}" not running`,
				};
	}

	return {
		...base,
		detail: "no port, container, healthcheck or command to check",
	};
}

function projectStatus(
	services: ServiceView[],
	hasActiveRuns: boolean,
): ProjectSummary["status"] {
	const known = services.filter((s) => s.status !== "unknown");
	const running = known.filter((s) => s.status === "running").length;
	if (known.length === 0) return hasActiveRuns ? "running" : "unknown";
	if (running === known.length) return "running";
	if (running > 0 || hasActiveRuns) return "partial";
	return "stopped";
}

const gitCache = new Map<
	string,
	{ at: number; value: Promise<GitView | null> }
>();
function cachedGit(root: string) {
	const hit = gitCache.get(root);
	if (hit && Date.now() - hit.at < 3000) return hit.value;
	const value = gitInfo(root);
	gitCache.set(root, { at: Date.now(), value });
	return value;
}

/** Ports configured by more than one registered project. */
function sharedPortsMap(projects: ValidProject[]) {
	const byPort = new Map<number, string[]>();
	for (const p of projects) {
		const ports = new Set(
			Object.values(p.config.services ?? {})
				.map(servicePort)
				.filter((x): x is number => x !== undefined),
		);
		for (const port of ports)
			byPort.set(port, [...(byPort.get(port) ?? []), p.config.name]);
	}
	return byPort;
}

/** Does this listening process belong to the project (not a stranger on its port)? */
export function ownsPort(
	project: ValidProject,
	lp: ListeningPort,
	containers: DockerContainer[],
	runPgids: number[],
) {
	if (lp.pgid && runPgids.includes(lp.pgid)) return true;
	if (lp.cwd && isInside(lp.cwd, project.root)) return true;
	const container = containers.find(
		(c) => c.state === "running" && c.hostPorts.includes(lp.port),
	);
	if (container) return projectContainers(project, [container]).length > 0;
	return false;
}

/**
 * Shared infrastructure (a Homebrew Postgres, a system Redis) legitimately
 * serves several projects, so only app-like services can be "taken".
 */
const SHARED_KINDS = new Set(["database", "cache", "queue", "mail", "storage"]);

/** A listener on the service's port that is clearly some other app. */
export function isForeignListener(
	project: ValidProject,
	service: ServiceConfig,
	lp: ListeningPort,
	containers: DockerContainer[],
	runPgids: number[],
) {
	if (service.container || SHARED_KINDS.has(service.kind ?? "")) return false;
	if (lp.pid === process.pid) return false;
	if (ownsPort(project, lp, containers, runPgids)) return false;
	const container = containers.find(
		(c) => c.state === "running" && c.hostPorts.includes(lp.port),
	);
	const cwd = container?.composeDir ?? lp.cwd;
	// Unknown or "/" cwd = system daemon or another user's process: can't tell.
	return Boolean(container || (cwd && cwd !== "/"));
}

function runPgidsOf(projectId: string) {
	return activeRuns(projectId)
		.map((r) => r.pid)
		.filter((x): x is number => x !== undefined);
}

/** Processes of *other* projects/apps already listening on this project's ports. */
export function findConflicts(
	project: ValidProject,
	snap: Snapshot,
	projects: ValidProject[],
): PortConflict[] {
	const runPgids = runPgidsOf(project.id);
	const services = Object.values(project.config.services ?? {});
	const conflicts: PortConflict[] = [];
	for (const lp of snap.ports) {
		const service = services.find((s) => servicePort(s) === lp.port);
		if (!service) continue;
		if (
			!isForeignListener(project, service, lp, snap.docker.containers, runPgids)
		)
			continue;
		const container = snap.docker.containers.find(
			(c) => c.state === "running" && c.hostPorts.includes(lp.port),
		);
		const cwd = container?.composeDir ?? lp.cwd;
		const other = projects.find(
			(p) => p.id !== project.id && cwd && isInside(cwd, p.root),
		);
		conflicts.push({
			port: lp.port,
			pid: lp.pid,
			process: lp.process,
			cwd: cwd ? tildify(cwd) : undefined,
			container: container?.name,
			projectName: other?.config.name,
		});
	}
	return conflicts;
}

export async function conflictsFor(project: ValidProject) {
	const [projects, snap] = await Promise.all([loadProjects(), snapshot()]);
	return findConflicts(
		project,
		snap,
		projects.filter((p): p is ValidProject => p.ok),
	);
}

function usageFor(
	project: ValidProject,
	snap: Snapshot,
	procs: Awaited<ReturnType<typeof procTable>>,
) {
	const pgids = activeRuns(project.id)
		.map((r) => r.pid)
		.filter((x): x is number => x !== undefined);
	const rootPids = snap.ports
		.filter((lp) => lp.cwd && isInside(lp.cwd, project.root))
		.map((lp) => lp.pid);
	const usage = sumUsage(procs, rootPids, pgids);
	const containers = new Set(
		projectContainers(project, snap.docker.containers).map((c) => c.name),
	);
	for (const s of latestDockerStats()) {
		if (!containers.has(s.name)) continue;
		usage.cpu += s.cpu;
		usage.memoryMb += s.memoryMb;
	}
	return usage.processes === 0 && containers.size === 0 ? null : usage;
}

async function summarize(
	project: LoadedProject,
	snap: Snapshot,
	ctx: {
		proxyPort: number;
		shared: Map<number, string[]>;
		procs: Awaited<ReturnType<typeof procTable>>;
	},
): Promise<ProjectSummary> {
	const common = {
		id: project.id,
		root: project.root,
		rootDisplay: tildify(project.root),
	};
	if (!project.ok) {
		return {
			...common,
			name: project.id,
			status: "invalid",
			error: project.error,
			git: await cachedGit(project.root),
			services: [],
			links: [],
			personas: [],
			magicLogin: false,
			commandKeys: [],
			stack: [],
			usage: null,
			envMissing: 0,
			sharedPorts: [],
			hasDatabase: false,
			trusted: false,
		};
	}
	const c = project.config;
	const commandDirs = Object.values(c.commands ?? {})
		.map((cmd) => cmd.cwd)
		.filter((d): d is string => Boolean(d));
	const [services, git, env] = await Promise.all([
		Promise.all(
			Object.entries(c.services ?? {}).map(([k, s]) =>
				serviceView(project, k, s, snap, ctx.proxyPort),
			),
		),
		cachedGit(project.root),
		checkEnv(project.root, commandDirs),
	]);
	const ports = new Set(
		Object.values(c.services ?? {})
			.map(servicePort)
			.filter((x): x is number => x !== undefined),
	);
	const mainUrl =
		c.url ?? Object.values(c.services ?? {}).find((s) => s.url)?.url;
	const mainIsLocal = mainUrl
		? servicePort({ url: mainUrl }) !== undefined
		: false;
	return {
		...common,
		name: c.name,
		description: c.description,
		type: c.type,
		stack: c.stack ?? [],
		status: projectStatus(services, activeRuns(project.id).length > 0),
		mainUrl,
		proxyUrl: mainIsLocal ? proxyUrlFor(project.id, ctx.proxyPort) : undefined,
		git,
		services,
		links: c.links ?? [],
		personas: Object.entries(c.personas ?? {}).map(([key, p]) => ({
			key,
			...p,
		})),
		magicLogin: Boolean(c.magicLogin),
		commandKeys: Object.keys(c.commands ?? {}),
		usage: usageFor(project, snap, ctx.procs),
		// Without a .env file every template key counts as missing.
		envMissing: env.reduce((n, e) => n + e.missing.length, 0),
		sharedPorts: [...ports]
			.map((port) => ({
				port,
				projects: (ctx.shared.get(port) ?? []).filter((n) => n !== c.name),
			}))
			.filter((s) => s.projects.length > 0),
		hasDatabase: Boolean(c.database),
		trusted: await isTrusted(project.root, c),
	};
}

/** Maps every listening port to a project/service when it can. */
function classifyPorts(projects: LoadedProject[], snap: Snapshot): PortView[] {
	const valid = projects.filter((p): p is ValidProject => p.ok);
	return snap.ports.map((p) => {
		const container = snap.docker.containers.find(
			(c) => c.state === "running" && c.hostPorts.includes(p.port),
		);
		// Docker-published ports are owned by the Docker VM process, so its cwd is
		// meaningless; the compose working_dir label tells us the real project.
		const cwd = container?.composeDir ?? p.cwd;
		let match: { project: ValidProject; serviceKey?: string } | undefined;
		for (const project of valid) {
			const serviceKey = Object.entries(project.config.services ?? {}).find(
				([, s]) =>
					servicePort(s) === p.port ||
					(container && s.container === container.name),
			)?.[0];
			if (serviceKey) {
				match = { project, serviceKey };
				break;
			}
		}
		match ??= (() => {
			if (!cwd) return undefined;
			// Deepest root wins so nested repos (monorepo/app) map correctly.
			const owner = valid
				.filter((project) => isInside(cwd, project.root))
				.sort((a, b) => b.root.length - a.root.length)[0];
			return owner ? { project: owner } : undefined;
		})();
		return {
			port: p.port,
			addresses: p.addresses,
			pid: p.pid,
			process: p.process,
			commandLine: p.commandLine,
			cwd: cwd ? tildify(cwd) : undefined,
			type: container ? `Docker · ${container.image}` : guessServiceType(p),
			container: container?.name,
			projectId: match?.project.id,
			projectName: match?.project.config.name,
			serviceKey: match?.serviceKey,
			system: !container && (!p.cwd || p.cwd === "/"),
			isHub: p.pid === process.pid || p.port === proxyPortInUse(),
		};
	});
}

async function context(projects: LoadedProject[]) {
	const valid = projects.filter((p): p is ValidProject => p.ok);
	return {
		proxyPort: proxyPortInUse(),
		shared: sharedPortsMap(valid),
		procs: await procTable(),
	};
}

export async function overview(): Promise<HubOverview> {
	const [projects, snap] = await Promise.all([loadProjects(), snapshot()]);
	const ctx = await context(projects);
	const summaries = await Promise.all(
		projects.map((p) => summarize(p, snap, ctx)),
	);
	const unknownPorts = classifyPorts(projects, snap).filter(
		(p) => !p.projectId && !p.isHub,
	);
	return {
		projects: summaries,
		unknownPorts,
		dockerAvailable: snap.docker.available,
		proxyPort: ctx.proxyPort,
	};
}

export async function allPorts() {
	const [projects, snap] = await Promise.all([loadProjects(), snapshot()]);
	return {
		ports: classifyPorts(projects, snap),
		dockerAvailable: snap.docker.available,
	};
}

export async function projectDetail(id: string): Promise<ProjectDetail> {
	const [projects, snap] = await Promise.all([loadProjects(), snapshot()]);
	const project = projects.find((p) => p.id === id);
	if (!project) throw new Error(`Unknown project: ${id}`);
	const summary = await summarize(project, snap, await context(projects));
	const extraPorts = classifyPorts(projects, snap).filter(
		(p) => p.projectId === id && !p.serviceKey,
	);
	if (!project.ok) {
		return {
			...summary,
			commands: [],
			trusted: false,
			scenarios: [],
			runs: listRuns(id),
			extraPorts,
			env: [],
			database: null,
			snapshots: [],
			containers: [],
		};
	}
	const c = project.config;
	const commandDirs = Object.values(c.commands ?? {})
		.map((cmd) => cmd.cwd)
		.filter((d): d is string => Boolean(d));
	let database: ProjectDetail["database"] = null;
	if (c.database) {
		try {
			database = {
				type: c.database.type,
				target: describeDatabase(await resolveDatabase(project), project.root),
			};
		} catch (err) {
			database = {
				type: c.database.type,
				target: `⚠ ${(err as Error).message}`,
			};
		}
	}
	return {
		...summary,
		commands: Object.entries(c.commands ?? {}).map(([key, cmd]) => ({
			key,
			label: cmd.label ?? key,
			command: cmd.command,
			cwd: cmd.cwd,
			longRunning: Boolean(cmd.longRunning),
		})),
		trusted: await isTrusted(project.root, c),
		scenarios: Object.entries(c.scenarios ?? {}).map(([key, s]) => ({
			key,
			...s,
		})),
		runs: listRuns(id),
		extraPorts,
		env: await checkEnv(project.root, commandDirs),
		database,
		snapshots: c.database ? await listSnapshots(project.id) : [],
		containers: projectContainers(project, snap.docker.containers).map(
			(x) => x.name,
		),
	};
}

/** Container names that belong to any registered project (log streaming allow-list). */
export async function knownContainers() {
	const [projects, docker] = await Promise.all([
		loadProjects(),
		dockerContainers(),
	]);
	return new Set(
		projects
			.filter((p): p is ValidProject => p.ok)
			.flatMap((p) =>
				projectContainers(p, docker.containers).map((c) => c.name),
			),
	);
}
