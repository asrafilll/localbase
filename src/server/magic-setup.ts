import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import djangoView from "../../adapters/django/devhub_login.py?raw";
import djangoToken from "../../adapters/django/devhub_token.py?raw";
import laravelController from "../../adapters/laravel/DevhubLoginController.php?raw";
import laravelToken from "../../adapters/laravel/DevhubToken.php?raw";
import nodeVerifier from "../../adapters/node/devhub-magic-login.ts?raw";
import railsController from "../../adapters/rails/devhub_login_controller.rb?raw";
import railsToken from "../../adapters/rails/devhub_token.rb?raw";
import { publicKeyEnvValue } from "./magic-login";
import { type LoadedProject, PROJECT_FILE } from "./registry";

/**
 * "Set up Magic Login": figures out how a project signs users in, finds dev
 * accounts in its seed files, and writes what's needed — personas and
 * magicLogin in .dev/project.yaml, the dev-only login route in the app, and
 * DEVHUB_PUBLIC_KEY in a dev env file. Nothing is written until the user
 * reviews the plan and clicks Apply; existing files are never overwritten.
 */

type ValidProject = Extract<LoadedProject, { ok: true }>;

export type Persona = {
	key: string;
	label: string;
	user: string;
	source?: string;
};

export type PlannedFile = {
	path: string;
	content: string;
	/** create = new file; append = add a block to an existing file. */
	mode: "create" | "append";
	/** Already present (file exists / block already there): will be skipped. */
	skip: boolean;
};

export type SetupPlan = {
	stack: string;
	/** Works right after Apply, without editing code. */
	automatic: boolean;
	personas: Persona[];
	magicLogin: {
		provider: "endpoint" | "supabase";
		endpoint?: string;
		redirect: string;
	};
	files: PlannedFile[];
	env: { file: string; line: string; skip: boolean } | null;
	/** What the user still has to do after Apply. */
	steps: string[];
	notes: string[];
};

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"vendor",
	"dist",
	"build",
	".next",
	".output",
	"coverage",
	"tmp",
	"storage",
	".venv",
	"venv",
]);

async function exists(p: string) {
	return fs
		.access(p)
		.then(() => true)
		.catch(() => false);
}

async function read(p: string) {
	return fs.readFile(p, "utf8").catch(() => null);
}

/** Seed/fixture files, a few levels deep. */
async function seedFiles(root: string) {
	const out: string[] = [];
	async function walk(dir: string, depth: number) {
		if (depth > 5 || out.length >= 80) return;
		const entries = await fs
			.readdir(dir, { withFileTypes: true })
			.catch(() => []);
		for (const e of entries) {
			if (e.name.startsWith(".") && e.name !== ".dev") continue;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
			} else if (
				/seed|fixture/i.test(path.relative(root, full)) &&
				/\.(ts|js|mjs|cjs|sql|php|rb|py|json|ya?ml)$/.test(e.name) &&
				!/factor(y|ies)/i.test(full)
			) {
				out.push(full);
			}
		}
	}
	await walk(root, 0);
	return out;
}

const EMAIL =
	/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const ROLE_WORDS =
	/admin|owner|manager|staff|super|member|user|customer|trainer|coach|teacher|student|test|demo|dev/i;

function titleCase(s: string) {
	return s
		.split(/[._+-]+/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(" ");
}

/** Emails that look like dev accounts, from seed files. */
export async function findSeedPersonas(
	root: string,
	limit = 6,
): Promise<Persona[]> {
	const found = new Map<string, string>();
	for (const file of await seedFiles(root)) {
		const stat = await fs.stat(file).catch(() => null);
		if (!stat || stat.size > 512 * 1024) continue;
		const text = (await read(file)) ?? "";
		for (const m of text.matchAll(EMAIL)) {
			const email = m[0].toLowerCase();
			if (/noreply|no-reply|@(sentry|github|users\.noreply)/.test(email))
				continue;
			if (!found.has(email)) found.set(email, path.relative(root, file));
		}
	}
	const emails = [...found.keys()].sort(
		(a, b) =>
			Number(ROLE_WORDS.test(b.split("@")[0])) -
			Number(ROLE_WORDS.test(a.split("@")[0])),
	);
	const used = new Set<string>();
	return emails.slice(0, limit).map((email) => {
		const local = email.split("@")[0].replace(/\+.*/, "");
		let key = local.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "user";
		while (used.has(key)) key = `${key}-2`;
		used.add(key);
		return {
			key,
			label: titleCase(local),
			user: email,
			source: found.get(email),
		};
	});
}

type Pkg = {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

async function readPkg(root: string): Promise<Record<string, string>> {
	const text = await read(path.join(root, "package.json"));
	if (!text) return {};
	try {
		const pkg = JSON.parse(text) as Pkg;
		return { ...pkg.dependencies, ...pkg.devDependencies };
	} catch {
		return {};
	}
}

function mainUrl(project: ValidProject) {
	return (
		project.config.url ??
		Object.values(project.config.services ?? {}).find((s) => s.url)?.url ??
		"http://localhost:3000"
	);
}

function endpointOn(project: ValidProject, route: string) {
	return new URL(route, mainUrl(project)).toString();
}

async function planFile(
	root: string,
	rel: string,
	content: string,
): Promise<PlannedFile> {
	return {
		path: rel,
		content,
		mode: "create",
		skip: await exists(path.join(root, rel)),
	};
}

async function planAppend(
	root: string,
	rel: string,
	block: string,
	marker: string,
): Promise<PlannedFile> {
	const current = await read(path.join(root, rel));
	return {
		path: rel,
		content: block,
		mode: "append",
		skip: current === null || current.includes(marker),
	};
}

async function planEnv(root: string, file: string): Promise<SetupPlan["env"]> {
	const line = `DEVHUB_PUBLIC_KEY=${await publicKeyEnvValue()}`;
	const current = (await read(path.join(root, file))) ?? "";
	return { file, line, skip: /^\s*DEVHUB_PUBLIC_KEY\s*=/m.test(current) };
}

// ------------------------------------------------------------- stack plans

async function laravelPlan(
	project: ValidProject,
	base: Omit<
		SetupPlan,
		"stack" | "automatic" | "magicLogin" | "files" | "env" | "steps"
	>,
): Promise<SetupPlan> {
	const root = project.root;
	const controller = laravelController
		.replace("config('services.devhub.public_key')", "env('DEVHUB_PUBLIC_KEY')")
		.replace(
			"config('services.devhub.public_key'),",
			"env('DEVHUB_PUBLIC_KEY'),",
		)
		.replace("config('services.devhub.project'),", `'${project.id}',`)
		.replace(
			/ \* Register it ONLY[\s\S]*?\*\/\n/,
			" * Registered in routes/web.php by Local Dev Hub (local environment only).\n */\n",
		);
	const routeBlock = `
// Local Dev Hub Magic Login: exists only in the local environment with a key set.
if (app()->environment('local') && env('DEVHUB_PUBLIC_KEY')) {
    Route::get('/__devhub/login', \\App\\Http\\Controllers\\DevhubLoginController::class);
}
`;
	const routes = await planAppend(
		root,
		"routes/web.php",
		routeBlock,
		"__devhub/login",
	);
	return {
		...base,
		stack: "Laravel",
		automatic: true,
		magicLogin: {
			provider: "endpoint",
			endpoint: endpointOn(project, "/__devhub/login"),
			redirect: "/",
		},
		files: [
			await planFile(root, "app/Support/Devhub/DevhubToken.php", laravelToken),
			await planFile(
				root,
				"app/Http/Controllers/DevhubLoginController.php",
				controller,
			),
			routes,
		],
		env: await planEnv(root, ".env"),
		steps: [
			"Needs ext-sodium (bundled with PHP 7.2+) and users looked up by `email` on App\\Models\\User.",
			...(routes.skip &&
			!(await read(path.join(root, "routes/web.php")))?.includes(
				"__devhub/login",
			)
				? ["routes/web.php not found: register GET /__devhub/login yourself."]
				: []),
		],
	};
}

async function nextPlan(
	project: ValidProject,
	deps: Record<string, string>,
	base: Omit<
		SetupPlan,
		"stack" | "automatic" | "magicLogin" | "files" | "env" | "steps"
	>,
): Promise<SetupPlan> {
	const root = project.root;
	const src = (await exists(path.join(root, "src", "app"))) ? "src/" : "";
	const routeRel = `${src}app/api/devhub/login/route.ts`;
	const libRel = `${src}lib/devhub-magic-login.ts`;
	const tsconfig = (await read(path.join(root, "tsconfig.json"))) ?? "";
	const importPath = /"@\/\*"/.test(tsconfig)
		? "@/lib/devhub-magic-login"
		: path
				.relative(
					path.dirname(path.join(root, routeRel)),
					path.join(root, libRel),
				)
				.replace(/\.ts$/, "")
				.replace(/\\/g, "/");
	const hasAuthJs = "next-auth" in deps || "@auth/core" in deps;
	const hasPrisma = "@prisma/client" in deps;
	const findUser = hasPrisma
		? `	const { PrismaClient } = await import("@prisma/client");
	const db = new PrismaClient();
	try {
		return await db.user.findUnique({ where: { email: claims.sub } });
	} finally {
		await db.$disconnect();
	}`
		: `	// TODO: look up the user by email with your database client, e.g.
	// return db.query.users.findFirst({ where: eq(users.email, claims.sub) });
	throw new Error(\`Implement findUser() in ${routeRel} for \${claims.sub}\`);`;
	const startSession = hasAuthJs
		? `	// Auth.js (NextAuth) with the default JWT session strategy.
	const { encode } = await import("next-auth/jwt");
	const cookie = "authjs.session-token";
	const token = await encode({
		token: { sub: String(user.id), email: user.email, name: user.name ?? undefined },
		secret: (process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET) as string,
		salt: cookie,
		maxAge: 60 * 60 * 24 * 30,
	});
	res.cookies.set(cookie, token, { httpOnly: true, sameSite: "lax", path: "/" });`
		: `	// TODO: create a session the way your password login does and set its cookie on \`res\`.
	throw new Error(\`Implement startSession() in ${routeRel} for \${user.email} (\${res.status})\`);`;
	const route = `/**
 * Local Dev Hub Magic Login (generated). Answers 404 unless NODE_ENV=development
 * and DEVHUB_PUBLIC_KEY is set, so it never works in production builds.
 */
import { type NextRequest, NextResponse } from "next/server";
import {
	createUsedTokenStore,
	type DevhubClaims,
	isDevhubLoginEnabled,
	safeRedirect,
	verifyDevhubToken,
} from "${importPath}";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const usedTokens = createUsedTokenStore();

type User = { id: string | number; email: string; name?: string | null };

async function findUser(claims: DevhubClaims): Promise<User | null> {
${findUser}
}

async function startSession(user: User, res: NextResponse) {
${startSession}
}

export async function GET(req: NextRequest) {
	if (!isDevhubLoginEnabled()) return new NextResponse("Not found", { status: 404 });
	let claims: DevhubClaims;
	try {
		claims = verifyDevhubToken(req.nextUrl.searchParams.get("token") ?? "", {
			publicKey: process.env.DEVHUB_PUBLIC_KEY as string,
			audience: "${project.id}",
		});
	} catch (err) {
		return new NextResponse(\`Magic Login failed: \${(err as Error).message}\`, { status: 401 });
	}
	if (!usedTokens.claim(claims)) return new NextResponse("Magic Login failed: token already used", { status: 401 });
	const user = await findUser(claims);
	if (!user) return new NextResponse(\`No user \${claims.sub}\`, { status: 404 });
	const res = NextResponse.redirect(new URL(safeRedirect(claims.redirect), req.url));
	await startSession(user, res);
	return res;
}
`;
	const automatic = hasAuthJs && hasPrisma;
	return {
		...base,
		stack: `Next.js${hasAuthJs ? " + Auth.js" : ""}${hasPrisma ? " + Prisma" : ""}`,
		automatic,
		magicLogin: {
			provider: "endpoint",
			endpoint: endpointOn(project, "/api/devhub/login"),
			redirect: "/",
		},
		files: [
			await planFile(root, libRel, nodeVerifier),
			await planFile(root, routeRel, route),
		],
		env: await planEnv(root, ".env.development.local"),
		steps: automatic
			? [
					"Assumes Auth.js' default JWT sessions. With database sessions, adapt startSession() in the generated route.",
				]
			: [
					`Fill in ${hasPrisma ? "" : "findUser() and "}${hasAuthJs ? "" : "startSession() "}in ${routeRel} (marked TODO).`,
				],
	};
}

// ------------------------------------------------------------- entry points

export async function planMagicLogin(
	project: ValidProject,
): Promise<SetupPlan> {
	const root = project.root;
	const deps = await readPkg(root);
	const existing = Object.entries(project.config.personas ?? {}).map(
		([key, p]) => ({ key, label: p.label, user: p.user }),
	);
	const personas = existing.length ? existing : await findSeedPersonas(root);
	const notes = personas.length
		? existing.length
			? ["Using the personas already in .dev/project.yaml."]
			: [
					`Found ${personas.length} account(s) in seed files. Edit them if they aren't dev users.`,
				]
		: [
				"No accounts found in seed files: add the emails of your dev users below.",
			];
	const base = { personas, notes };

	if (await exists(path.join(root, "artisan")))
		return laravelPlan(project, base);

	const usesSupabase =
		"@supabase/supabase-js" in deps ||
		"@supabase/ssr" in deps ||
		(await exists(path.join(root, "supabase", "config.toml")));
	if (usesSupabase) {
		return {
			...base,
			stack: "Supabase Auth",
			automatic: true,
			magicLogin: { provider: "supabase", redirect: "/" },
			files: [],
			env: null,
			steps: [
				"Keep your local Supabase running (`supabase start`). The hub asks it for a one-time magic link, so the app needs no code.",
				"Only a local Supabase is accepted; hosted projects are refused on purpose.",
			],
		};
	}

	if ("next" in deps) return nextPlan(project, deps, base);

	if (await exists(path.join(root, "manage.py"))) {
		return {
			...base,
			stack: "Django",
			automatic: false,
			magicLogin: {
				provider: "endpoint",
				endpoint: endpointOn(project, "/__devhub/login"),
				redirect: "/",
			},
			files: [
				await planFile(root, "devhub_login/__init__.py", ""),
				await planFile(root, "devhub_login/devhub_token.py", djangoToken),
				await planFile(root, "devhub_login/views.py", djangoView),
			],
			env: await planEnv(root, ".env"),
			steps: [
				`settings.py: DEVHUB_PUBLIC_KEY = os.environ.get("DEVHUB_PUBLIC_KEY", "") and DEVHUB_PROJECT = "${project.id}"`,
				'urls.py: if settings.DEBUG: urlpatterns += [path("__devhub/login", devhub_login)] (from devhub_login.views import devhub_login)',
				"pip install cryptography",
			],
		};
	}

	if (await exists(path.join(root, "bin", "rails"))) {
		const gemfile = (await read(path.join(root, "Gemfile"))) ?? "";
		const devise = /gem ["']devise["']/.test(gemfile);
		const routes = await planAppendBeforeEnd(root, "config/routes.rb");
		return {
			...base,
			stack: `Rails${devise ? " + Devise" : ""}`,
			automatic: devise && !routes.skip,
			magicLogin: {
				provider: "endpoint",
				endpoint: endpointOn(project, "/__devhub/login"),
				redirect: "/",
			},
			files: [
				await planFile(root, "lib/devhub_token.rb", railsToken),
				await planFile(
					root,
					"app/controllers/devhub_login_controller.rb",
					railsController.replace(
						'PROJECT_ID = "fitbase"',
						`PROJECT_ID = "${project.id}"`,
					),
				),
				routes,
			],
			env: await planEnv(root, ".env"),
			steps: devise
				? []
				: [
						"The controller calls Devise's sign_in(user); change it to how your app starts a session.",
					],
		};
	}

	const nodeServer = ["express", "fastify", "hono", "koa", "@nestjs/core"].find(
		(d) => d in deps,
	);
	const ts = "typescript" in deps;
	return {
		...base,
		stack: nodeServer ? `Node (${nodeServer})` : "Unknown",
		automatic: false,
		magicLogin: {
			provider: "endpoint",
			endpoint: endpointOn(project, "/__devhub/login"),
			redirect: "/",
		},
		files:
			nodeServer && ts
				? [await planFile(root, "src/devhub-magic-login.ts", nodeVerifier)]
				: [],
		env: nodeServer ? await planEnv(root, ".env") : null,
		steps: nodeServer
			? [
					`Mount GET /__devhub/login in your ${nodeServer} server: verify with verifyDevhubToken(token, { publicKey: process.env.DEVHUB_PUBLIC_KEY, audience: "${project.id}" }), then log the user in the way your password login does. See the usage comment at the top of ${ts ? "src/devhub-magic-login.ts" : "adapters/node/devhub-magic-login.ts in the hub repo"}.`,
				]
			: [
					"Couldn't tell how this app signs users in. If it's a frontend talking to a separate API, set up Magic Login on that API's project instead (the adapters in the hub's adapters/ folder cover Node, Next.js, Laravel, Django and Rails).",
				],
	};
}

async function planAppendBeforeEnd(
	root: string,
	rel: string,
): Promise<PlannedFile> {
	const block = `  # Local Dev Hub Magic Login (development only)
  if Rails.env.development? && ENV["DEVHUB_PUBLIC_KEY"].present?
    get "/__devhub/login", to: "devhub_login#create"
  end
`;
	const current = await read(path.join(root, rel));
	return {
		path: rel,
		content: block,
		mode: "append",
		skip: current === null || current.includes("__devhub/login"),
	};
}

export async function applyMagicLogin(
	project: ValidProject,
	personas: Persona[],
) {
	const plan = await planMagicLogin(project);
	const written: string[] = [];
	for (const f of plan.files) {
		if (f.skip) continue;
		const abs = path.join(project.root, f.path);
		if (f.mode === "create") {
			await fs.mkdir(path.dirname(abs), { recursive: true });
			await fs
				.writeFile(abs, f.content, { flag: "wx" })
				.catch((err: NodeJS.ErrnoException) => {
					if (err.code !== "EEXIST") throw err;
				});
		} else if (f.path.endsWith("routes.rb")) {
			const text = await fs.readFile(abs, "utf8");
			const at = text.lastIndexOf("\nend");
			await fs.writeFile(
				abs,
				at >= 0
					? `${text.slice(0, at + 1)}${f.content}${text.slice(at + 1)}`
					: text + f.content,
			);
		} else {
			await fs.appendFile(abs, f.content);
		}
		written.push(f.path);
	}
	if (plan.env && !plan.env.skip) {
		const abs = path.join(project.root, plan.env.file);
		const current = (await read(abs)) ?? "";
		const sep = current && !current.endsWith("\n") ? "\n" : "";
		await fs.appendFile(
			abs,
			`${sep}# Local Dev Hub Magic Login (public key; safe to share, dev only)\n${plan.env.line}\n`,
		);
		written.push(plan.env.file);
	}

	const file = path.join(project.root, PROJECT_FILE);
	const doc = YAML.parseDocument(await fs.readFile(file, "utf8"));
	const clean = personas
		.map((p) => ({
			...p,
			key: p.key.trim(),
			user: p.user.trim(),
			label: p.label.trim() || p.user,
		}))
		.filter((p) => p.key && p.user);
	if (clean.length) {
		doc.setIn(
			["personas"],
			Object.fromEntries(
				clean.map((p) => [p.key, { label: p.label, user: p.user }]),
			),
		);
	}
	const ml: Record<string, string> = {};
	if (plan.magicLogin.provider === "supabase") ml.provider = "supabase";
	if (plan.magicLogin.endpoint) ml.endpoint = plan.magicLogin.endpoint;
	ml.redirect = plan.magicLogin.redirect;
	doc.setIn(["magicLogin"], ml);
	await fs.writeFile(file, doc.toString());
	written.push(PROJECT_FILE);
	return {
		written,
		stack: plan.stack,
		automatic: plan.automatic,
		steps: plan.steps,
	};
}
