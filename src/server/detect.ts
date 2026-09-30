import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { parseEnvKeys } from "./envcheck";
import type { ProjectFile, ServiceConfig } from "./schema";

/**
 * Guesses a `.dev/project.yaml` from what's already in a repository:
 * package.json scripts and dependencies, lockfiles, docker compose files,
 * .env ports, Laravel/Django/Rails entry points. The result is a starting
 * point the user reviews, never something applied silently.
 */

type CommandDef = {
	command: string;
	longRunning?: boolean;
	cwd?: string;
	label?: string;
};

export type Detection = {
	config: ProjectFile;
	/** Human-readable list of what was found, shown in the preview. */
	notes: string[];
};

type Pkg = {
	name?: string;
	description?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	workspaces?: unknown;
};

async function readText(file: string) {
	return fs.readFile(file, "utf8").catch(() => null);
}

async function readJson<T>(file: string): Promise<T | null> {
	const text = await readText(file);
	if (text === null) return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

async function exists(file: string) {
	return fs
		.access(file)
		.then(() => true)
		.catch(() => false);
}

/** KEY=value pairs from an env file (values only used for ports/URLs, never persisted as secrets). */
function parseEnv(text: string | null) {
	const env: Record<string, string> = {};
	for (const raw of (text ?? "").split(/\r?\n/)) {
		const m = raw.match(
			/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
		);
		if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
	}
	return env;
}

export async function detectPackageManager(dir: string) {
	if (await exists(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
	if (await exists(path.join(dir, "bun.lockb"))) return "bun";
	if (await exists(path.join(dir, "bun.lock"))) return "bun";
	if (await exists(path.join(dir, "yarn.lock"))) return "yarn";
	return "npm";
}

export function runScript(pm: string, script: string) {
	if (pm === "npm") return `npm run ${script}`;
	if (pm === "bun") return `bun run ${script}`;
	return `${pm} ${script}`;
}

/** Port given explicitly in a script: `-p 4000`, `--port 4000`, `--port=4000`, `PORT=4000`. */
export function portFromScript(script: string | undefined) {
	if (!script) return undefined;
	const m = script.match(/(?:--port[ =]|-p\s+|\bPORT=)(\d{2,5})\b/);
	return m ? Number(m[1]) : undefined;
}

const FRAMEWORKS: { dep: string; name: string; port: number }[] = [
	{ dep: "next", name: "Next.js", port: 3000 },
	{ dep: "nuxt", name: "Nuxt", port: 3000 },
	{ dep: "@sveltejs/kit", name: "SvelteKit", port: 5173 },
	{ dep: "astro", name: "Astro", port: 4321 },
	{ dep: "@remix-run/dev", name: "Remix", port: 5173 },
	{ dep: "@react-router/dev", name: "React Router", port: 5173 },
	{ dep: "@tanstack/react-start", name: "TanStack Start", port: 3000 },
	{ dep: "@angular/core", name: "Angular", port: 4200 },
	{ dep: "gatsby", name: "Gatsby", port: 8000 },
	{ dep: "react-scripts", name: "Create React App", port: 3000 },
	{ dep: "@nestjs/core", name: "NestJS", port: 3000 },
	{ dep: "vite", name: "Vite", port: 5173 },
	{ dep: "express", name: "Express", port: 3000 },
	{ dep: "fastify", name: "Fastify", port: 3000 },
	{ dep: "hono", name: "Hono", port: 3000 },
];

const STACK_DEPS: [string, string][] = [
	["react", "React"],
	["vue", "Vue"],
	["svelte", "Svelte"],
	["typescript", "TypeScript"],
	["tailwindcss", "Tailwind"],
	["prisma", "Prisma"],
	["@prisma/client", "Prisma"],
	["drizzle-orm", "Drizzle"],
];

function deps(pkg: Pkg) {
	return { ...pkg.dependencies, ...pkg.devDependencies };
}

/** Inspects one Node package (repo root or a monorepo app). */
async function detectNode(root: string, rel: string) {
	const dir = path.join(root, rel);
	const pkg = await readJson<Pkg>(path.join(dir, "package.json"));
	if (!pkg) return null;
	const all = deps(pkg);
	const scripts = pkg.scripts ?? {};
	const pm = await detectPackageManager(root);
	const framework = FRAMEWORKS.find((f) => f.dep in all);
	const devScript = scripts.dev ? "dev" : scripts.start ? "start" : undefined;
	const env = parseEnv(await readText(path.join(dir, ".env")));
	const port =
		portFromScript(devScript ? scripts[devScript] : undefined) ??
		(env.PORT ? Number(env.PORT) : undefined) ??
		framework?.port;
	const stack = new Set<string>();
	if (framework) stack.add(framework.name);
	for (const [dep, name] of STACK_DEPS) if (dep in all) stack.add(name);
	return { pkg, pm, framework, devScript, scripts, port, stack };
}

function composePorts(ports: unknown): number[] {
	if (!Array.isArray(ports)) return [];
	const out: number[] = [];
	for (const p of ports) {
		if (typeof p === "number") out.push(p);
		else if (typeof p === "string") {
			// "5432", "5432:5432", "127.0.0.1:5432:5432", "8000-8001:8000-8001/tcp"
			const parts = p.split("/")[0].split(":");
			const published = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
			const n = Number(published.split("-")[0]);
			if (Number.isInteger(n) && n > 0) out.push(n);
		} else if (p && typeof p === "object" && "published" in p) {
			const n = Number((p as { published: unknown }).published);
			if (Number.isInteger(n) && n > 0) out.push(n);
		}
	}
	return out;
}

const IMAGE_KINDS: [RegExp, ServiceConfig["kind"], string][] = [
	[/postgres|postgis|timescale/, "database", "PostgreSQL"],
	[/mysql|mariadb/, "database", "MySQL"],
	[/mongo/, "database", "MongoDB"],
	[/redis|valkey|dragonfly/, "cache", "Redis"],
	[/mailpit|mailhog|maildev/, "mail", "Mail viewer"],
	[/minio|localstack/, "storage", "Object storage"],
	[/rabbitmq|nats|kafka/, "queue", "Queue"],
	[/meilisearch|elasticsearch|opensearch|typesense/, "other", "Search"],
];

async function detectCompose(root: string) {
	for (const name of [
		"compose.yaml",
		"compose.yml",
		"docker-compose.yml",
		"docker-compose.yaml",
	]) {
		const text = await readText(path.join(root, name));
		if (text === null) continue;
		let doc: { services?: Record<string, Record<string, unknown>> };
		try {
			doc = YAML.parse(text) ?? {};
		} catch {
			return null;
		}
		const services: Record<string, ServiceConfig> = {};
		const stack = new Set<string>(["Docker"]);
		for (const [key, svc] of Object.entries(doc.services ?? {})) {
			const image = String(svc.image ?? "").toLowerCase();
			const ports = composePorts(svc.ports);
			const match = IMAGE_KINDS.find(([re]) => re.test(image));
			if (!ports.length && !match) continue;
			if (match) stack.add(match[2]);
			const kind = match?.[1] ?? "other";
			const service: ServiceConfig = { label: match?.[2] ?? key, kind };
			// Mail viewers expose a web UI; prefer its port for "Open".
			const uiPort =
				kind === "mail"
					? (ports.find((p) => p !== 1025) ?? ports[0])
					: undefined;
			if (uiPort) service.url = `http://localhost:${uiPort}`;
			else if (ports[0]) service.port = ports[0];
			if (typeof svc.container_name === "string")
				service.container = svc.container_name;
			services[key] = service;
		}
		return { file: name, services, stack };
	}
	return null;
}

function laravelDatabase(env: Record<string, string>): ProjectFile["database"] {
	const conn = env.DB_CONNECTION;
	if (conn === "sqlite") {
		return {
			type: "sqlite",
			path: env.DB_DATABASE?.startsWith("/")
				? undefined
				: (env.DB_DATABASE ?? "database/database.sqlite"),
		};
	}
	if (conn === "pgsql" || conn === "mysql" || conn === "mariadb") {
		const scheme = conn === "pgsql" ? "postgres" : "mysql";
		return {
			type: conn === "pgsql" ? "postgres" : "mysql",
			// Resolved from the repo's .env at run time, so no password lands in the yaml.
			url: `${scheme}://\${DB_USERNAME}:\${DB_PASSWORD}@\${DB_HOST}:\${DB_PORT}/\${DB_DATABASE}`,
		};
	}
	return undefined;
}

export async function detectProject(
	root: string,
	portHint?: number,
): Promise<Detection> {
	const notes: string[] = [];
	const config: ProjectFile = { name: path.basename(root) };
	const services: Record<string, ServiceConfig> = {};
	const commands: Record<string, CommandDef> = {};
	const stack = new Set<string>();
	const rootEnv = parseEnv(await readText(path.join(root, ".env")));
	const exampleEnvKeys = parseEnvKeys(
		(await readText(path.join(root, ".env.example"))) ?? "",
	);

	// --- Laravel / Django / Rails
	const composer = await readJson<{
		name?: string;
		description?: string;
		scripts?: Record<string, unknown>;
	}>(path.join(root, "composer.json"));
	const isLaravel = await exists(path.join(root, "artisan"));
	const isDjango = await exists(path.join(root, "manage.py"));
	const isRails = await exists(path.join(root, "bin", "rails"));

	if (isLaravel) {
		notes.push("Laravel app (artisan)");
		stack.add("Laravel").add("PHP");
		const appUrl =
			rootEnv.APP_URL && /^https?:\/\//.test(rootEnv.APP_URL)
				? rootEnv.APP_URL
				: "http://localhost:8000";
		services.web = { label: "Web", kind: "web", url: appUrl };
		commands.start = composer?.scripts?.dev
			? { command: "composer run dev", longRunning: true }
			: { command: "php artisan serve", longRunning: true };
		commands.queue = {
			command: "php artisan queue:work",
			longRunning: true,
			label: "Queue worker",
		};
		commands.seed = { command: "php artisan db:seed", label: "Seed database" };
		commands["reset-db"] = {
			command: "php artisan migrate:fresh --seed",
			label: "Reset database",
		};
		commands.test = { command: "php artisan test", label: "Run tests" };
		const db = laravelDatabase(rootEnv);
		if (db) {
			config.database = db;
			notes.push(`database: ${db.type} (from .env DB_CONNECTION)`);
			if (db.type !== "sqlite" && rootEnv.DB_PORT) {
				services.database = {
					label: db.type === "postgres" ? "PostgreSQL" : "MySQL",
					kind: "database",
					port: Number(rootEnv.DB_PORT),
				};
				stack.add(db.type === "postgres" ? "PostgreSQL" : "MySQL");
			} else if (db.type === "sqlite") stack.add("SQLite");
		}
		if (
			rootEnv.REDIS_PORT &&
			rootEnv.REDIS_HOST &&
			/^(127\.|localhost)/.test(rootEnv.REDIS_HOST)
		) {
			services.redis = {
				label: "Redis",
				kind: "cache",
				port: Number(rootEnv.REDIS_PORT),
			};
		}
		if (composer?.name)
			config.name = composer.name.split("/").pop() ?? config.name;
		if (composer?.description) config.description = composer.description;
	} else if (isDjango) {
		notes.push("Django app (manage.py)");
		stack.add("Django").add("Python");
		services.web = { label: "Web", kind: "web", url: "http://localhost:8000" };
		commands.start = {
			command: "python manage.py runserver",
			longRunning: true,
		};
		commands.migrate = {
			command: "python manage.py migrate",
			label: "Migrate",
		};
		commands.test = { command: "python manage.py test", label: "Run tests" };
	} else if (isRails) {
		notes.push("Rails app (bin/rails)");
		stack.add("Rails").add("Ruby");
		services.web = { label: "Web", kind: "web", url: "http://localhost:3000" };
		commands.start = (await exists(path.join(root, "bin", "dev")))
			? { command: "bin/dev", longRunning: true }
			: { command: "bin/rails server", longRunning: true };
		commands.seed = { command: "bin/rails db:seed", label: "Seed database" };
		commands["reset-db"] = {
			command: "bin/rails db:reset",
			label: "Reset database",
		};
		commands.test = { command: "bin/rails test", label: "Run tests" };
	}

	// --- Node (root package, or apps/* in a monorepo)
	const node = await detectNode(root, ".");
	if (node) {
		const { pkg, pm, framework, devScript, scripts, port } = node;
		if (!isLaravel && pkg.name) config.name = pkg.name.replace(/^@[^/]+\//, "");
		if (!config.description && pkg.description)
			config.description = pkg.description;
		for (const s of node.stack) stack.add(s);
		notes.push(
			`package manager: ${pm}${framework ? `, framework: ${framework.name}` : ""}`,
		);
		if (isLaravel) {
			if (scripts.dev && !composer?.scripts?.dev) {
				commands.vite = {
					command: runScript(pm, "dev"),
					longRunning: true,
					label: "Vite (assets)",
				};
			}
		} else if (devScript && !isDjango && !isRails) {
			commands.start = { command: runScript(pm, devScript), longRunning: true };
			if (port)
				services.web = {
					label: "Web",
					kind: "web",
					url: `http://localhost:${port}`,
				};
		}
		const extra: [string, string, string][] = [
			["test", "test", "Run tests"],
			["lint", "lint", "Lint"],
			["build", "build", "Build"],
			["db:seed", "seed", "Seed database"],
			["seed", "seed", "Seed database"],
			["db:migrate", "migrate", "Migrate"],
			["migrate", "migrate", "Migrate"],
			["db:reset", "reset-db", "Reset database"],
		];
		for (const [script, key, label] of extra) {
			if (scripts[script] && !commands[key])
				commands[key] = { command: runScript(pm, script), label };
		}
		if (scripts.storybook) {
			commands.storybook = {
				command: runScript(pm, "storybook"),
				longRunning: true,
				label: "Storybook",
			};
			services.storybook = {
				label: "Storybook",
				kind: "docs",
				url: `http://localhost:${portFromScript(scripts.storybook) ?? 6006}`,
			};
		}

		// Monorepo apps: apps/<name>/package.json with a dev script.
		if (
			pkg.workspaces ||
			(await exists(path.join(root, "pnpm-workspace.yaml")))
		) {
			const apps = await fs
				.readdir(path.join(root, "apps"), { withFileTypes: true })
				.catch(() => []);
			for (const entry of apps.slice(0, 8)) {
				if (!entry.isDirectory()) continue;
				const rel = path.join("apps", entry.name);
				const app = await detectNode(root, rel);
				if (!app?.devScript) continue;
				for (const s of app.stack) stack.add(s);
				const key = entry.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
				commands[`dev-${key}`] = {
					command: runScript(app.pm, app.devScript),
					cwd: rel,
					longRunning: true,
					label: `${entry.name} dev server`,
				};
				if (app.port) {
					services[key] = {
						label: entry.name,
						kind: /api|server|backend/.test(key) ? "api" : "web",
						url: `http://localhost:${app.port}`,
						command: `dev-${key}`,
					};
				}
				notes.push(
					`monorepo app: ${rel}${app.framework ? ` (${app.framework.name})` : ""}`,
				);
			}
		}
	}

	// --- Docker compose
	const compose = await detectCompose(root);
	if (compose) {
		notes.push(
			`${compose.file}: ${Object.keys(compose.services).join(", ") || "no published services"}`,
		);
		for (const s of compose.stack) stack.add(s);
		for (const [key, svc] of Object.entries(compose.services)) {
			const taken = Object.values(services).some(
				(s) => (s.port && s.port === svc.port) || (s.url && s.url === svc.url),
			);
			if (!taken) services[services[key] ? `${key}-docker` : key] = svc;
		}
		commands["services-up"] = {
			command: "docker compose up -d",
			label: "Start containers",
		};
		commands["services-down"] = {
			command: "docker compose down",
			label: "Stop containers",
		};
		if (commands.start) {
			// Bring containers up first, then run the dev server in the foreground.
			commands.start = {
				...commands.start,
				command: `docker compose up -d && ${commands.start.command}`,
			};
		} else {
			commands.start = { command: "docker compose up -d" };
			commands.stop = { command: "docker compose down" };
		}
	}

	if (
		!config.database &&
		(rootEnv.DATABASE_URL || exampleEnvKeys.has("DATABASE_URL"))
	) {
		const url = rootEnv.DATABASE_URL ?? "";
		const type = /^postgres/.test(url)
			? "postgres"
			: /^mysql/.test(url)
				? "mysql"
				: /^file:|sqlite/.test(url)
					? "sqlite"
					: undefined;
		if (type === "postgres" || type === "mysql") {
			config.database = { type, urlEnv: "DATABASE_URL" };
			notes.push(`database: ${type} (DATABASE_URL)`);
		}
	}

	// Port observed on the Ports page wins over a guessed default.
	if (portHint) {
		const main = Object.values(services).find(
			(s) => s.kind === "web" && s.url?.startsWith("http://localhost:"),
		);
		if (main) main.url = `http://localhost:${portHint}`;
		else if (
			!Object.values(services).some(
				(s) => s.url?.endsWith(`:${portHint}`) || s.port === portHint,
			)
		) {
			services.web = {
				label: "Web",
				kind: "web",
				url: `http://localhost:${portHint}`,
			};
		}
	}

	if (Object.keys(services).length) config.services = services;
	if (Object.keys(commands).length) config.commands = commands;
	if (stack.size) config.stack = [...stack];
	if (!notes.length) notes.push("nothing recognised; edit the file by hand");
	return { config, notes };
}

export function toYaml({ config, notes }: Detection) {
	const header = [
		"# Local Dev Hub project file (generated; review before trusting commands).",
		...notes.map((n) => `# detected: ${n}`),
		"# All options: https://github.com/asrafilll/localbase/blob/main/examples/fitbase/.dev/project.yaml",
	].join("\n");
	return `${header}\n${YAML.stringify(config)}`;
}
