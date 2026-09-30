import fs from "node:fs/promises";
import path from "node:path";

/**
 * Compares the keys of `.env.example` (or .sample/.dist/.template) with the
 * keys actually set in `.env`/`.env.local`. Only key names ever leave this
 * module; values are never read into the result.
 */

export type EnvCheck = {
	/** Directory relative to the repo root ("." for the root). */
	dir: string;
	template: string;
	hasEnv: boolean;
	missing: string[];
};

const TEMPLATES = [".env.example", ".env.sample", ".env.dist", ".env.template"];
const ENV_FILES = [
	".env",
	".env.local",
	".env.development",
	".env.development.local",
];

export function parseEnvKeys(text: string) {
	const keys = new Set<string>();
	for (const raw of text.split(/\r?\n/)) {
		const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/);
		if (m) keys.add(m[1]);
	}
	return keys;
}

async function read(file: string) {
	return fs.readFile(file, "utf8").catch(() => null);
}

export async function checkEnvDir(
	root: string,
	dir: string,
): Promise<EnvCheck | null> {
	const abs = path.resolve(root, dir);
	for (const template of TEMPLATES) {
		const text = await read(path.join(abs, template));
		if (text === null) continue;
		const wanted = parseEnvKeys(text);
		const have = new Set<string>();
		let hasEnv = false;
		for (const file of ENV_FILES) {
			const env = await read(path.join(abs, file));
			if (env === null) continue;
			hasEnv = true;
			for (const k of parseEnvKeys(env)) have.add(k);
		}
		return {
			dir,
			template,
			hasEnv,
			missing: [...wanted].filter((k) => !have.has(k)).sort(),
		};
	}
	return null;
}

/** Checks the repo root plus every directory commands run in (monorepo apps). */
export async function checkEnv(root: string, dirs: string[] = []) {
	const unique = [...new Set([".", ...dirs.map((d) => path.normalize(d))])];
	const results = await Promise.all(unique.map((d) => checkEnvDir(root, d)));
	return results.filter((r): r is EnvCheck => r !== null);
}

/** Reads one key from the repo's env files (used for DATABASE_URL-style config). */
export async function readEnvValue(root: string, key: string) {
	for (const file of [...ENV_FILES].reverse()) {
		const text = await read(path.join(root, file));
		if (text === null) continue;
		for (const raw of text.split(/\r?\n/)) {
			const m = raw.match(
				/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/,
			);
			if (m?.[1] === key) return m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
		}
	}
	return undefined;
}
