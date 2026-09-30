import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { detectProject, portFromScript, toYaml } from "#/server/detect";
import { checkEnv, parseEnvKeys, readEnvValue } from "#/server/envcheck";
import { parseDockerMem, parseProcTable, sumUsage } from "#/server/resources";
import { projectFileSchema } from "#/server/schema";

function tmpdir(prefix: string) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root: string, files: Record<string, string>) {
	for (const [rel, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), text);
	}
}

describe("auto-detect", () => {
	it("reads ports from scripts", () => {
		expect(portFromScript("next dev -p 4000")).toBe(4000);
		expect(portFromScript("vite --port 5174")).toBe(5174);
		expect(portFromScript("vite --port=5175")).toBe(5175);
		expect(portFromScript("PORT=8080 node server.js")).toBe(8080);
		expect(portFromScript("vite")).toBeUndefined();
	});

	it("detects a Next.js app with pnpm and docker compose", async () => {
		const root = tmpdir("detect-next-");
		write(root, {
			"package.json": JSON.stringify({
				name: "@acme/fitbase",
				description: "Gym SaaS",
				scripts: {
					dev: "next dev -p 3100",
					test: "vitest",
					"db:seed": "tsx seed.ts",
				},
				dependencies: { next: "15", react: "19" },
				devDependencies: { typescript: "5", prisma: "6" },
			}),
			"pnpm-lock.yaml": "",
			"docker-compose.yml": YAML.stringify({
				services: {
					db: {
						image: "postgres:16",
						ports: ["5432:5432"],
						container_name: "fitbase-db",
					},
					mail: { image: "axllent/mailpit", ports: ["1025:1025", "8025:8025"] },
					app: { build: "." },
				},
			}),
			".env": "DATABASE_URL=postgres://u:p@localhost:5432/fitbase\n",
		});
		const { config, notes } = await detectProject(root);
		expect(config.name).toBe("fitbase");
		expect(config.description).toBe("Gym SaaS");
		expect(config.services?.web?.url).toBe("http://localhost:3100");
		expect(config.services?.db).toMatchObject({
			kind: "database",
			port: 5432,
			container: "fitbase-db",
		});
		expect(config.services?.mail).toMatchObject({
			kind: "mail",
			url: "http://localhost:8025",
		});
		expect(config.services?.app).toBeUndefined();
		expect(config.commands?.start).toEqual({
			command: "docker compose up -d && pnpm dev",
			longRunning: true,
		});
		expect(config.commands?.seed?.command).toBe("pnpm db:seed");
		expect(config.commands?.test?.command).toBe("pnpm test");
		expect(config.database).toEqual({
			type: "postgres",
			urlEnv: "DATABASE_URL",
		});
		expect(config.stack).toEqual(
			expect.arrayContaining([
				"Next.js",
				"React",
				"TypeScript",
				"Prisma",
				"Docker",
				"PostgreSQL",
			]),
		);
		expect(notes.join(" ")).toContain("pnpm");
		// The generated YAML must be a valid project file and must not contain secrets.
		const yaml = toYaml({ config, notes });
		expect(projectFileSchema.safeParse(YAML.parse(yaml)).success).toBe(true);
		expect(yaml).not.toContain("u:p@");
	});

	it("detects Laravel with env-interpolated database URL", async () => {
		const root = tmpdir("detect-laravel-");
		write(root, {
			artisan: "",
			"composer.json": JSON.stringify({
				name: "acme/gym",
				scripts: { dev: "..." },
			}),
			"package.json": JSON.stringify({
				scripts: { dev: "vite" },
				devDependencies: { vite: "6" },
			}),
			".env":
				"APP_URL=http://gym.test\nDB_CONNECTION=pgsql\nDB_HOST=127.0.0.1\nDB_PORT=5433\nDB_DATABASE=gym\nDB_USERNAME=gym\nDB_PASSWORD=s3cret\n",
		});
		const { config } = await detectProject(root);
		expect(config.name).toBe("gym");
		expect(config.services?.web?.url).toBe("http://gym.test");
		expect(config.services?.database?.port).toBe(5433);
		expect(config.commands?.start?.command).toBe("composer run dev");
		expect(config.commands?.["reset-db"]?.command).toBe(
			"php artisan migrate:fresh --seed",
		);
		expect(config.database?.type).toBe("postgres");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} placeholders are the feature under test
		expect(config.database?.url).toContain("${DB_PASSWORD}");
		expect(toYaml({ config, notes: [] })).not.toContain("s3cret");
	});

	it("prefers the observed port and handles empty folders", async () => {
		const vite = tmpdir("detect-vite-");
		write(vite, {
			"package.json": JSON.stringify({
				scripts: { dev: "vite" },
				devDependencies: { vite: "6" },
			}),
		});
		expect((await detectProject(vite, 5180)).config.services?.web?.url).toBe(
			"http://localhost:5180",
		);
		const empty = tmpdir("detect-empty-");
		const d = await detectProject(empty);
		expect(d.config.name).toBe(path.basename(empty));
		expect(d.notes[0]).toContain("nothing recognised");
	});

	it("finds monorepo apps", async () => {
		const root = tmpdir("detect-mono-");
		write(root, {
			"package.json": JSON.stringify({ name: "mono", workspaces: ["apps/*"] }),
			"apps/web/package.json": JSON.stringify({
				scripts: { dev: "next dev" },
				dependencies: { next: "15" },
			}),
			"apps/api/package.json": JSON.stringify({
				scripts: { dev: "tsx watch src -- --port 4000" },
				dependencies: { hono: "4" },
			}),
		});
		const { config } = await detectProject(root);
		expect(config.commands?.["dev-web"]).toMatchObject({
			cwd: "apps/web",
			longRunning: true,
		});
		expect(config.services?.web?.url).toBe("http://localhost:3000");
		expect(config.services?.api).toMatchObject({
			kind: "api",
			url: "http://localhost:4000",
		});
	});
});

describe(".env check", () => {
	it("lists missing keys without reading values into the result", async () => {
		const root = tmpdir("env-");
		write(root, {
			".env.example":
				"# comment\nAPP_KEY=\nexport DATABASE_URL=postgres://x\nSTRIPE_KEY=\n",
			".env": "APP_KEY=secret-value\n",
			"api/.env.example": "API_TOKEN=\n",
		});
		expect([...parseEnvKeys("A=1\n # B=2\nexport C=3\n")]).toEqual(["A", "C"]);
		const result = await checkEnv(root, ["api"]);
		expect(result).toEqual([
			{
				dir: ".",
				template: ".env.example",
				hasEnv: true,
				missing: ["DATABASE_URL", "STRIPE_KEY"],
			},
			{
				dir: "api",
				template: ".env.example",
				hasEnv: false,
				missing: ["API_TOKEN"],
			},
		]);
		expect(JSON.stringify(result)).not.toContain("secret-value");
		expect(await readEnvValue(root, "APP_KEY")).toBe("secret-value");
	});
});

describe("resource usage", () => {
	it("sums a process tree and process groups", () => {
		const procs = parseProcTable(
			[
				"  10  1  10  1000  1.0",
				"  11 10  10  2000  2.5",
				"  12 11  12  3000  0.5",
				"  20  1  20  4000  9.0",
				"  30  1  30  500  0.0",
			].join("\n"),
		);
		expect(sumUsage(procs, [11], [])).toMatchObject({
			processes: 2,
			memoryMb: 5000 / 1024,
		});
		const both = sumUsage(procs, [20], [10]);
		expect(both.processes).toBe(4);
		expect(both.cpu).toBeCloseTo(13);
	});

	it("parses docker memory units", () => {
		expect(parseDockerMem("512MiB / 7.6GiB")).toBe(512);
		expect(parseDockerMem("1.5GiB / 7.6GiB")).toBe(1536);
		expect(parseDockerMem("800KiB / 1GiB")).toBeCloseTo(0.78, 1);
	});
});

describe("proxy", () => {
	let upstream: http.Server;
	let proxy: http.Server;
	let upstreamPort: number;
	let proxyPort: number;

	beforeAll(async () => {
		process.env.DEVHUB_HOME = tmpdir("devhub-proxy-home-");
		upstream = http.createServer((req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					path: req.url,
					host: req.headers.host,
					fwd: req.headers["x-forwarded-host"],
				}),
			);
		});
		upstream.on("upgrade", (_req, socket) => {
			socket.write(
				"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
			);
			socket.on("data", (d) => socket.write(`echo:${d}`));
		});
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
		upstreamPort = (upstream.address() as net.AddressInfo).port;

		const repo = tmpdir("proxy-repo-");
		write(repo, {
			".dev/project.yaml": YAML.stringify({
				id: "shop",
				name: "Shop",
				services: {
					web: { url: `http://localhost:${upstreamPort}` },
					api: { port: upstreamPort },
					docs: { url: "https://docs.example.com" },
				},
			}),
		});
		const { addProjectRoot } = await import("#/server/registry");
		await addProjectRoot(repo);
		const { createProxyServer } = await import("#/server/proxy");
		proxy = createProxyServer();
		await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
		proxyPort = (proxy.address() as net.AddressInfo).port;
	});

	afterAll(() => {
		proxy?.close();
		upstream?.close();
	});

	const get = (host: string, p = "/") =>
		new Promise<{ status: number; body: string }>((resolve, reject) => {
			http
				.get(
					{ host: "127.0.0.1", port: proxyPort, path: p, headers: { host } },
					(res) => {
						let body = "";
						res.on("data", (d) => {
							body += d;
						});
						res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
					},
				)
				.on("error", reject);
		});

	it("routes <project>.localhost and <service>.<project>.localhost", async () => {
		const main = await get(`shop.localhost:${proxyPort}`, "/cart?x=1");
		expect(main.status).toBe(200);
		expect(JSON.parse(main.body)).toMatchObject({
			path: "/cart?x=1",
			fwd: `shop.localhost:${proxyPort}`,
		});
		expect((await get(`api.shop.localhost:${proxyPort}`)).status).toBe(200);
	});

	it("explains unknown projects and services", async () => {
		const unknown = await get(`nope.localhost:${proxyPort}`);
		expect(unknown.status).toBe(404);
		expect(unknown.body).toContain("No registered project");
		expect((await get(`docs.shop.localhost:${proxyPort}`)).body).toContain(
			"no service",
		);
		expect((await get(`evil.com:${proxyPort}`)).status).toBe(404);
	});

	it("proxies WebSocket upgrades (HMR)", async () => {
		const reply = await new Promise<string>((resolve, reject) => {
			const s = net.connect(proxyPort, "127.0.0.1", () => {
				s.write(
					`GET /hmr HTTP/1.1\r\nHost: shop.localhost:${proxyPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
				);
			});
			let data = "";
			s.on("data", (d) => {
				data += d;
				if (data.includes("101") && !data.includes("echo:")) s.write("ping");
				if (data.includes("echo:ping")) {
					s.end();
					resolve(data);
				}
			});
			s.on("error", reject);
		});
		expect(reply).toContain("101 Switching Protocols");
		expect(reply).toContain("echo:ping");
	});
});

describe("database snapshots", () => {
	it("saves and restores SQLite (file copy fallback)", async () => {
		process.env.DEVHUB_HOME = tmpdir("devhub-db-home-");
		const root = tmpdir("sqlite-repo-");
		write(root, { "database/database.sqlite": "v1" });
		const { saveSnapshot, restoreSnapshot, listSnapshots, deleteSnapshot } =
			await import("#/server/database");
		const project = {
			ok: true as const,
			id: "lite",
			root,
			config: { name: "Lite", database: { type: "sqlite" as const } },
		};
		await saveSnapshot(project, "clean");
		fs.writeFileSync(path.join(root, "database/database.sqlite"), "v2");
		fs.writeFileSync(path.join(root, "database/database.sqlite-wal"), "stale");
		await restoreSnapshot(project, "clean");
		expect(
			fs.readFileSync(path.join(root, "database/database.sqlite"), "utf8"),
		).toBe("v1");
		expect(fs.existsSync(path.join(root, "database/database.sqlite-wal"))).toBe(
			false,
		);
		expect((await listSnapshots("lite")).map((s) => s.name)).toEqual(["clean"]);
		await expect(saveSnapshot(project, "../escape")).rejects.toThrow(
			/Snapshot names/,
		);
		await deleteSnapshot(project, "clean");
		expect(await listSnapshots("lite")).toEqual([]);
	});

	it("refuses SQLite paths outside the repo", async () => {
		const { resolveDatabase } = await import("#/server/database");
		const project = {
			ok: true as const,
			id: "x",
			root: "/repo",
			config: {
				name: "X",
				database: { type: "sqlite" as const, path: "../../etc/passwd" },
			},
		};
		await expect(resolveDatabase(project)).rejects.toThrow(
			/inside the repository/,
		);
	});

	const pgBin = fs.existsSync("/usr/lib/postgresql")
		? path.join(
				"/usr/lib/postgresql",
				fs.readdirSync("/usr/lib/postgresql")[0] ?? "",
				"bin",
			)
		: "";
	const canRunPostgres =
		process.platform === "linux" &&
		fs.existsSync(path.join(pgBin, "initdb")) &&
		spawnSync("id", ["postgres"]).status === 0;

	it.runIf(canRunPostgres)(
		"saves and restores Postgres via pg_dump/psql, reading the password from .env",
		async () => {
			const data = tmpdir("pgdata-");
			fs.chmodSync(data, 0o777);
			// stdio must not be piped: the started server would hold the pipes open forever.
			const as = (cmd: string, args: string[]) =>
				execFileSync(
					"runuser",
					["-u", "postgres", "--", path.join(pgBin, cmd), ...args],
					{ stdio: "ignore" },
				);
			as("initdb", ["-D", `${data}/db`, "-A", "trust", "-U", "postgres"]);
			const port = String(55000 + Math.floor(Math.random() * 1000));
			as("pg_ctl", [
				"-D",
				`${data}/db`,
				"-l",
				`${data}/log`,
				"-o",
				`-p ${port} -k ${data} -c listen_addresses=127.0.0.1`,
				"-w",
				"start",
			]);
			try {
				const psql = (sql: string) =>
					execFileSync("psql", [
						"-h",
						"127.0.0.1",
						"-p",
						port,
						"-U",
						"postgres",
						"-d",
						"postgres",
						"-tAc",
						sql,
					])
						.toString()
						.trim();
				psql(
					"create table members (name text); insert into members values ('ada');",
				);
				const root = tmpdir("pg-repo-");
				write(root, { ".env": `DB_PASSWORD=unused\nDB_PORT=${port}\n` });
				const { saveSnapshot, restoreSnapshot } = await import(
					"#/server/database"
				);
				const project = {
					ok: true as const,
					id: "pg",
					root,
					config: {
						name: "PG",
						database: {
							type: "postgres" as const,
							// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} placeholders are the feature under test
							url: "postgres://postgres:${DB_PASSWORD}@127.0.0.1:${DB_PORT}/postgres",
						},
					},
				};
				await saveSnapshot(project, "one-member");
				psql("insert into members values ('mo'); create table extra (x int);");
				expect(psql("select count(*) from members")).toBe("2");
				await restoreSnapshot(project, "one-member");
				expect(psql("select string_agg(name, ',') from members")).toBe("ada");
			} finally {
				as("pg_ctl", ["-D", `${data}/db`, "-m", "immediate", "stop"]);
			}
		},
		60_000,
	);
});

describe("runner persistence", () => {
	it("re-attaches to a still-running command after a hub restart", async () => {
		process.env.DEVHUB_HOME = tmpdir("devhub-runner-home-");
		const root = tmpdir("runner-repo-");
		const project = {
			ok: true as const,
			id: "svc",
			root,
			config: {
				name: "Svc",
				commands: {
					serve: {
						command: "echo started; while true; do sleep 0.2; done",
						longRunning: true,
					},
					once: { command: "echo hello; echo world" },
				},
			},
		};
		const runner1 = await import("#/server/runner");
		const once = await runner1.startRun(project, "once");
		const finished = await runner1.waitForRun(once.id, 10_000);
		expect(finished.status).toBe("succeeded");
		expect(runner1.runLogTail(once.id)).toEqual([
			"$ echo hello; echo world",
			"hello",
			"world",
			"[devhub] exited with code 0",
		]);

		const serve = await runner1.startRun(project, "serve");
		await new Promise((r) => setTimeout(r, 700));
		expect(runner1.runLogTail(serve.id)).toContain("started");

		// Simulate the hub process restarting: forget all in-memory state.
		const g = globalThis as Record<string, unknown>;
		g.__devhubRuns = undefined;
		g.__devhubRunnerBooted = undefined;
		await new Promise((r) => setTimeout(r, 200)); // let runs.json flush
		vi.resetModules();
		const runner2 = await import("#/server/runner");
		await vi.waitFor(() => expect(runner2.activeRuns("svc")).toHaveLength(1), {
			timeout: 5000,
		});
		const adopted = runner2.activeRuns("svc")[0];
		expect(adopted).toMatchObject({
			id: serve.id,
			adopted: true,
			pid: serve.pid,
		});
		expect(runner2.getRun(once.id)?.status).toBe("succeeded");

		const lines: string[] = [];
		let ended = false;
		runner2.subscribeRun(
			serve.id,
			(l) => lines.push(l),
			() => {
				ended = true;
			},
		);
		expect(lines).toContain("started");
		runner2.stopRun(serve.id);
		await vi.waitFor(() => expect(ended).toBe(true), { timeout: 8000 });
		expect(runner2.getRun(serve.id)?.status).toBe("stopped");
	}, 30_000);
});

describe("container logs", () => {
	it("follows `docker logs` line by line (fake docker on PATH)", async () => {
		const bin = tmpdir("fake-docker-");
		fs.writeFileSync(
			path.join(bin, "docker"),
			'#!/bin/sh\necho "args: $*"\necho "db ready"\necho "warn line" >&2\nprintf "no newline"\n',
			{ mode: 0o755 },
		);
		const oldPath = process.env.PATH;
		process.env.PATH = `${bin}:${oldPath}`;
		try {
			const { followContainerLogs } = await import("#/server/docker");
			const lines: string[] = [];
			await new Promise<void>((resolve) => {
				followContainerLogs("fitbase-db", (l) => lines.push(l), resolve);
			});
			expect(lines).toContain("args: logs --follow --tail 300 fitbase-db");
			expect(lines).toEqual(
				expect.arrayContaining(["db ready", "warn line", "no newline"]),
			);
		} finally {
			process.env.PATH = oldPath;
		}
	});
});

describe("port conflicts", () => {
	it("flags other apps on the project's ports, but not its own processes or shared infra", async () => {
		const { findConflicts } = await import("#/server/status");
		const project = {
			ok: true as const,
			id: "shop",
			root: "/work/shop",
			config: {
				name: "Shop",
				services: {
					web: { url: "http://localhost:3000" },
					api: { port: 8000 },
					db: { kind: "database" as const, port: 5432 },
					cache: { port: 6379, container: "shop-redis" },
				},
			},
		};
		const other = {
			ok: true as const,
			id: "blog",
			root: "/work/blog",
			config: { name: "Blog" },
		};
		const snap = {
			ports: [
				{
					port: 3000,
					addresses: ["*"],
					pid: 11,
					process: "node",
					cwd: "/work/blog",
				},
				{
					port: 8000,
					addresses: ["*"],
					pid: 12,
					process: "php",
					cwd: "/work/shop/api",
				},
				{
					port: 5432,
					addresses: ["*"],
					pid: 13,
					process: "postgres",
					cwd: "/opt/homebrew/var",
				},
				{
					port: 6379,
					addresses: ["*"],
					pid: 14,
					process: "redis-server",
					cwd: "/tmp",
				},
				{ port: 9999, addresses: ["*"], pid: 15, process: "node", cwd: "/tmp" },
			],
			docker: { available: false, containers: [] },
		};
		expect(findConflicts(project, snap, [project, other])).toEqual([
			{
				port: 3000,
				pid: 11,
				process: "node",
				cwd: "/work/blog",
				container: undefined,
				projectName: "Blog",
			},
		]);
	});
});

describe("command palette matching", () => {
	it("matches tokens as substrings or subsequences, best first", async () => {
		const { matchScore, rank } = await import("#/lib/palette");
		expect(
			matchScore("fit adm", "Login as Super Admin · Fitbase"),
		).not.toBeNull();
		expect(matchScore("fbs", "Fitbase")).not.toBeNull();
		expect(matchScore("xyz", "Fitbase")).toBeNull();
		const items = [
			{ text: "open fitbase app" },
			{ text: "login fitbase member" },
			{ text: "login fitbase admin" },
		];
		expect(rank(items, "login adm").map((i) => i.text)).toEqual([
			"login fitbase admin",
		]);
		expect(rank(items, "")).toEqual(items);
	});
});
