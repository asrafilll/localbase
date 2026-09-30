/**
 * The hub can run shell commands, so any web page open in the browser must not
 * be able to drive it. `isAllowedRequest` blocks:
 * - DNS rebinding: the Host header must be a loopback name.
 * - CSRF / cross-site fetches: the Origin (when sent) must be a loopback origin,
 *   and browsers' Sec-Fetch-Site must not be `cross-site`.
 */

const LOOPBACK =
	/^(localhost|[a-z0-9-]+\.localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

export function isAllowedRequest(headers: Headers, method: string) {
	const host = headers.get("host") ?? "";
	if (!LOOPBACK.test(host)) return `Host "${host}" is not a loopback address`;

	const origin = headers.get("origin");
	if (origin && origin !== "null") {
		const originHost = URL.canParse(origin) ? new URL(origin).host : "";
		if (!LOOPBACK.test(originHost)) return `Origin "${origin}" is not allowed`;
	} else if (origin === "null" && method !== "GET" && method !== "HEAD") {
		return "Opaque origin is not allowed";
	}

	const site = headers.get("sec-fetch-site");
	if (site === "cross-site") {
		// Top-level navigation (typing the URL, bookmarks) is fine; subresources and fetches are not.
		const isNavigation =
			headers.get("sec-fetch-mode") === "navigate" && method === "GET";
		if (!isNavigation) return "Cross-site requests are not allowed";
	}
	return null;
}
