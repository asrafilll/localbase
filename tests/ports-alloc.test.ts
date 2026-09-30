import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { detectProject } from "#/server/detect";
import {
	nextFreePort,
	nodeCommandForPort,
	retargetCommand,
} from "#/server/portalloc";

function tmpdir(prefix: string) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("port allocation", () => {
	it("picks the next free port", () => {
		expect(
			nextFreePort(
				3000,
				new Map([
					[3001, "x"],
					[3002, "y"],
				]),
			),
		).toBe(3003);
		expect(nextFreePort(3000, new Set<number>())).toBe(3001);
	});

	it("rewrites a script that hard-codes the port, adding --strictPort for Vite", () => {
		expect(
			nodeCommandForPort({
				pm: "npm",
				framework: "Vite",
				scriptName: "dev",
				script: "vite dev --port 3000",
				port: 3001,
			}),
		).toEqual({
			command: "npx --no-install vite dev --port 3001 --strictPort",
		});
		expect(
			nodeCommandForPort({
				pm: "pnpm",
				framework: "Next.js",
				scriptName: "dev",
				script: "next dev -p 3000",
				port: 3002,
			}),
		).toEqual({ command: "pnpm exec next dev -p 3002" });
	});

	it("appends the framework's port flag when the script has none", () => {
		expect(
			nodeCommandForPort({
				pm: "npm",
				framework: "Next.js",
				scriptName: "dev",
				script: "next dev",
				port: 3001,
			}),
		).toEqual({
			command: "npm run dev -- -p 3001",
		});
		expect(
			nodeCommandForPort({
				pm: "pnpm",
				framework: "Vite",
				scriptName: "dev",
				script: "vite",
				port: 5174,
			}),
		).toEqual({
			command: "pnpm dev --port 5174 --strictPort",
		});
	});

	it("falls back to PORT for unknown servers and refuses compound scripts", () => {
		expect(
			nodeCommandForPort({
				pm: "yarn",
				framework: "Express",
				scriptName: "dev",
				script: "tsx watch src",
				port: 4001,
			}),
		).toEqual({
			command: "yarn dev",
			env: { PORT: "4001" },
		});
		expect(
			nodeCommandForPort({
				pm: "npm",
				framework: "Vite",
				scriptName: "dev",
				script: "concurrently 'vite --port 3000' 'tsx api' && echo",
				port: 3001,
			}),
		).toBeNull();
		expect(
			retargetCommand(
				"docker compose up -d && pnpm exec vite --port 3000",
				3005,
			),
		).toBe("docker compose up -d && pnpm exec vite --port 3005");
		expect(retargetCommand("pnpm dev", 3005)).toBeNull();
	});

	it("gives a newly detected project a free port when its usual one is taken", async () => {
		const root = tmpdir("alloc-");
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({
				name: "etb-iot",
				scripts: { dev: "vite dev --port 3000" },
				devDependencies: { vite: "8" },
			}),
		);
		const { config, notes } = await detectProject(
			root,
			undefined,
			new Map([[3000, "panda-swim"]]),
		);
		expect(config.services?.web?.url).toBe("http://localhost:3001");
		expect(config.commands?.start?.command).toBe(
			"npx --no-install vite dev --port 3001 --strictPort",
		);
		expect(notes.join(" ")).toContain("port 3000 is used by panda-swim");
		// Without a clash nothing changes.
		const free = await detectProject(root);
		expect(free.config.services?.web?.url).toBe("http://localhost:3000");
		expect(free.config.commands?.start?.command).toBe("npm run dev");
	});
});

describe("reassign port of an existing project", () => {
	it("moves the web service, start command and magic login endpoint, keeping comments", async () => {
		process.env.DEVHUB_HOME = tmpdir("devhub-reassign-home-");
		const a = tmpdir("panda-");
		const b = tmpdir("etb-");
		fs.mkdirSync(path.join(a, ".dev"));
		fs.mkdirSync(path.join(b, ".dev"));
		fs.writeFileSync(
			path.join(a, ".dev/project.yaml"),
			YAML.stringify({
				name: "panda-swim",
				services: { web: { kind: "web", url: "http://localhost:3000" } },
			}),
		);
		fs.writeFileSync(
			path.join(b, "package.json"),
			JSON.stringify({
				scripts: { dev: "vite dev --port 3000" },
				devDependencies: { vite: "8" },
			}),
		);
		fs.writeFileSync(
			path.join(b, ".dev/project.yaml"),
			`# my notes stay\nname: etb-iot\nservices:\n  web:\n    kind: web\n    url: http://localhost:3000 # main app\nmagicLogin:\n  endpoint: http://localhost:3000/__devhub/login\ncommands:\n  start:\n    command: npm run dev\n    longRunning: true\n`,
		);
		const { addProjectRoot, getValidProject } = await import(
			"#/server/registry"
		);
		await addProjectRoot(a);
		await addProjectRoot(b);
		const { reassignPort } = await import("#/server/reassign");
		const res = await reassignPort(await getValidProject("etb-iot"));
		expect(res).toMatchObject({ from: 3000, usedBy: "panda-swim" });
		expect(res.to).toBeGreaterThan(3000);
		const text = fs.readFileSync(path.join(b, ".dev/project.yaml"), "utf8");
		expect(text).toContain("# my notes stay");
		expect(text).toContain("# main app");
		const yaml = YAML.parse(text);
		expect(yaml.services.web.url).toBe(`http://localhost:${res.to}`);
		expect(yaml.magicLogin.endpoint).toBe(
			`http://localhost:${res.to}/__devhub/login`,
		);
		expect(yaml.commands.start).toEqual({
			command: `npx --no-install vite dev --port ${res.to} --strictPort`,
			longRunning: true,
		});
	});
});
