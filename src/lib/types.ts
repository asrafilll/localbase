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
};

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
	status: "running" | "succeeded" | "failed" | "stopped";
	exitCode: number | null;
	startedAt: number;
	endedAt?: number;
};

export type ScenarioView = {
	key: string;
	label: string;
	description?: string;
	persona?: string;
	seed?: string;
};

export type ProjectDetail = ProjectSummary & {
	commands: CommandView[];
	trusted: boolean;
	scenarios: ScenarioView[];
	runs: RunView[];
	/** Listening ports whose process runs inside this repo but isn't a configured service. */
	extraPorts: PortView[];
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
};
