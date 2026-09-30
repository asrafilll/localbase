/**
 * A tiny app for trying Local Dev Hub end to end: status detection, commands,
 * logs, Magic Login and scenarios. Run it from the hub, or `node server.ts`
 * (Node >= 22.18).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
	createUsedTokenStore,
	DevhubTokenError,
	safeRedirect,
	verifyDevhubToken,
} from "../../adapters/node/devhub-magic-login.ts";

const PORT = Number(process.env.PORT ?? 4100);
const PROJECT_ID = "demo-app";

const users = new Map([
	["admin@demo.local", { name: "Ada Admin", role: "Super Admin" }],
	["member@demo.local", { name: "Mo Member", role: "Member" }],
]);
const sessions = new Map<string, string>();
const usedTokens = createUsedTokenStore();

// Demo convenience: a real app reads DEVHUB_PUBLIC_KEY from its development .env.
// Here we fall back to the hub's own public key so the demo works with zero setup.
function publicKey() {
	if (process.env.DEVHUB_PUBLIC_KEY) return process.env.DEVHUB_PUBLIC_KEY;
	const home =
		process.env.DEVHUB_HOME ?? path.join(os.homedir(), ".config", "devhub");
	return readFileSync(path.join(home, "magic-login", "public.pem"), "utf8");
}

function scenarioState() {
	try {
		return JSON.parse(
			readFileSync(new URL("./.scenario.json", import.meta.url), "utf8"),
		);
	} catch {
		return null;
	}
}

function currentUser(req: http.IncomingMessage) {
	const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
	const email = sid ? sessions.get(sid) : undefined;
	return email ? { email, ...users.get(email) } : null;
}

const page = (body: string) =>
	`<!doctype html><meta charset="utf-8"><title>Demo App</title>
<body style="font:15px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">${body}</body>`;

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
	console.log(`${req.method} ${url.pathname}`);

	if (url.pathname === "/health") {
		res
			.writeHead(200, { "content-type": "application/json" })
			.end('{"ok":true}');
		return;
	}

	// Dev-only Magic Login endpoint. A real app mounts this only when
	// isDevhubLoginEnabled() is true (NODE_ENV=development + DEVHUB_PUBLIC_KEY).
	if (url.pathname === "/__devhub/login") {
		try {
			const claims = verifyDevhubToken(url.searchParams.get("token") ?? "", {
				publicKey: publicKey(),
				audience: PROJECT_ID,
			});
			if (!usedTokens.claim(claims))
				throw new DevhubTokenError("Token already used");
			if (!users.has(claims.sub))
				throw new DevhubTokenError(`No user ${claims.sub}`);
			const sid = randomUUID();
			sessions.set(sid, claims.sub);
			res.writeHead(302, {
				"set-cookie": `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`,
				location: safeRedirect(claims.redirect),
			});
			res.end();
		} catch (err) {
			res
				.writeHead(401, { "content-type": "text/html" })
				.end(page(`<h1>Login failed</h1><p>${(err as Error).message}</p>`));
		}
		return;
	}

	if (url.pathname === "/logout") {
		res
			.writeHead(302, {
				"set-cookie": "sid=; Max-Age=0; Path=/",
				location: "/",
			})
			.end();
		return;
	}

	const user = currentUser(req);
	const scenario = scenarioState();
	res.writeHead(200, { "content-type": "text/html" }).end(
		page(
			user
				? `<h1>Hello, ${user.name}</h1><p>Signed in as <b>${user.email}</b> (${user.role}).</p>
${scenario ? `<p>Scenario: <b>${scenario.label}</b> — PT sessions remaining: ${scenario.ptRemaining}</p>` : ""}
<p><a href="/logout">Log out</a></p>`
				: `<h1>Demo App</h1><p>You are not signed in. Use <b>Magic Login</b> in Local Dev Hub.</p>`,
		),
	);
});

server.listen(PORT, "127.0.0.1", () =>
	console.log(`Demo app listening on http://localhost:${PORT}`),
);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
