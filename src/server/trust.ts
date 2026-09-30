import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hubPaths } from "./paths";
import type { ProjectFile } from "./schema";

/**
 * A cloned repo's `.dev/project.yaml` can contain any shell command, so the hub
 * refuses to run commands until the user has reviewed them. Trust is pinned to a
 * hash of the commands: editing a command asks for review again.
 */

export function commandsHash(config: ProjectFile) {
	const commands = config.commands ?? {};
	const canonical = Object.keys(commands)
		.sort()
		.map((k) => [k, commands[k]]);
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function readTrust(): Promise<Record<string, string>> {
	try {
		return JSON.parse(await fs.readFile(hubPaths.trust(), "utf8"));
	} catch {
		return {};
	}
}

export async function isTrusted(root: string, config: ProjectFile) {
	return (await readTrust())[root] === commandsHash(config);
}

export async function trust(root: string, config: ProjectFile) {
	const all = await readTrust();
	all[root] = commandsHash(config);
	await fs.mkdir(path.dirname(hubPaths.trust()), { recursive: true });
	await fs.writeFile(hubPaths.trust(), JSON.stringify(all, null, 2));
}
