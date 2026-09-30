import { ensureProxy } from "./proxy";
import "./runner";

/**
 * Background services that must run even before anyone opens the dashboard:
 * re-attaching to processes from a previous hub run (runner import) and the
 * per-project proxy. Safe to call repeatedly.
 */
export function bootBackground() {
	void ensureProxy();
}
