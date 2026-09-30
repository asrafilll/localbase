import { createMiddleware, createStart } from "@tanstack/react-start";
import { isAllowedRequest } from "#/server/security";

/** Every request (pages, server functions, API routes) must come from this machine. */
const localOnly = createMiddleware({ type: "request" }).server(
	({ request, next }) => {
		const reason = isAllowedRequest(request.headers, request.method);
		if (reason)
			return new Response(`Local Dev Hub: ${reason}`, { status: 403 });
		return next();
	},
);

export const startInstance = createStart(() => ({
	requestMiddleware: [localOnly],
}));
