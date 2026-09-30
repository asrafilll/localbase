import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { projectFileSchema } from "#/server/schema";

function tmpdir(prefix: string) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root: string, rel: string, content: string) {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), content);
}

async function register(root: string, name: string) {
	const { addProjectRoot, getValidProject } = await import("#/server/registry");
	await addProjectRoot(root);
	return getValidProject(name);
}

describe("seed personas", () => {
	it("finds dev accounts in seed files, role-like addresses first", async () => {
		const { findSeedPersonas } = await import("#/server/magic-setup");
		const root = tmpdir("seeds-");
		write(
			root,
			"database/seeders/UserSeeder.php",
			`User::create(['email' => 'jane.doe@example.com']);\nUser::create(['email' => 'admin@example.com']);`,
		);
		write(
			root,
			"database/factories/UserFactory.php",
			"'email' => 'factory@example.com'",
		);
		write(root, "node_modules/x/seed.js", "'dep@example.com'");
		const personas = await findSeedPersonas(root);
		expect(personas.map((p) => p.user)).toEqual([
			"admin@example.com",
			"jane.doe@example.com",
		]);
		expect(personas[0]).toMatchObject({ key: "admin", label: "Admin" });
		expect(personas[1]).toMatchObject({ key: "jane-doe", label: "Jane Doe" });
	});
});

describe("Magic Login setup", () => {
	it("sets up a Laravel app end to end and is idempotent", async () => {
		process.env.DEVHUB_HOME = tmpdir("devhub-setup-home-");
		const root = tmpdir("laravel-");
		write(root, "artisan", "#!/usr/bin/env php");
		write(
			root,
			"routes/web.php",
			"<?php\n\nRoute::get('/', fn () => view('welcome'));\n",
		);
		write(root, ".env", "APP_ENV=local");
		write(
			root,
			"database/seeders/DatabaseSeeder.php",
			"'email' => 'owner@gym.test'",
		);
		write(
			root,
			".dev/project.yaml",
			"# keep me\nname: gym\nservices:\n  web:\n    kind: web\n    url: http://localhost:8000\n",
		);
		const { planMagicLogin, applyMagicLogin } = await import(
			"#/server/magic-setup"
		);
		const project = await register(root, "gym");

		const plan = await planMagicLogin(project);
		expect(plan).toMatchObject({ stack: "Laravel", automatic: true });
		expect(plan.magicLogin.endpoint).toBe(
			"http://localhost:8000/__devhub/login",
		);
		expect(plan.personas).toEqual([
			expect.objectContaining({ user: "owner@gym.test" }),
		]);
		expect(plan.files.every((f) => !f.skip)).toBe(true);

		const res = await applyMagicLogin(project, [
			{ key: "owner", label: "Owner", user: "owner@gym.test" },
		]);
		expect(res.written).toContain(
			"app/Http/Controllers/DevhubLoginController.php",
		);
		const controller = fs.readFileSync(
			path.join(root, "app/Http/Controllers/DevhubLoginController.php"),
			"utf8",
		);
		expect(controller).toContain("env('DEVHUB_PUBLIC_KEY')");
		expect(controller).toContain("'gym'");
		const routes = fs.readFileSync(path.join(root, "routes/web.php"), "utf8");
		expect(routes).toContain("app()->environment('local')");
		const env = fs.readFileSync(path.join(root, ".env"), "utf8");
		expect(env).toMatch(
			/^APP_ENV=local\n# Local Dev Hub.*\nDEVHUB_PUBLIC_KEY=\S+\n$/,
		);

		const yamlText = fs.readFileSync(
			path.join(root, ".dev/project.yaml"),
			"utf8",
		);
		expect(yamlText).toContain("# keep me");
		const config = projectFileSchema.parse(YAML.parse(yamlText));
		expect(config.personas?.owner).toMatchObject({ user: "owner@gym.test" });
		expect(config.magicLogin?.endpoint).toBe(
			"http://localhost:8000/__devhub/login",
		);

		// Running it again changes nothing in the app.
		const { getValidProject } = await import("#/server/registry");
		const again = await planMagicLogin(await getValidProject("gym"));
		expect(again.files.every((f) => f.skip)).toBe(true);
		expect(again.env?.skip).toBe(true);
		await applyMagicLogin(await getValidProject("gym"), again.personas);
		expect(fs.readFileSync(path.join(root, "routes/web.php"), "utf8")).toBe(
			routes,
		);
		expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe(env);
	});

	it("uses the Supabase provider (no files) for Supabase apps", async () => {
		process.env.DEVHUB_HOME = tmpdir("devhub-setup-home-");
		const root = tmpdir("supa-");
		write(
			root,
			"package.json",
			JSON.stringify({
				dependencies: { "@supabase/supabase-js": "2", vite: "8" },
			}),
		);
		write(
			root,
			".dev/project.yaml",
			"name: swim\nurl: http://localhost:3000\n",
		);
		const { planMagicLogin, applyMagicLogin } = await import(
			"#/server/magic-setup"
		);
		const project = await register(root, "swim");
		const plan = await planMagicLogin(project);
		expect(plan).toMatchObject({
			stack: "Supabase Auth",
			automatic: true,
			files: [],
			env: null,
		});
		await applyMagicLogin(project, [
			{ key: "coach", label: "Coach", user: "coach@swim.test" },
		]);
		const config = projectFileSchema.parse(
			YAML.parse(fs.readFileSync(path.join(root, ".dev/project.yaml"), "utf8")),
		);
		expect(config.magicLogin).toEqual({ provider: "supabase", redirect: "/" });
	});

	it("requires an endpoint unless the provider is supabase", () => {
		expect(
			projectFileSchema.safeParse({ name: "x", magicLogin: { redirect: "/" } })
				.success,
		).toBe(false);
		expect(
			projectFileSchema.safeParse({
				name: "x",
				magicLogin: { provider: "supabase" },
			}).success,
		).toBe(true);
	});
});

describe("Supabase magic links", () => {
	it("asks the local GoTrue admin API for a magic link", async () => {
		let seen: { auth?: string; body?: unknown } = {};
		const server = http.createServer((req, res) => {
			let body = "";
			req.on("data", (c) => {
				body += c;
			});
			req.on("end", () => {
				seen = { auth: req.headers.authorization, body: JSON.parse(body) };
				expect(req.url).toBe("/auth/v1/admin/generate_link");
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						action_link: "http://127.0.0.1:54321/auth/v1/verify?token=abc",
					}),
				);
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as { port: number }).port;
		const root = tmpdir("supa-link-");
		write(
			root,
			".env",
			`VITE_SUPABASE_URL=http://127.0.0.1:${port}\nSUPABASE_SERVICE_ROLE_KEY=service-key\n`,
		);
		try {
			const { supabaseMagicLink } = await import("#/server/supabase");
			const link = await supabaseMagicLink(
				root,
				"coach@swim.test",
				"http://localhost:3000/",
			);
			expect(link).toContain("/auth/v1/verify");
			expect(seen.auth).toBe("Bearer service-key");
			expect(seen.body).toEqual({
				type: "magiclink",
				email: "coach@swim.test",
				redirect_to: "http://localhost:3000/",
			});
		} finally {
			server.close();
		}
	});

	it("refuses a hosted Supabase", async () => {
		const root = tmpdir("supa-remote-");
		write(
			root,
			".env",
			"SUPABASE_URL=https://abc.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=k\n",
		);
		const { supabaseCredentials } = await import("#/server/supabase");
		const env = { ...process.env };
		process.env.PATH = "/nonexistent"; // no `supabase` CLI to fall back on
		try {
			await expect(supabaseCredentials(root)).rejects.toThrow(/not local/);
		} finally {
			process.env.PATH = env.PATH;
		}
	});
});
