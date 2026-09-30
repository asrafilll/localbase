import { z } from "zod";

/**
 * Schema for a project's `.dev/project.yaml`.
 * Everything except `name` is optional so a project can start tiny and grow.
 */

export const serviceKindSchema = z.enum([
	"web",
	"api",
	"admin",
	"docs",
	"database",
	"cache",
	"queue",
	"worker",
	"mail",
	"storage",
	"other",
]);

export const serviceSchema = z.object({
	label: z.string().optional(),
	kind: serviceKindSchema.optional(),
	/** Browser-openable URL. The port is derived from it when `port` is omitted. */
	url: z.url().optional(),
	port: z.number().int().min(1).max(65535).optional(),
	/** Optional HTTP URL that must answer 2xx/3xx for the service to count as running. */
	healthcheck: z.url().optional(),
	/** Docker container name, for services that only run inside Docker. */
	container: z.string().optional(),
	/** Human readable connection info, e.g. "postgres://localhost:5432/fitbase". */
	connection: z.string().optional(),
	/**
	 * Key of a `longRunning` command that runs this service. Lets port-less
	 * services (workers, queues) show as running while the hub owns the process.
	 */
	command: z.string().optional(),
});

export const linkSchema = z.object({
	label: z.string(),
	url: z.url(),
});

export const personaSchema = z.object({
	label: z.string(),
	/** Identity the target app looks up: an email, username or id. Never a password. */
	user: z.string(),
	role: z.string().optional(),
	description: z.string().optional(),
});

const commandObjectSchema = z.object({
	command: z.string(),
	label: z.string().optional(),
	/** Working directory, relative to the repository root. */
	cwd: z.string().optional(),
	/**
	 * `true` for commands that keep running (e.g. `npm run dev`).
	 * The hub owns the process and kills it on Stop.
	 */
	longRunning: z.boolean().optional(),
	/** Extra environment variables, e.g. { PORT: "3001" }. */
	env: z.record(z.string(), z.string()).optional(),
});

/** A command is either a plain string or the full object form. */
export const commandSchema = z.union([
	z
		.string()
		.transform((command): z.infer<typeof commandObjectSchema> => ({ command })),
	commandObjectSchema,
]);

export const magicLoginSchema = z
	.object({
		/**
		 * `endpoint` (default): the hub signs a token and opens the app's dev-only
		 * login route. `supabase`: the hub asks a *local* Supabase (supabase start)
		 * for a one-time magic link, so the app needs no code at all.
		 */
		provider: z.enum(["endpoint", "supabase"]).default("endpoint"),
		/** Dev-only endpoint in the target app that accepts `?token=`. */
		endpoint: z.url().optional(),
		/** Path (endpoint) or URL (supabase) to land on after login. */
		redirect: z.string().optional(),
	})
	.refine((m) => m.provider !== "endpoint" || m.endpoint, {
		message: "magicLogin.endpoint is required (or set provider: supabase)",
		path: ["endpoint"],
	});

export const scenarioSchema = z.object({
	label: z.string(),
	description: z.string().optional(),
	persona: z.string().optional(),
	/** Key of an entry in `commands` to run before logging in. */
	seed: z.string().optional(),
	/** Name of a database snapshot to restore before logging in (faster than a seed). */
	snapshot: z.string().optional(),
});

export const databaseSchema = z.object({
	type: z.enum(["postgres", "mysql", "sqlite"]),
	/** Connection URL, e.g. postgres://user:pass@localhost:5432/app. */
	url: z.string().optional(),
	/** Read the URL from this key in the repo's .env instead (e.g. DATABASE_URL). */
	urlEnv: z.string().optional(),
	/** SQLite database file, relative to the repository root. */
	path: z.string().optional(),
	/** Run pg_dump/mysqldump inside this Docker container instead of on the host. */
	container: z.string().optional(),
});

export const projectFileSchema = z.object({
	/** Stable id used in URLs and Magic Login tokens. Defaults to a slug of `name`. */
	id: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]*$/)
		.optional(),
	name: z.string(),
	description: z.string().optional(),
	type: z.string().optional(),
	stack: z.array(z.string()).optional(),
	/** Main URL for "Open App". Defaults to the first service with a URL. */
	url: z.url().optional(),
	services: z.record(z.string(), serviceSchema).optional(),
	links: z.array(linkSchema).optional(),
	personas: z.record(z.string(), personaSchema).optional(),
	magicLogin: magicLoginSchema.optional(),
	commands: z.record(z.string(), commandSchema).optional(),
	scenarios: z.record(z.string(), scenarioSchema).optional(),
	database: databaseSchema.optional(),
});

export type DatabaseConfig = z.infer<typeof databaseSchema>;
export type ProjectFile = z.infer<typeof projectFileSchema>;
export type ServiceConfig = z.infer<typeof serviceSchema>;
export type CommandConfig = z.infer<typeof commandSchema>;

/** Schema for the hub's own `~/.config/devhub/config.yaml`. */
export const hubConfigSchema = z.object({
	/** Repository paths that contain `.dev/project.yaml`. `~` is expanded. */
	projects: z.array(z.string()).default([]),
	/** Directories scanned one level deep for `*\/.dev/project.yaml`. */
	scanDirs: z.array(z.string()).default([]),
	/** CLI used by "Open in editor", e.g. `code`, `cursor`, `zed`. */
	editor: z.string().default("code"),
	/**
	 * Port of the per-project reverse proxy (`<project>.localhost:<port>`).
	 * 0 disables it. On macOS, 80 works without sudo and gives http://<project>.localhost.
	 */
	proxyPort: z.number().int().min(0).max(65535).default(6970),
	/**
	 * Stop hub-started processes when the hub exits. Off by default: they keep
	 * running and the hub re-attaches to them on its next start.
	 */
	stopProcessesOnExit: z.boolean().default(false),
});

export type HubConfig = z.infer<typeof hubConfigSchema>;
