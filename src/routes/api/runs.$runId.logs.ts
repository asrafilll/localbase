import { createFileRoute } from "@tanstack/react-router";
import { subscribeRun } from "#/server/runner";

/** Server-Sent Events stream of a command's output: `line` events, then one `end`. */
export const Route = createFileRoute("/api/runs/$runId/logs")({
	server: {
		handlers: {
			GET: ({ params, request }) => {
				const encoder = new TextEncoder();
				let unsubscribe: (() => void) | null = null;
				const stream = new ReadableStream({
					start(controller) {
						const send = (event: string, data: unknown) => {
							try {
								controller.enqueue(
									encoder.encode(
										`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
									),
								);
							} catch {
								// Stream already closed by the client.
							}
						};
						unsubscribe = subscribeRun(
							params.runId,
							(line) => send("line", line),
							(run) => {
								send("end", run);
								try {
									controller.close();
								} catch {}
							},
						);
						if (!unsubscribe) {
							send("error", "Unknown run");
							controller.close();
						}
						request.signal.addEventListener("abort", () => unsubscribe?.());
					},
					cancel() {
						unsubscribe?.();
					},
				});
				return new Response(stream, {
					headers: {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
					},
				});
			},
		},
	},
});
