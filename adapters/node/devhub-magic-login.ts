/**
 * Local Dev Hub - Magic Login verifier for Node.js apps (zero dependencies).
 *
 * Copy this file into your app and mount a DEV-ONLY route, e.g. `/__devhub/login`:
 *
 *   if (isDevhubLoginEnabled()) {
 *     app.get("/__devhub/login", async (req, res) => {
 *       const claims = verifyDevhubToken(String(req.query.token), {
 *         publicKey: process.env.DEVHUB_PUBLIC_KEY!,
 *         audience: "fitbase", // your project id in .dev/project.yaml
 *       });
 *       if (!usedTokens.claim(claims)) return res.status(401).send("Token already used");
 *       const user = await db.user.findUniqueOrThrow({ where: { email: claims.sub } });
 *       await createSession(req, res, user); // your normal login
 *       res.redirect(safeRedirect(claims.redirect));
 *     });
 *   }
 *
 * Security model:
 * - Only the hub has the private key. Your app holds the public key, which can
 *   verify tokens but cannot create them.
 * - Tokens expire after 60 seconds and each `jti` is accepted once.
 * - `isDevhubLoginEnabled()` requires NODE_ENV=development *and* a key, so a
 *   production build never registers the route.
 *
 * Works on Node >= 18 (uses only `node:crypto`).
 */
import { createPublicKey, verify } from "node:crypto";

export type DevhubClaims = {
	iss: "devhub";
	aud: string;
	/** Persona identity, e.g. `admin@fitbase.local`. */
	sub: string;
	persona: string;
	role?: string;
	redirect?: string;
	iat: number;
	exp: number;
	jti: string;
};

export class DevhubTokenError extends Error {
	name = "DevhubTokenError";
}

/** True only in development with a configured key. Use it to decide whether to mount the route at all. */
export function isDevhubLoginEnabled(
	env: Record<string, string | undefined> = process.env,
) {
	return env.NODE_ENV === "development" && Boolean(env.DEVHUB_PUBLIC_KEY);
}

/** Accepts either the PEM or the single-line base64 SPKI value shown in the hub's Settings page. */
function toKey(publicKey: string) {
	const trimmed = publicKey.trim();
	if (trimmed.includes("BEGIN PUBLIC KEY")) return createPublicKey(trimmed);
	return createPublicKey({
		key: Buffer.from(trimmed, "base64"),
		format: "der",
		type: "spki",
	});
}

export function verifyDevhubToken(
	token: string,
	opts: {
		publicKey: string;
		audience: string;
		now?: number;
		clockSkewSeconds?: number;
	},
): DevhubClaims {
	if (process.env.NODE_ENV === "production") {
		throw new DevhubTokenError("Magic Login is disabled in production");
	}
	const parts = token.split(".");
	if (parts.length !== 3) throw new DevhubTokenError("Malformed token");
	const [header, payload, signature] = parts as [string, string, string];

	let alg: unknown;
	try {
		alg = JSON.parse(Buffer.from(header, "base64url").toString("utf8")).alg;
	} catch {
		throw new DevhubTokenError("Malformed token header");
	}
	if (alg !== "EdDSA") throw new DevhubTokenError("Unexpected token algorithm");

	const ok = verify(
		null,
		Buffer.from(`${header}.${payload}`),
		toKey(opts.publicKey),
		Buffer.from(signature, "base64url"),
	);
	if (!ok) throw new DevhubTokenError("Invalid signature");

	const claims = JSON.parse(
		Buffer.from(payload, "base64url").toString("utf8"),
	) as DevhubClaims;
	const now = opts.now ?? Math.floor(Date.now() / 1000);
	const skew = opts.clockSkewSeconds ?? 5;
	if (claims.iss !== "devhub") throw new DevhubTokenError("Wrong issuer");
	if (claims.aud !== opts.audience)
		throw new DevhubTokenError("Token is for another project");
	if (typeof claims.exp !== "number" || claims.exp + skew < now)
		throw new DevhubTokenError("Token expired");
	if (typeof claims.iat !== "number" || claims.iat - skew > now)
		throw new DevhubTokenError("Token issued in the future");
	if (!claims.sub || !claims.jti)
		throw new DevhubTokenError("Token is missing sub or jti");
	return claims;
}

/**
 * In-memory single-use guard. Fine for one dev server process; with several
 * processes, store jtis in Redis/DB with the same expiry instead.
 */
export function createUsedTokenStore() {
	const used = new Map<string, number>();
	return {
		/** Returns false if this token was already used. */
		claim(claims: Pick<DevhubClaims, "jti" | "exp">) {
			const now = Math.floor(Date.now() / 1000);
			for (const [jti, exp] of used) if (exp < now - 60) used.delete(jti);
			if (used.has(claims.jti)) return false;
			used.set(claims.jti, claims.exp);
			return true;
		},
	};
}

/** Only same-site relative paths, so a token can't be used as an open redirect. */
export function safeRedirect(redirect: string | undefined, fallback = "/") {
	if (
		!redirect ||
		!redirect.startsWith("/") ||
		redirect.startsWith("//") ||
		redirect.includes("\\")
	) {
		return fallback;
	}
	return redirect;
}
