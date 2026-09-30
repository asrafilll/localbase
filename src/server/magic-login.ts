import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	randomUUID,
	sign,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hubPaths } from "./paths";
import type { LoadedProject } from "./registry";

/**
 * Magic Login tokens are compact JWTs signed with Ed25519 (`alg: EdDSA`).
 * The hub keeps the private key; target apps only get the public key, so a
 * leaked app `.env` can verify tokens but never mint them.
 */

export const TOKEN_TTL_SECONDS = 60;

export type MagicLoginClaims = {
	iss: "devhub";
	/** Project id; the app must reject tokens for other projects. */
	aud: string;
	/** Persona identity (`personas.<key>.user`). */
	sub: string;
	persona: string;
	role?: string;
	redirect?: string;
	iat: number;
	exp: number;
	/** Unique id; the app must accept each jti only once. */
	jti: string;
};

let keyCache: Promise<{ privateKey: KeyObject; publicKeyPem: string }> | null =
	null;

async function loadOrCreateKeys() {
	try {
		const [priv, pub] = await Promise.all([
			fs.readFile(hubPaths.privateKey(), "utf8"),
			fs.readFile(hubPaths.publicKey(), "utf8"),
		]);
		return { privateKey: createPrivateKey(priv), publicKeyPem: pub };
	} catch {
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const publicKeyPem = publicKey
			.export({ type: "spki", format: "pem" })
			.toString();
		await fs.mkdir(path.dirname(hubPaths.privateKey()), {
			recursive: true,
			mode: 0o700,
		});
		await fs.writeFile(
			hubPaths.privateKey(),
			privateKey.export({ type: "pkcs8", format: "pem" }),
			{ mode: 0o600 },
		);
		await fs.writeFile(hubPaths.publicKey(), publicKeyPem);
		return { privateKey, publicKeyPem };
	}
}

function keys() {
	keyCache ??= loadOrCreateKeys().catch((err) => {
		keyCache = null;
		throw err;
	});
	return keyCache;
}

export async function publicKeyPem() {
	return (await keys()).publicKeyPem;
}

/** Single-line base64 of the SPKI DER, convenient for `.env` files. */
export async function publicKeyEnvValue() {
	return createPublicKey(await publicKeyPem())
		.export({ type: "spki", format: "der" })
		.toString("base64");
}

const b64url = (data: string | Buffer) =>
	Buffer.from(data).toString("base64url");

export function signToken(claims: MagicLoginClaims, privateKey: KeyObject) {
	const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
	const payload = b64url(JSON.stringify(claims));
	const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey);
	return `${header}.${payload}.${b64url(signature)}`;
}

export async function createMagicLoginUrl(
	project: Extract<LoadedProject, { ok: true }>,
	personaKey: string,
) {
	const { magicLogin, personas } = project.config;
	if (!magicLogin)
		throw new Error(`${project.id} has no magicLogin endpoint configured`);
	const persona = personas?.[personaKey];
	if (!persona) throw new Error(`${project.id} has no persona "${personaKey}"`);

	const endpoint = new URL(magicLogin.endpoint);
	// Tokens are only ever sent to local apps, never over the network.
	if (!isLocalDevHost(endpoint.hostname)) {
		throw new Error(
			`Magic Login endpoint must be localhost, *.localhost or *.test, got ${endpoint.hostname}`,
		);
	}

	const now = Math.floor(Date.now() / 1000);
	const claims: MagicLoginClaims = {
		iss: "devhub",
		aud: project.id,
		sub: persona.user,
		persona: personaKey,
		role: persona.role,
		redirect: magicLogin.redirect,
		iat: now,
		exp: now + TOKEN_TTL_SECONDS,
		jti: randomUUID(),
	};
	endpoint.searchParams.set(
		"token",
		signToken(claims, (await keys()).privateKey),
	);
	return endpoint.toString();
}

export function isLoopbackHost(hostname: string) {
	const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return (
		h === "localhost" ||
		h.endsWith(".localhost") ||
		h === "::1" ||
		/^127\.\d+\.\d+\.\d+$/.test(h)
	);
}

/** Loopback plus `*.test`, the reserved TLD used by Laravel Herd/Valet and dnsmasq setups. */
export function isLocalDevHost(hostname: string) {
	return isLoopbackHost(hostname) || hostname.toLowerCase().endsWith(".test");
}
