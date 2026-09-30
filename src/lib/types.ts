/**
 * View models returned by server functions. Plain data only, so this file is
 * safe to import from both client components and server code.
 */

export type ServiceStatus = "running" | "stopped" | "error" | "unknown";
export type ProjectStatus =
	| "running"
	| "partial"
	| "stopped"
	| "unknown"
	| "invalid";

export type ServiceView = {
	key: string;
	label: string;
	kind?: string;
	url?: string;
	port?: number;
	connection?: string;
	status: ServiceStatus;
	/** Why the status is what it is, e.g. "listening (node, pid 4121)" or "healthcheck 500". */
	detail?: string;
	/** Stable URL through the hub's proxy, e.g. http://api.fitbase.localhost:6970. */
	proxyUrl?: string;
	/** Docker container backing this service (logs are available for it). */
	container?: string;
};

export type Usage = { cpu: number; memoryMb: number; processes: number };

export type GitView = {
	branch: string;
	changes: number;
	ahead: number;
	behind: number;
};

export type ProjectSummary = {
	id: string;
	name: string;
	description?: string;
	root: string;
	rootDisplay: string;
	status: ProjectStatus;
	error?: string;
	mainUrl?: string;
	git: GitView | null;
	services: ServiceView[];
	links: { label: string; url: string }[];
	personas: {
		key: string;
		label: string;
		user: string;
		role?: string;
		description?: string;
	}[];
	magicLogin: boolean;
	commandKeys: string[];
	stack: string[];
	type?: string;
	/** Stable URL of the main service through the hub's proxy. */
	proxyUrl?: string;
	/** CPU (% of one core) and memory of the project's processes and containers. */
	usage: Usage | null;
	/** Keys present in .env.example but missing from .env (all checked dirs). */
	envMissing: number;
	/** Configured ports that another registered project also uses. */
	sharedPorts: { port: number; projects: string[] }[];
	hasDatabase: boolean;
};

export type EnvCheck = {
	dir: string;
	template: string;
	hasEnv: boolean;
	missing: string[];
};

export type SnapshotView = {
	name: string;
	sizeBytes: number;
	createdAt: number;
};

export type PortConflict = {
	port: number;
	pid: number;
	process: string;
	cwd?: string;
	container?: string;
	projectName?: string;
};

export type CommandView = {
	key: string;
	label: string;
	command: string;
	cwd?: string;
	longRunning: boolean;
};

export type RunView = {
	id: string;
	projectId: string;
	commandKey: string;
	command: string;
	longRunning: boolean;
	pid?: number;
	status: "running" | "succeeded" | "failed" | "stopped" | "exited";
	exitCode: number | null;
	startedAt: number;
	endedAt?: number;
	adopted?: boolean;
};

/** Start either runs, or reports ports already taken by other processes. */
export type StartResult =
	| { ok: true; run: RunView }
	| { ok: false; conflicts: PortConflict[] };

export type ScenarioView = {
	key: string;
	label: string;
	description?: string;
	persona?: string;
	seed?: string;
	snapshot?: string;
};

export type ProjectDetail = ProjectSummary & {
	commands: CommandView[];
	trusted: boolean;
	scenarios: ScenarioView[];
	runs: RunView[];
	/** Listening ports whose process runs inside this repo but isn't a configured service. */
	extraPorts: PortView[];
	env: EnvCheck[];
	database: { type: string; target: string } | null;
	snapshots: SnapshotView[];
	/** Containers of this project whose logs can be streamed. */
	containers: string[];
};

export type PortView = {
	port: number;
	addresses: string[];
	pid: number;
	process: string;
	commandLine?: string;
	cwd?: string;
	type?: string;
	container?: string;
	projectId?: string;
	projectName?: string;
	serviceKey?: string;
	/** OS/background processes (cwd `/` or unreadable). Hidden by default. */
	system: boolean;
	/** This hub's own server. */
	isHub: boolean;
};

export type HubOverview = {
	projects: ProjectSummary[];
	unknownPorts: PortView[];
	dockerAvailable: boolean;
	/** 0 when the per-project proxy is disabled. */
	proxyPort: number;
};
