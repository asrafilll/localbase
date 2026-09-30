import http from "node:http";
import net from "node:net";
import { isLoopbackHost } from "./magic-login";
import { type LoadedProject, loadProjects, readHubConfig } from "./registry";
import type { ServiceConfig } from "./schema";

/**
 * Stable per-project URLs:
 *
 *   http://<project>.localhost:<proxyPort>            -> the project's main service
 *   http://<service>.<project>.localhost:<proxyPort>  -> that service
 *
 * Browsers resolve *.localhost to this machine, so no /etc/hosts edits. Each
 * project gets its own origin (separate cookies), and the URL stays the same
 * when a dev server's port changes. WebSockets (Vite/Next HMR) are proxied too.
 */

type ValidProject = Extract<LoadedProject, { ok: true }>;

function loopbackPort(url: string | undefined) {
	if (!url) return undefined;
	try {
		const u = new URL(url);
		if (!isLoopbackHost(u.hostname) || u.hostname.endsWith(".localhost"))
			return undefined;
		return Number(u.port || (u.protocol === "https:" ? 443 : 80));
	} catch {
		return undefined;
	}
}

function servicePortOf(s: ServiceConfig) {
	return s.port ?? loopbackPort(s.url);
}

/** Port of the service a project's "Open App" points at. */
export function mainPort(project: ValidProject) {
	const services = Object.values(project.config.services ?? {});
	return (
		loopbackPort(project.config.url) ??
		services.map((s) => loopbackPort(s.url)).find((p) => p !== undefined)
	);
}

export function proxyUrlFor(
	projectId: string,
	proxyPort: number,
	serviceKey?: string,
) {
	if (!proxyPort) return undefined;
	const host = serviceKey
		? `${serviceKey}.${projectId}.localhost`
		: `${projectId}.localhost`;
	return proxyPort === 80 ? `http://${host}` : `http://${host}:${proxyPort}`;
}

/** Resolves a Host header to a local port, or explains why it can't. */
export function routeHost(
	host: string,
	projects: ValidProject[],
): { port: number; name: string } | { error: string } {
	const hostname = host.replace(/:\d+$/, "").toLowerCase();
	if (!hostname.endsWith(".localhost"))
		return { error: "Not a *.localhost address" };
	const labels = hostname.slice(0, -".localhost".length).split(".");
	if (labels.length > 2 || labels.some((l) => !l))
		return { error: `Unknown address ${hostname}` };
	const projectId = labels[labels.length - 1];
	const project = projects.find((p) => p.id === projectId);
	if (!project) return { error: `No registered project "${projectId}"` };
	if (labels.length === 2) {
		const service = project.config.services?.[labels[0]];
		const port = service && servicePortOf(service);
		if (!port)
			return {
				error: `${project.config.name} has no service "${labels[0]}" with a local port`,
			};
		return {
			port,
			name: `${project.config.name} · ${service.label ?? labels[0]}`,
		};
	}
	const port = mainPort(project);
	if (!port)
		return { error: `${project.config.name} has no local URL to proxy to` };
	return { port, name: project.config.name };
}

let routeCache: { at: number; projects: Promise<ValidProject[]> } | null = null;
function validProjects() {
	if (!routeCache || Date.now() - routeCache.at > 2000) {
		routeCache = {
			at: Date.now(),
			projects: loadProjects().then((all) =>
				all.filter((p): p is ValidProject => p.ok),
			),
		};
	}
	return routeCache.projects;
}

function errorPage(
	res: http.ServerResponse,
	status: number,
	title: string,
	detail: string,
) {
	res.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px system-ui;max-width:36rem;margin:5rem auto;padding:0 1rem;color:#27272a">
<h1 style="font-size:1.25rem">${title}</h1><p>${detail}</p>
<p style="color:#71717a;font-size:13px">Served by the Local Dev Hub proxy.</p></body>`);
}

const escapeHtml = (s: string) =>
	s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function forwardedHeaders(req: http.IncomingMessage) {
	return {
		...req.headers,
		"x-forwarded-host": req.headers.host ?? "",
		"x-forwarded-proto": "http",
		"x-forwarded-for": req.socket.remoteAddress ?? "127.0.0.1",
	};
}

export function createProxyServer() {
	const server = http.createServer(async (req, res) => {
		const route = routeHost(req.headers.host ?? "", await validProjects());
		if ("error" in route)
			return errorPage(res, 404, "Unknown project", escapeHtml(route.error));
		const upstream = http.request(
			{
				// "localhost" + autoSelectFamily reaches servers bound to either ::1 or 127.0.0.1.
				host: "localhost",
				port: route.port,
				autoSelectFamily: true,
				method: req.method,
				path: req.url,
				headers: forwardedHeaders(req),
			} as http.RequestOptions,
			(up) => {
				res.writeHead(up.statusCode ?? 502, up.headers);
				up.pipe(res);
			},
		);
		upstream.on("error", () => {
			if (res.headersSent) return res.destroy();
			errorPage(
				res,
				502,
				`${escapeHtml(route.name)} isn't running`,
				`Nothing answered on port ${route.port}. Start it from <a href="http://localhost:${process.env.PORT ?? 6969}">Local Dev Hub</a>.`,
			);
		});
		req.pipe(upstream);
	});

	server.on("upgrade", async (req, socket, head) => {
		const route = routeHost(req.headers.host ?? "", await validProjects());
		if ("error" in route) return socket.destroy();
		const upstream = net.connect(
			{ host: "localhost", port: route.port, autoSelectFamily: true },
			() => {
				const headers = Object.entries(forwardedHeaders(req))
					.flatMap(([k, v]) =>
						Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`],
					)
					.join("\r\n");
				upstream.write(
					`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`,
				);
				if (head.length) upstream.write(head);
				upstream.pipe(socket);
				socket.pipe(upstream);
			},
		);
		const close = () => {
			upstream.destroy();
			socket.destroy();
		};
		upstream.on("error", close);
		socket.on("error", close);
	});
	return server;
}

const store = globalThis as typeof globalThis & {
	__devhubProxy?: { port: number; server: http.Server } | null;
};

/** Starts the proxy once per process (idempotent, safe under Vite hot reload). */
export async function ensureProxy() {
	if (store.__devhubProxy !== undefined) return store.__devhubProxy;
	store.__devhubProxy = null;
	const { proxyPort } = await readHubConfig();
	if (!proxyPort) return null;
	const server = createProxyServer();
	await new Promise<void>((resolve) => {
		server.once("error", (err) => {
			console.warn(
				`[devhub] proxy not started on :${proxyPort}: ${(err as Error).message}`,
			);
			resolve();
		});
		// Loopback only: the proxy forwards to dev servers that trust local callers.
		server.listen(proxyPort, "127.0.0.1", () => {
			// Don't keep the process alive on its own: when the main server shuts
			// down (SIGTERM from launchd), the hub must be able to exit.
			server.unref();
			store.__devhubProxy = { port: proxyPort, server };
			resolve();
		});
	});
	return store.__devhubProxy;
}

export function proxyPortInUse() {
	return store.__devhubProxy?.port ?? 0;
}
