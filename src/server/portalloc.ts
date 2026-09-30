/**
 * Keeps projects from fighting over the same port (every Vite/Next app wants
 * 3000/5173). When a project's port is taken by another registered project or
 * a running process, pick the next free one and bake it into the start
 * command, so the dev server really listens where the hub expects it.
 */

/** Frameworks whose dev CLI takes a port flag, and which one. */
const PORT_FLAGS: Record<string, string> = {
	"Next.js": "-p",
	Gatsby: "-p",
	Vite: "--port",
	SvelteKit: "--port",
	Remix: "--port",
	"React Router": "--port",
	"TanStack Start": "--port",
	Astro: "--port",
	Nuxt: "--port",
	Angular: "--port",
};

/** Vite-based CLIs silently move to the next port unless told not to. */
const STRICT = new Set([
	"Vite",
	"SvelteKit",
	"Remix",
	"React Router",
	"TanStack Start",
]);

const PORT_IN_TEXT = /(--port[ =]|-p\s+|\bPORT=)(\d{2,5})\b/;

export function nextFreePort(
	preferred: number,
	taken: Map<number, string> | Set<number>,
) {
	for (let p = preferred + 1; p < preferred + 200 && p < 65535; p++) {
		if (!taken.has(p)) return p;
	}
	throw new Error(`No free port near ${preferred}`);
}

function execPrefix(pm: string) {
	if (pm === "pnpm") return "pnpm exec";
	if (pm === "yarn") return "yarn";
	if (pm === "bun") return "bunx";
	return "npx --no-install";
}

function runScript(pm: string, script: string) {
	if (pm === "npm") return `npm run ${script}`;
	if (pm === "bun") return `bun run ${script}`;
	return `${pm} ${script}`;
}

export type PortedCommand = { command: string; env?: Record<string, string> };

/**
 * The start command for a Node dev script on a specific port, or null when
 * the script is too complex to change safely (then the user edits it).
 *
 * - script already has a port (`vite dev --port 3000`): run the same CLI via
 *   the package manager with the number replaced (passing a second --port to
 *   the npm script would give the CLI two values)
 * - known framework: `pnpm dev --port 3001` (`npm run dev -- --port 3001`)
 * - anything else: `PORT=3001` in the command's env (Express, Nest, CRA…)
 */
export function nodeCommandForPort(opts: {
	pm: string;
	framework?: string;
	scriptName: string;
	script: string;
	port: number;
}): PortedCommand | null {
	const { pm, framework, scriptName, script, port } = opts;
	const strict = framework && STRICT.has(framework) ? " --strictPort" : "";
	if (PORT_IN_TEXT.test(script)) {
		const compound = /[;&|]|^\s*[A-Za-z_]+=/.test(script);
		if (compound) return null;
		const rewritten = script.replace(PORT_IN_TEXT, `$1${port}`);
		const addStrict = strict && !/--strictPort/.test(rewritten) ? strict : "";
		return { command: `${execPrefix(pm)} ${rewritten}${addStrict}` };
	}
	const flag = framework ? PORT_FLAGS[framework] : undefined;
	if (flag) {
		const sep = pm === "npm" ? " -- " : " ";
		return {
			command: `${runScript(pm, scriptName)}${sep}${flag} ${port}${strict}`,
		};
	}
	return { command: runScript(pm, scriptName), env: { PORT: String(port) } };
}

/** Rewrites an existing start command from `oldPort` to `newPort`, if it names the port. */
export function retargetCommand(command: string, newPort: number) {
	return PORT_IN_TEXT.test(command)
		? command.replace(PORT_IN_TEXT, `$1${newPort}`)
		: null;
}

/** Start commands of non-Node frameworks on a given port. */
export function frameworkCommandForPort(
	kind: "artisan" | "django" | "rails-server" | "rails-dev",
	port: number,
): PortedCommand {
	switch (kind) {
		case "artisan":
			return { command: `php artisan serve --port=${port}` };
		case "django":
			return { command: `python manage.py runserver ${port}` };
		case "rails-server":
			return { command: `bin/rails server -p ${port}` };
		case "rails-dev":
			return { command: "bin/dev", env: { PORT: String(port) } };
	}
}
