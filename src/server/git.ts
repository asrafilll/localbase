import { run } from "./exec";

export type GitInfo = {
	branch: string;
	/** Number of changed/untracked files. */
	changes: number;
	ahead: number;
	behind: number;
};

/** Parses `git status --porcelain=v2 --branch`. */
export function parseGitStatus(output: string): GitInfo {
	let branch = "";
	let oid = "";
	let ahead = 0;
	let behind = 0;
	let changes = 0;
	for (const line of output.split("\n")) {
		if (line.startsWith("# branch.head ")) branch = line.slice(14);
		else if (line.startsWith("# branch.oid ")) oid = line.slice(13);
		else if (line.startsWith("# branch.ab ")) {
			const m = line.match(/\+(\d+) -(\d+)/);
			if (m) {
				ahead = Number(m[1]);
				behind = Number(m[2]);
			}
		} else if (line && !line.startsWith("#")) changes++;
	}
	if (branch === "(detached)") branch = `detached @ ${oid.slice(0, 7)}`;
	return { branch, changes, ahead, behind };
}

/** Returns null for folders that are not git repositories instead of throwing. */
export async function gitInfo(root: string): Promise<GitInfo | null> {
	const out = await run("git", ["status", "--porcelain=v2", "--branch"], {
		cwd: root,
		timeoutMs: 3000,
	});
	return out === null ? null : parseGitStatus(out);
}
