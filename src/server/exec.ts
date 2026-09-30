import { execFile } from "node:child_process";

/** Runs a binary without a shell. Resolves stdout, or null when it fails or is missing. */
export function run(
	file: string,
	args: string[],
	opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			file,
			args,
			{
				cwd: opts.cwd,
				timeout: opts.timeoutMs ?? 5000,
				maxBuffer: 10 * 1024 * 1024,
			},
			(err, stdout) => {
				// lsof exits 1 when a filter matches nothing but still prints valid output.
				if (err && !stdout) resolve(null);
				else resolve(stdout);
			},
		);
	});
}

/** Memoizes an async function for `ttlMs` so polling UIs don't hammer lsof/docker. */
export function cached<T>(ttlMs: number, fn: () => Promise<T>) {
	let value: { at: number; promise: Promise<T> } | null = null;
	return () => {
		if (!value || Date.now() - value.at > ttlMs) {
			value = { at: Date.now(), promise: fn() };
			value.promise.catch(() => {
				value = null;
			});
		}
		return value.promise;
	};
}
