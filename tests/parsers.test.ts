import { describe, expect, it } from "vitest";
import { parseDockerPorts, parseDockerPs } from "#/server/docker";
import { parseGitStatus } from "#/server/git";
import {
	guessServiceType,
	parseLsofCwd,
	parseLsofListen,
	parsePs,
} from "#/server/ports";

describe("lsof parsing", () => {
	it("groups addresses per pid and port", () => {
		const out = [
			"p501",
			"cnode",
			"f23",
			"n*:3000",
			"f24",
			"n[::1]:3000",
			"p77",
			"cpostgres",
			"f5",
			"n127.0.0.1:5432",
			"",
		].join("\n");
		expect(parseLsofListen(out)).toEqual([
			{ port: 3000, addresses: ["*", "[::1]"], pid: 501, process: "node" },
			{ port: 5432, addresses: ["127.0.0.1"], pid: 77, process: "postgres" },
		]);
	});

	it("ignores names without a port", () => {
		expect(parseLsofListen("p1\ncx\nnweird\n")).toEqual([]);
	});

	it("reads cwd output", () => {
		const cwds = parseLsofCwd(
			"p501\nfcwd\nn/Users/me/Projects/gym-saas\np77\nfcwd\nn/\n",
		);
		expect(cwds.get(501)).toBe("/Users/me/Projects/gym-saas");
		expect(cwds.get(77)).toBe("/");
	});

	it("reads ps pid, pgid and args", () => {
		const procs = parsePs(
			"  501   500 node /x/node_modules/.bin/next dev\n77 77 postgres -D /data\n",
		);
		expect(procs.get(501)).toEqual({
			pgid: 500,
			args: "node /x/node_modules/.bin/next dev",
		});
		expect(procs.get(77)?.args).toBe("postgres -D /data");
	});
});

describe("guessServiceType", () => {
	it.each([
		[
			{ process: "node", commandLine: "node /x/node_modules/.bin/next dev" },
			"Next.js",
		],
		[
			{ process: "node", commandLine: "node /x/node_modules/.bin/vite" },
			"Vite",
		],
		[{ process: "php", commandLine: "php artisan serve" }, "Laravel / PHP"],
		[{ process: "com.docker.backend", commandLine: undefined }, "Docker"],
		[{ process: "node", commandLine: "node server.js" }, "Node.js"],
	])("%o -> %s", (input, expected) => {
		expect(guessServiceType(input)).toBe(expected);
	});
});

describe("docker parsing", () => {
	it("parses published ports including ranges and ipv6", () => {
		expect(
			parseDockerPorts("0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp"),
		).toEqual([5432]);
		expect(parseDockerPorts("0.0.0.0:8000-8002->8000-8002/tcp")).toEqual([
			8000, 8001, 8002,
		]);
		expect(parseDockerPorts("6379/tcp")).toEqual([]);
	});

	it("parses docker ps json lines", () => {
		const line = JSON.stringify({
			ID: "abc",
			Names: "fitbase-db",
			Image: "postgres:16",
			State: "running",
			Status: "Up 2 hours",
			Ports: "0.0.0.0:5432->5432/tcp",
			Labels:
				"com.docker.compose.project.working_dir=/Users/me/Projects/gym-saas,com.docker.compose.service=db",
		});
		expect(parseDockerPs(`${line}\nnot json\n`)).toEqual([
			{
				id: "abc",
				name: "fitbase-db",
				image: "postgres:16",
				state: "running",
				status: "Up 2 hours",
				hostPorts: [5432],
				composeDir: "/Users/me/Projects/gym-saas",
				composeService: "db",
			},
		]);
	});
});

describe("git status parsing", () => {
	it("reads branch, ahead/behind and change count", () => {
		const out = [
			"# branch.oid 1234567890abcdef",
			"# branch.head feature/package-builder",
			"# branch.upstream origin/feature/package-builder",
			"# branch.ab +2 -1",
			"1 .M N... 100644 100644 100644 aaa bbb src/a.ts",
			"? new-file.ts",
			"",
		].join("\n");
		expect(parseGitStatus(out)).toEqual({
			branch: "feature/package-builder",
			changes: 2,
			ahead: 2,
			behind: 1,
		});
	});

	it("labels detached HEAD", () => {
		expect(
			parseGitStatus(
				"# branch.oid 1234567890abcdef\n# branch.head (detached)\n",
			).branch,
		).toBe("detached @ 1234567");
	});
});
