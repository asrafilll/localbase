/**
 * Builds a Server-Sent Events response. `start` wires up a source and returns
 * a cleanup function, called when the client disconnects or `close` runs.
 */
export function sseResponse(
	request: Request,
	start: (
		send: (event: string, data: unknown) => void,
		close: () => void,
	) => (() => void) | null,
) {
	const encoder = new TextEncoder();
	let cleanup: (() => void) | null = null;
	let closed = false;
	const stream = new ReadableStream({
		start(controller) {
			const send = (event: string, data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(
						encoder.encode(
							`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
						),
					);
				} catch {
					// Client already went away.
				}
			};
			const close = () => {
				if (closed) return;
				closed = true;
				cleanup?.();
				try {
					controller.close();
				} catch {}
			};
			cleanup = start(send, close);
			if (closed) cleanup?.();
			request.signal.addEventListener("abort", close);
		},
		cancel() {
			closed = true;
			cleanup?.();
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
}
