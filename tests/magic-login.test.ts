import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	isLocalDevHost,
	type MagicLoginClaims,
	signToken,
} from "#/server/magic-login";
import {
	createUsedTokenStore,
	safeRedirect,
	verifyDevhubToken,
} from "../adapters/node/devhub-magic-login";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyEnv = publicKey
	.export({ type: "spki", format: "der" })
	.toString("base64");
const publicKeyPem = publicKey
	.export({ type: "spki", format: "pem" })
	.toString();

function claims(overrides: Partial<MagicLoginClaims> = {}): MagicLoginClaims {
	const now = Math.floor(Date.now() / 1000);
	return {
		iss: "devhub",
		aud: "fitbase",
		sub: "admin@fitbase.local",
		persona: "admin",
		redirect: "/dashboard",
		iat: now,
		exp: now + 60,
		jti: randomUUID(),
		...overrides,
	};
}

describe("magic login tokens (node adapter)", () => {
	it("round-trips with the base64 SPKI key and the PEM", () => {
		const token = signToken(claims(), privateKey);
		expect(
			verifyDevhubToken(token, { publicKey: publicKeyEnv, audience: "fitbase" })
				.sub,
		).toBe("admin@fitbase.local");
		expect(
			verifyDevhubToken(token, { publicKey: publicKeyPem, audience: "fitbase" })
				.persona,
		).toBe("admin");
	});

	it("rejects another project's token", () => {
		const token = signToken(claims({ aud: "other" }), privateKey);
		expect(() =>
			verifyDevhubToken(token, {
				publicKey: publicKeyEnv,
				audience: "fitbase",
			}),
		).toThrow(/another project/);
	});

	it("rejects expired tokens", () => {
		const token = signToken(claims({ iat: 1000, exp: 1060 }), privateKey);
		expect(() =>
			verifyDevhubToken(token, {
				publicKey: publicKeyEnv,
				audience: "fitbase",
			}),
		).toThrow(/expired/);
	});

	it("rejects tampered payloads", () => {
		const [h, , s] = signToken(claims(), privateKey).split(".");
		const forged = Buffer.from(
			JSON.stringify(claims({ sub: "root@evil" })),
		).toString("base64url");
		expect(() =>
			verifyDevhubToken(`${h}.${forged}.${s}`, {
				publicKey: publicKeyEnv,
				audience: "fitbase",
			}),
		).toThrow(/signature/);
	});

	it("rejects tokens from another key", () => {
		const other = generateKeyPairSync("ed25519").privateKey;
		expect(() =>
			verifyDevhubToken(signToken(claims(), other), {
				publicKey: publicKeyEnv,
				audience: "fitbase",
			}),
		).toThrow(/signature/);
	});

	it("accepts each jti once", () => {
		const store = createUsedTokenStore();
		const c = claims();
		expect(store.claim(c)).toBe(true);
		expect(store.claim(c)).toBe(false);
	});

	it("only allows relative redirects", () => {
		expect(safeRedirect("/dashboard")).toBe("/dashboard");
		expect(safeRedirect("//evil.com")).toBe("/");
		expect(safeRedirect("https://evil.com")).toBe("/");
		expect(safeRedirect("/\\evil.com")).toBe("/");
		expect(safeRedirect(undefined)).toBe("/");
	});

	it("only sends tokens to local hosts", () => {
		expect(isLocalDevHost("localhost")).toBe(true);
		expect(isLocalDevHost("127.0.0.1")).toBe(true);
		expect(isLocalDevHost("[::1]")).toBe(true);
		expect(isLocalDevHost("fitbase.test")).toBe(true);
		expect(isLocalDevHost("fitbase.localhost")).toBe(true);
		expect(isLocalDevHost("fitbase.com")).toBe(false);
		expect(isLocalDevHost("localhost.evil.com")).toBe(false);
	});
});

function hasPhpSodium() {
	try {
		return (
			execFileSync("php", [
				"-r",
				"echo extension_loaded('sodium') ? 1 : 0;",
			]).toString() === "1"
		);
	} catch {
		return false;
	}
}

describe.runIf(hasPhpSodium())("magic login tokens (laravel adapter)", () => {
	const verifyWithPhp = (token: string, audience = "fitbase") => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devhub-php-"));
		const script = path.join(dir, "verify.php");
		fs.writeFileSync(
			script,
			`<?php require ${JSON.stringify(path.resolve("adapters/laravel/DevhubToken.php"))};
try { echo json_encode(App\\Support\\Devhub\\DevhubToken::verify($argv[1], $argv[2], $argv[3])); }
catch (RuntimeException $e) { echo 'ERR:' . $e->getMessage(); }`,
		);
		return execFileSync("php", [
			script,
			token,
			publicKeyEnv,
			audience,
		]).toString();
	};

	it("verifies a hub token", () => {
		const out = verifyWithPhp(signToken(claims(), privateKey));
		expect(JSON.parse(out).sub).toBe("admin@fitbase.local");
	});

	it("rejects tampered and foreign tokens", () => {
		const [h, , s] = signToken(claims(), privateKey).split(".");
		const forged = Buffer.from(
			JSON.stringify(claims({ sub: "root@evil" })),
		).toString("base64url");
		expect(verifyWithPhp(`${h}.${forged}.${s}`)).toBe("ERR:Invalid signature");
		expect(verifyWithPhp(signToken(claims(), privateKey), "other")).toBe(
			"ERR:Token is for another project",
		);
	});
});

function hasCommand(cmd: string, args: string[]) {
	try {
		execFileSync(cmd, args, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// PYTHON lets you point at an interpreter with a working `cryptography` build.
const python = process.env.PYTHON ?? "python3";
describe.runIf(
	hasCommand(python, [
		"-c",
		"from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey",
	]),
)("magic login tokens (django adapter)", () => {
	const verifyWithPython = (token: string, audience = "fitbase") =>
		execFileSync(python, [
			"-c",
			`import sys, json
sys.path.insert(0, ${JSON.stringify(path.resolve("adapters/django"))})
from devhub_token import verify_devhub_token, safe_redirect, DevhubTokenError
try:
    print(json.dumps(verify_devhub_token(sys.argv[1], sys.argv[2], sys.argv[3])))
except DevhubTokenError as e:
    print("ERR:" + str(e))`,
			token,
			publicKeyEnv,
			audience,
		])
			.toString()
			.trim();

	it("verifies a hub token", () => {
		expect(
			JSON.parse(verifyWithPython(signToken(claims(), privateKey))).sub,
		).toBe("admin@fitbase.local");
	});

	it("rejects tampered, foreign and expired tokens", () => {
		const [h, , s] = signToken(claims(), privateKey).split(".");
		const forged = Buffer.from(
			JSON.stringify(claims({ sub: "root@evil" })),
		).toString("base64url");
		expect(verifyWithPython(`${h}.${forged}.${s}`)).toBe(
			"ERR:Invalid signature",
		);
		expect(verifyWithPython(signToken(claims(), privateKey), "other")).toBe(
			"ERR:Token is for another project",
		);
		expect(
			verifyWithPython(signToken(claims({ iat: 1000, exp: 1060 }), privateKey)),
		).toBe("ERR:Token expired");
	});
});

describe.runIf(
	hasCommand("ruby", [
		"-ropenssl",
		"-e",
		"exit(OpenSSL::VERSION >= '3.0' ? 0 : 1)",
	]),
)("magic login tokens (rails adapter)", () => {
	const verifyWithRuby = (token: string, audience = "fitbase") =>
		execFileSync("ruby", [
			"-r",
			path.resolve("adapters/rails/devhub_token.rb"),
			"-e",
			`begin
  puts JSON.generate(DevhubToken.verify(ARGV[0], ARGV[1], ARGV[2]))
rescue DevhubToken::Error => e
  puts "ERR:#{e.message}"
end`,
			token,
			publicKeyEnv,
			audience,
		])
			.toString()
			.trim();

	it("verifies a hub token", () => {
		expect(
			JSON.parse(verifyWithRuby(signToken(claims(), privateKey))).persona,
		).toBe("admin");
	});

	it("rejects tampered, foreign and expired tokens", () => {
		const [h, , s] = signToken(claims(), privateKey).split(".");
		const forged = Buffer.from(
			JSON.stringify(claims({ sub: "root@evil" })),
		).toString("base64url");
		expect(verifyWithRuby(`${h}.${forged}.${s}`)).toBe("ERR:Invalid signature");
		expect(verifyWithRuby(signToken(claims(), privateKey), "other")).toBe(
			"ERR:Token is for another project",
		);
		expect(
			verifyWithRuby(signToken(claims({ iat: 1000, exp: 1060 }), privateKey)),
		).toBe("ERR:Token expired");
		const other = generateKeyPairSync("ed25519").privateKey;
		expect(verifyWithRuby(signToken(claims(), other))).toBe(
			"ERR:Invalid signature",
		);
	});
});
