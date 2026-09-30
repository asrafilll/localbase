import { createFileRoute } from "@tanstack/react-router";
import { subscribeRun } from "#/server/runner";
import { sseResponse } from "#/server/sse";

/** Server-Sent Events stream of a command's output: `line` events, then one `end`. */
export const Route = createFileRoute("/api/runs/$runId/logs")({
	server: {
		handlers: {
			GET: ({ params, request }) =>
				sseResponse(request, (send, close) => {
					const unsubscribe = subscribeRun(
						params.runId,
						(line) => send("line", line),
						(run) => {
							send("end", run);
							close();
						},
					);
					if (!unsubscribe) {
						send("error", "Unknown run");
						close();
					}
					return unsubscribe;
				}),
		},
	},
});
