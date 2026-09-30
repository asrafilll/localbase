/**
 * Tiny client for the hub's REST API (/api/v1), shared by the `devhub` CLI and
 * the MCP server. Zero dependencies; Node >= 18.
 */
import path from "node:path";

export const HUB_URL = (
	process.env.DEVHUB_URL ?? "http://127.0.0.1:6969"
).replace(/\/$/, "");

export class HubError extends Error {}

export async function api(method, route, body) {
	let res;
	try {
		res = await fetch(`${HUB_URL}/api/v1/${route}`, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch {
		throw new HubError(
			`Local Dev Hub is not reachable at ${HUB_URL}. Start it (pnpm dev / pnpm start) or set DEVHUB_URL.`,
		);
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok)
		throw new HubError(data.error ?? `${res.status} ${res.statusText}`);
	return data;
}

/**
 * Finds a project by id, name (case-insensitive) or unique prefix. With no
 * query, uses the project whose repository contains the current directory.
 */
export async function resolveProject(query, cwd = process.cwd()) {
	const { projects } = await api("GET", "overview");
	if (!query || query === ".") {
		const here = projects
			.filter((p) => {
				const rel = path.relative(p.root, cwd);
				return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
			})
			.sort((a, b) => b.root.length - a.root.length)[0];
		if (!here)
			throw new HubError(
				`No registered project contains ${cwd}. Pass a project name.`,
			);
		return here;
	}
	const q = query.toLowerCase();
	const exact = projects.find((p) => p.id === q || p.name.toLowerCase() === q);
	if (exact) return exact;
	const prefix = projects.filter(
		(p) => p.id.startsWith(q) || p.name.toLowerCase().startsWith(q),
	);
	if (prefix.length === 1) return prefix[0];
	if (prefix.length > 1)
		throw new HubError(
			`"${query}" matches ${prefix.map((p) => p.id).join(", ")}; be more specific.`,
		);
	throw new HubError(
		`Unknown project "${query}". Known: ${projects.map((p) => p.id).join(", ") || "(none registered)"}`,
	);
}

/** Streams a run's output over SSE. Resolves with the final run when it ends. */
export async function followRun(runId, onLine, signal) {
	const res = await fetch(
		`${HUB_URL}/api/runs/${encodeURIComponent(runId)}/logs`,
		{ signal },
	);
	if (!res.ok || !res.body)
		throw new HubError(`Cannot stream logs for ${runId}`);
	const decoder = new TextDecoder();
	let buffer = "";
	let final = null;
	for await (const chunk of res.body) {
		buffer += decoder.decode(chunk, { stream: true });
		let idx = buffer.indexOf("\n\n");
		while (idx >= 0) {
			const block = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			idx = buffer.indexOf("\n\n");
			const event = /^event: (.*)$/m.exec(block)?.[1];
			const data = /^data: (.*)$/m.exec(block)?.[1];
			if (data === undefined) continue;
			const value = JSON.parse(data);
			if (event === "line") onLine(value);
			else if (event === "end") final = value;
			else if (event === "error") throw new HubError(String(value));
		}
	}
	return final;
}
