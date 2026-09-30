import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isLoopbackHost } from "./magic-login";
import { shellEnv } from "./runner";

/**
 * Magic Login for apps that use Supabase Auth, with no app code: the hub asks
 * the project's *local* Supabase (`supabase start`) for a one-time magic link
 * through the admin API and opens it. Supabase then signs the browser in and
 * redirects to the app like any real magic-link email would.
 *
 * Only loopback Supabase URLs are accepted, so a hosted (possibly production)
 * project in .env can never be used to impersonate users.
 */

const URL_KEYS = [
	"SUPABASE_URL",
	"VITE_SUPABASE_URL",
	"NEXT_PUBLIC_SUPABASE_URL",
	"PUBLIC_SUPABASE_URL",
	"EXPO_PUBLIC_SUPABASE_URL",
	"NUXT_PUBLIC_SUPABASE_URL",
	"API_URL",
];
const KEY_KEYS = [
	"SUPABASE_SERVICE_ROLE_KEY",
	"SERVICE_ROLE_KEY",
	"SUPABASE_SERVICE_KEY",
	"SUPABASE_SECRET_KEY",
	"SECRET_KEY",
];

function parseEnv(text: string) {
	const env: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const m = raw.match(
			/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
		);
		if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
	}
	return env;
}

async function envFiles(root: string) {
	const env: Record<string, string> = {};
	for (const f of [
		".env",
		".env.local",
		".env.development",
		".env.development.local",
	]) {
		const text = await fs
			.readFile(path.join(root, f), "utf8")
			.catch(() => null);
		if (text) Object.assign(env, parseEnv(text));
	}
	return env;
}

/** `supabase status -o env` knows the local API URL and service role key. */
async function supabaseStatus(root: string) {
	const env = await shellEnv();
	return new Promise<Record<string, string>>((resolve) => {
		execFile(
			"supabase",
			["status", "-o", "env"],
			{ cwd: root, env, timeout: 15_000 },
			(_err, stdout) => resolve(parseEnv(stdout ?? "")),
		);
	});
}

const pick = (env: Record<string, string>, keys: string[]) =>
	keys.map((k) => env[k]).find((v) => v && v.length > 0);

export async function supabaseCredentials(root: string) {
	const fromFiles = await envFiles(root);
	let url = pick(fromFiles, URL_KEYS);
	let serviceKey = pick(fromFiles, KEY_KEYS);
	if (!url || !serviceKey || !isLoopbackHost(new URL(url).hostname)) {
		// App .env files usually only hold the anon key; the CLI has the rest.
		const status = await supabaseStatus(root);
		url = pick(status, URL_KEYS) ?? url;
		serviceKey = pick(status, KEY_KEYS) ?? serviceKey;
	}
	if (!url)
		throw new Error(
			"No Supabase URL found in .env and `supabase status` didn't answer. Is `supabase start` running?",
		);
	if (!isLoopbackHost(new URL(url).hostname)) {
		throw new Error(
			`Supabase Magic Login only works with a local Supabase (supabase start); ${new URL(url).host} is not local.`,
		);
	}
	if (!serviceKey)
		throw new Error(
			"No Supabase service role key found (checked .env files and `supabase status`).",
		);
	return { url: url.replace(/\/$/, ""), serviceKey };
}

export async function supabaseMagicLink(
	root: string,
	email: string,
	redirectTo?: string,
) {
	const { url, serviceKey } = await supabaseCredentials(root);
	const res = await fetch(`${url}/auth/v1/admin/generate_link`, {
		method: "POST",
		headers: {
			apikey: serviceKey,
			authorization: `Bearer ${serviceKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			type: "magiclink",
			email,
			...(redirectTo ? { redirect_to: redirectTo } : {}),
		}),
		signal: AbortSignal.timeout(10_000),
	});
	const data = (await res.json().catch(() => ({}))) as {
		action_link?: string;
		properties?: { action_link?: string };
		msg?: string;
		error_description?: string;
		message?: string;
	};
	if (!res.ok) {
		const reason =
			data.msg ??
			data.error_description ??
			data.message ??
			`HTTP ${res.status}`;
		throw new Error(
			`Supabase refused a magic link for ${email}: ${reason}. Does this user exist in your local Supabase?`,
		);
	}
	const link = data.action_link ?? data.properties?.action_link;
	if (!link) throw new Error("Supabase answered without an action_link");
	return link;
}
