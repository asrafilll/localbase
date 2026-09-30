import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "#/server/rest";

/** JSON API used by the CLI, the MCP server and the menu-bar app. See server/rest.ts. */
export const Route = createFileRoute("/api/v1/$")({
	server: {
		handlers: {
			GET: ({ request, params }) => handleApi(request, params._splat ?? ""),
			POST: ({ request, params }) => handleApi(request, params._splat ?? ""),
		},
	},
});
