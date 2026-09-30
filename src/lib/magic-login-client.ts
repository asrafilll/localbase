import { loadScenario, magicLogin } from "./api";

/**
 * Opens the tab synchronously (inside the click handler) so popup blockers
 * allow it, then points it at the signed login URL once the server returns it.
 */
async function openInNewTab(
	message: string,
	getUrl: () => Promise<string | null>,
) {
	const tab = window.open("about:blank", "_blank");
	if (tab) {
		tab.opener = null;
		tab.document.title = "Local Dev Hub";
		tab.document.body.style.font = "14px system-ui, sans-serif";
		tab.document.body.textContent = message;
	}
	try {
		const url = await getUrl();
		if (!url) {
			tab?.close();
			return;
		}
		if (tab) tab.location.href = url;
		else window.location.href = url;
	} catch (err) {
		tab?.close();
		throw err;
	}
}

export function loginAs(id: string, persona: string) {
	return openInNewTab(
		"Signing in…",
		async () => (await magicLogin({ data: { id, persona } })).url,
	);
}

export function loginIntoScenario(id: string, scenario: string) {
	return openInNewTab(
		"Preparing scenario, then signing in…",
		async () => (await loadScenario({ data: { id, scenario } })).url,
	);
}
