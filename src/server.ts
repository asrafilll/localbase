import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { bootBackground } from "#/server/boot";

// Runs once when the server starts (and again harmlessly on dev hot reloads).
bootBackground();

export default createServerEntry({ fetch: handler.fetch });
