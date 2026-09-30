import { createFileRoute } from "@tanstack/react-router";
import { followContainerLogs } from "#/server/docker";
import { sseResponse } from "#/server/sse";
import { knownContainers } from "#/server/status";

/** Live `docker logs -f` for a container that belongs to a registered project. */
export const Route = createFileRoute("/api/containers/$name/logs")({
	server: {
		handlers: {
			GET: async ({ params, request }) => {
				if (!(await knownContainers()).has(params.name)) {
					return new Response("Unknown container", { status: 404 });
				}
				return sseResponse(request, (send, close) =>
					followContainerLogs(
						params.name,
						(line) => send("line", line),
						() => {
							send("end", null);
							close();
						},
					),
				);
			},
		},
	},
});
