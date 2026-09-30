import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { readEnvValue } from "./envcheck";
import { hubPaths, isInside } from "./paths";
import type { LoadedProject } from "./registry";
import { shellEnv } from "./runner";

/**
 * Database snapshots: save the project's dev database to
 * ~/.config/devhub/snapshots/<project>/<name>.(sql|sqlite) and restore it in
 * one click. Postgres and MySQL use their dump tools, either on the host or
 * inside the database's Docker container; SQLite is a file copy.
 */

type ValidProject = Extract<LoadedProject, { ok: true }>;

export type ResolvedDatabase =
	| { type: "sqlite"; file: string }
	| {
			type: "postgres" | "mysql";
			host: string;
			port: number;
			user: string;
			password: string;
			database: string;
			container?: string;
	  };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Replaces ${VAR} with values from the repo's env files. */
export async function interpolateEnv(root: string, value: string) {
	const keys = [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
		(m) => m[1],
	);
	let out = value;
	for (const key of new Set(keys)) {
		const v = (await readEnvValue(root, key)) ?? "";
		out = out.split(`\${${key}}`).join(encodeURIComponent(v));
	}
	return out;
}

export async function resolveDatabase(
	project: ValidProject,
): Promise<ResolvedDatabase> {
	const cfg = project.config.database;
	if (!cfg) throw new Error(`${project.id} has no database configured`);
	if (cfg.type === "sqlite") {
		const file = path.resolve(
			project.root,
			cfg.path ?? "database/database.sqlite",
		);
		if (!isInside(file, project.root))
			throw new Error("SQLite path must be inside the repository");
		return { type: "sqlite", file };
	}
	let raw = cfg.url;
	if (!raw && cfg.urlEnv) raw = await readEnvValue(project.root, cfg.urlEnv);
	if (!raw)
		throw new Error("Set database.url or database.urlEnv in .dev/project.yaml");
	const url = new URL(await interpolateEnv(project.root, raw));
	const port = Number(url.port) || (cfg.type === "postgres" ? 5432 : 3306);
	return {
		type: cfg.type,
		host: url.hostname || "127.0.0.1",
		port,
		user:
			decodeURIComponent(url.username) ||
			(cfg.type === "postgres" ? "postgres" : "root"),
		password: decodeURIComponent(url.password),
		database: decodeURIComponent(url.pathname.replace(/^\//, "")),
		container: cfg.container,
	};
}

/** Human-readable target without the password. */
export function describeDatabase(db: ResolvedDatabase, root: string) {
	if (db.type === "sqlite") return path.relative(root, db.file);
	const where = db.container ? ` (in container ${db.container})` : "";
	return `${db.type}://${db.user}@${db.host}:${db.port}/${db.database}${where}`;
}

function snapshotFile(projectId: string, name: string, type: string) {
	if (!NAME.test(name))
		throw new Error("Snapshot names may use letters, digits, . _ - (max 64)");
	return path.join(
		hubPaths.snapshots(projectId),
		`${name}.${type === "sqlite" ? "sqlite" : "sql"}`,
	);
}

/** Runs a tool without a shell, optionally piping a file in or out. */
async function tool(
	file: string,
	args: string[],
	opts: {
		env?: Record<string, string>;
		stdinFile?: string;
		stdoutFile?: string;
	} = {},
) {
	const env = { ...(await shellEnv()), ...opts.env };
	return new Promise<void>((resolve, reject) => {
		const child = spawn(file, args, {
			env,
			stdio: [
				opts.stdinFile ? "pipe" : "ignore",
				opts.stdoutFile ? "pipe" : "ignore",
				"pipe",
			],
		});
		let stderr = "";
		child.stderr?.on("data", (d: Buffer) => {
			stderr = (stderr + d.toString()).slice(-4000);
		});
		if (opts.stdinFile && child.stdin)
			fs.createReadStream(opts.stdinFile).pipe(child.stdin);
		const out = opts.stdoutFile ? fs.createWriteStream(opts.stdoutFile) : null;
		if (out && child.stdout) child.stdout.pipe(out);
		child.once("error", (err) =>
			reject(
				new Error(
					`${file}: ${err.message}${(err as NodeJS.ErrnoException).code === "ENOENT" ? " (not installed or not on PATH)" : ""}`,
				),
			),
		);
		child.once("close", (code) => {
			const done = () =>
				code === 0
					? resolve()
					: reject(
							new Error(
								`${file} exited with ${code}: ${stderr.trim() || "no output"}`,
							),
						);
			if (out) out.end(done);
			else done();
		});
	});
}

async function sqliteBackup(from: string, to: string) {
	// sqlite3's .backup is consistent even while the app writes; fall back to a copy.
	try {
		await tool("sqlite3", [from, `.backup '${to.replace(/'/g, "''")}'`]);
	} catch {
		await fsp.copyFile(from, to);
	}
}

export async function saveSnapshot(project: ValidProject, name: string) {
	const db = await resolveDatabase(project);
	const file = snapshotFile(project.id, name, db.type);
	await fsp.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.partial`;
	try {
		if (db.type === "sqlite") {
			if (!fs.existsSync(db.file))
				throw new Error(`No database file at ${db.file}`);
			await sqliteBackup(db.file, tmp);
		} else if (db.type === "postgres") {
			const dumpArgs = [
				"--clean",
				"--if-exists",
				"--no-owner",
				"--no-privileges",
				"-U",
				db.user,
				"-d",
				db.database,
			];
			if (db.container) {
				await tool(
					"docker",
					[
						"exec",
						"-e",
						`PGPASSWORD=${db.password}`,
						db.container,
						"pg_dump",
						...dumpArgs,
					],
					{ stdoutFile: tmp },
				);
			} else {
				await tool(
					"pg_dump",
					[...dumpArgs, "-h", db.host, "-p", String(db.port), "-f", tmp],
					{
						env: { PGPASSWORD: db.password },
					},
				);
			}
		} else {
			const dumpArgs = [
				"--single-transaction",
				"--routines",
				"--triggers",
				"--add-drop-table",
				"-u",
				db.user,
				db.database,
			];
			if (db.container) {
				await tool(
					"docker",
					[
						"exec",
						"-e",
						`MYSQL_PWD=${db.password}`,
						db.container,
						"mysqldump",
						...dumpArgs,
					],
					{ stdoutFile: tmp },
				);
			} else {
				await tool(
					"mysqldump",
					["-h", db.host, "-P", String(db.port), ...dumpArgs],
					{
						env: { MYSQL_PWD: db.password },
						stdoutFile: tmp,
					},
				);
			}
		}
		await fsp.rename(tmp, file);
	} catch (err) {
		await fsp.rm(tmp, { force: true });
		throw err;
	}
	return listSnapshots(project.id).then((l) => l.find((s) => s.name === name));
}

export async function restoreSnapshot(project: ValidProject, name: string) {
	const db = await resolveDatabase(project);
	const file = snapshotFile(project.id, name, db.type);
	if (!fs.existsSync(file)) throw new Error(`No snapshot "${name}"`);
	if (db.type === "sqlite") {
		// Stale WAL files would be replayed over the restored database.
		await Promise.all(
			["-wal", "-shm", "-journal"].map((s) =>
				fsp.rm(db.file + s, { force: true }),
			),
		);
		await fsp.copyFile(file, db.file);
	} else if (db.type === "postgres") {
		const args = [
			"-v",
			"ON_ERROR_STOP=1",
			"-q",
			"-U",
			db.user,
			"-d",
			db.database,
		];
		if (db.container) {
			await tool(
				"docker",
				[
					"exec",
					"-i",
					"-e",
					`PGPASSWORD=${db.password}`,
					db.container,
					"psql",
					...args,
				],
				{ stdinFile: file },
			);
		} else {
			await tool(
				"psql",
				[...args, "-h", db.host, "-p", String(db.port), "-f", file],
				{ env: { PGPASSWORD: db.password } },
			);
		}
	} else {
		const args = ["-u", db.user, db.database];
		if (db.container) {
			await tool(
				"docker",
				[
					"exec",
					"-i",
					"-e",
					`MYSQL_PWD=${db.password}`,
					db.container,
					"mysql",
					...args,
				],
				{ stdinFile: file },
			);
		} else {
			await tool("mysql", ["-h", db.host, "-P", String(db.port), ...args], {
				env: { MYSQL_PWD: db.password },
				stdinFile: file,
			});
		}
	}
}

export async function deleteSnapshot(project: ValidProject, name: string) {
	const db = await resolveDatabase(project);
	await fsp.rm(snapshotFile(project.id, name, db.type), { force: true });
}

export async function listSnapshots(projectId: string) {
	const dir = hubPaths.snapshots(projectId);
	const entries = await fsp.readdir(dir).catch(() => [] as string[]);
	const snapshots = await Promise.all(
		entries
			.filter((f) => /\.(sql|sqlite)$/.test(f))
			.map(async (f) => {
				const stat = await fsp.stat(path.join(dir, f));
				return {
					name: f.replace(/\.(sql|sqlite)$/, ""),
					sizeBytes: stat.size,
					createdAt: stat.mtimeMs,
				};
			}),
	);
	return snapshots.sort((a, b) => b.createdAt - a.createdAt);
}
