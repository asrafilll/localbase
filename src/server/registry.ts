import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { detectProject, toYaml } from "./detect";
import { expandHome, hubPaths } from "./paths";
import {
	type HubConfig,
	hubConfigSchema,
	type ProjectFile,
	projectFileSchema,
} from "./schema";

export const PROJECT_FILE = path.join(".dev", "project.yaml");

export type LoadedProject =
	| { ok: true; id: string; root: string; config: ProjectFile }
	| { ok: false; id: string; root: string; error: string };

export function slugify(s: string) {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "project"
	);
}

export async function readHubConfig(): Promise<HubConfig> {
	try {
		const raw = await fs.readFile(hubPaths.config(), "utf8");
		return hubConfigSchema.parse(YAML.parse(raw) ?? {});
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return hubConfigSchema.parse({});
		}
		throw err;
	}
}

export async function writeHubConfig(config: HubConfig) {
	await fs.mkdir(path.dirname(hubPaths.config()), { recursive: true });
	await fs.writeFile(hubPaths.config(), YAML.stringify(config));
}

async function exists(p: string) {
	return fs
		.access(p)
		.then(() => true)
		.catch(() => false);
}

/** All repo roots: explicit `projects` plus any `scanDirs/*` holding a project file. */
async function collectRoots(config: HubConfig) {
	const roots = new Set(
		config.projects.map((p) => path.resolve(expandHome(p))),
	);
	for (const dir of config.scanDirs) {
		const base = path.resolve(expandHome(dir));
		const entries = await fs
			.readdir(base, { withFileTypes: true })
			.catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const root = path.join(base, entry.name);
			if (await exists(path.join(root, PROJECT_FILE))) roots.add(root);
		}
	}
	return [...roots];
}

export async function loadProject(root: string): Promise<LoadedProject> {
	const fallbackId = slugify(path.basename(root));
	let raw: string;
	try {
		raw = await fs.readFile(path.join(root, PROJECT_FILE), "utf8");
	} catch {
		return {
			ok: false,
			id: fallbackId,
			root,
			error: `Missing ${PROJECT_FILE}`,
		};
	}
	try {
		const parsed = projectFileSchema.safeParse(YAML.parse(raw));
		if (!parsed.success) {
			const issues = parsed.error.issues
				.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
				.join("; ");
			return { ok: false, id: fallbackId, root, error: issues };
		}
		const config = parsed.data;
		return { ok: true, id: config.id ?? slugify(config.name), root, config };
	} catch (err) {
		return {
			ok: false,
			id: fallbackId,
			root,
			error: `Invalid YAML: ${(err as Error).message}`,
		};
	}
}

export async function loadProjects(): Promise<LoadedProject[]> {
	const config = await readHubConfig();
	const projects = await Promise.all(
		(await collectRoots(config)).map(loadProject),
	);
	// Ids end up in URLs and Magic Login tokens, so they must be unique.
	const seen = new Map<string, number>();
	for (const p of projects) {
		const n = seen.get(p.id) ?? 0;
		seen.set(p.id, n + 1);
		if (n > 0) p.id = `${p.id}-${n + 1}`;
	}
	return projects.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getProject(id: string) {
	const project = (await loadProjects()).find((p) => p.id === id);
	if (!project) throw new Error(`Unknown project: ${id}`);
	return project;
}

export async function getValidProject(id: string) {
	const project = await getProject(id);
	if (!project.ok) throw new Error(`${project.id}: ${project.error}`);
	return project;
}

export async function addProjectRoot(root: string) {
	const resolved = path.resolve(expandHome(root));
	const stat = await fs.stat(resolved).catch(() => null);
	if (!stat?.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
	const config = await readHubConfig();
	const known = config.projects.map((p) => path.resolve(expandHome(p)));
	if (!known.includes(resolved)) {
		config.projects.push(resolved);
		await writeHubConfig(config);
	}
	return resolved;
}

export async function removeProjectRoot(root: string) {
	const config = await readHubConfig();
	config.projects = config.projects.filter(
		(p) => path.resolve(expandHome(p)) !== root,
	);
	await writeHubConfig(config);
}

/** What registering a folder would do: the existing file, or a detected draft. */
export async function previewProject(
	root: string,
	port?: number,
	taken?: Map<number, string>,
) {
	const resolved = path.resolve(expandHome(root));
	const stat = await fs.stat(resolved).catch(() => null);
	if (!stat?.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
	const file = path.join(resolved, PROJECT_FILE);
	const existing = await fs.readFile(file, "utf8").catch(() => null);
	if (existing !== null)
		return { root: resolved, exists: true, yaml: existing, notes: [] };
	const detection = await detectProject(resolved, port, taken);
	return {
		root: resolved,
		exists: false,
		yaml: toYaml(detection),
		notes: detection.notes,
	};
}

/**
 * Registers a repo, writing `.dev/project.yaml` first when it has none: either
 * the (possibly user-edited) `yaml` from the preview, or a fresh detection.
 */
export async function scaffoldProject(
	root: string,
	port?: number,
	yaml?: string,
	taken?: Map<number, string>,
) {
	const resolved = await addProjectRoot(root);
	const file = path.join(resolved, PROJECT_FILE);
	if (!(await exists(file))) {
		const text = yaml ?? toYaml(await detectProject(resolved, port, taken));
		const parsed = projectFileSchema.safeParse(YAML.parse(text));
		if (!parsed.success) {
			throw new Error(
				`Invalid project file: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
			);
		}
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, text);
	}
	return resolved;
}
