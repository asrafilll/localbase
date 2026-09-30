import os from "node:os";
import path from "node:path";

/** Root of the hub's own state. Override with DEVHUB_HOME (handy for tests). */
export function hubHome() {
	return (
		process.env.DEVHUB_HOME ?? path.join(os.homedir(), ".config", "devhub")
	);
}

export const hubPaths = {
	config: () => path.join(hubHome(), "config.yaml"),
	trust: () => path.join(hubHome(), "trust.json"),
	privateKey: () => path.join(hubHome(), "magic-login", "private.pem"),
	publicKey: () => path.join(hubHome(), "magic-login", "public.pem"),
};

export function expandHome(p: string) {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** Shows `/Users/me/Projects/x` as `~/Projects/x`. */
export function tildify(p: string) {
	const home = os.homedir();
	return p === home || p.startsWith(`${home}/`)
		? `~${p.slice(home.length)}`
		: p;
}

export function isInside(child: string, parent: string) {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
