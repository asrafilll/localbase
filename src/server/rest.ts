import { z } from "zod";
import * as actions from "./actions";
import { allPorts, overview, projectDetail } from "./status";

/**
 * REST routes under /api/v1 (all JSON):
 *
 *   GET  overview                          dashboard data
 *   GET  ports                             every listening port
 *   GET  projects/:id                      project detail
 *   POST projects/:id/start                {force?, killConflicts?}
 *   POST projects/:id/stop | restart
 *   POST projects/:id/reassign-port        move its web service to a free port
 *   POST projects/:id/magic-login/plan     what Magic Login setup would write
 *   POST projects/:id/magic-login/apply    {personas} -> write it
 *   POST projects/:id/commands/:key
 *   POST projects/:id/login                {persona} -> {url}
 *   POST projects/:id/scenarios/:key       -> {url}
 *   POST projects/:id/snapshots            {action: save|restore|delete, name}
 *   POST projects/:id/open                 {target: editor|finder|terminal}
 *   GET  runs/:id?tail=200                 run info + last lines
 *   POST runs/:id/stop
 *   POST ports/:port/kill
 *
 * Deliberately missing: trusting a project's commands. That review stays a
 * human click in the dashboard, so no script or AI agent can approve commands.
 * The global request middleware already limits callers to this machine.
 */

class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data ?? { ok: true }), {
		status,
		headers: { "content-type": "application/json" },
	});

async function body<T extends z.ZodType>(
	request: Request,
	schema: T,
): Promise<z.infer<T>> {
	// Requiring JSON also forces a CORS preflight for any cross-site caller.
	if (!request.headers.get("content-type")?.includes("application/json")) {
		if (schema.safeParse({}).success) return schema.parse({});
		throw new HttpError(
			415,
			"Send a JSON body with content-type: application/json",
		);
	}
	const parsed = schema.safeParse(await request.json().catch(() => ({})));
	if (!parsed.success) {
		throw new HttpError(
			400,
			parsed.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; "),
		);
	}
	return parsed.data;
}

const personaInput = z.object({
	key: z.string().regex(/^[A-Za-z0-9_-]+$/),
	label: z.string(),
	user: z.string().min(1),
});

async function route(request: Request, splat: string) {
	const parts = splat.split("/").filter(Boolean).map(decodeURIComponent);
	const method = request.method;
	const url = new URL(request.url);
	const [head, id, sub, key] = parts;

	if (method === "GET" && head === "overview" && parts.length === 1)
		return overview();
	if (method === "GET" && head === "ports" && parts.length === 1)
		return allPorts();

	if (head === "projects" && id) {
		if (method === "GET" && parts.length === 2) return projectDetail(id);
		if (method !== "POST") throw new HttpError(405, "Use POST");
		switch (sub) {
			case "start": {
				const b = await body(
					request,
					z.object({
						force: z.boolean().optional(),
						killConflicts: z.boolean().optional(),
					}),
				);
				return actions.startProject(id, b);
			}
			case "stop":
				return actions.stopProject(id);
			case "reassign-port":
				return actions.reassignPort(id);
			case "magic-login": {
				if (key === "plan") return actions.planMagicLoginSetup(id);
				if (key !== "apply") break;
				const b = await body(
					request,
					z.object({ personas: z.array(personaInput) }),
				);
				return actions.applyMagicLoginSetup(id, b.personas);
			}
			case "restart":
				return actions.restartProject(id);
			case "commands":
				if (!key) break;
				return actions.runCommand(id, key);
			case "login": {
				const b = await body(request, z.object({ persona: z.string() }));
				return { url: await actions.magicLoginUrl(id, b.persona) };
			}
			case "scenarios":
				if (!key) break;
				return actions.loadScenario(id, key);
			case "snapshots": {
				const b = await body(
					request,
					z.object({
						action: z.enum(["save", "restore", "delete"]),
						name: z.string().min(1),
					}),
				);
				return (
					(await actions.snapshotAction(id, b.action, b.name)) ?? { ok: true }
				);
			}
			case "open": {
				const b = await body(
					request,
					z.object({ target: z.enum(["editor", "finder", "terminal"]) }),
				);
				await actions.openRepo(id, b.target);
				return { ok: true };
			}
		}
	}

	if (head === "runs" && id) {
		if (method === "GET" && parts.length === 2) {
			const tail = Math.min(Number(url.searchParams.get("tail")) || 200, 5000);
			return actions.runInfo(id, tail);
		}
		if (method === "POST" && sub === "stop") {
			actions.stopCommandRun(id);
			return { ok: true };
		}
	}

	if (head === "ports" && id && sub === "kill" && method === "POST") {
		const port = Number(id);
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			throw new HttpError(400, "Invalid port");
		return actions.killPort(port);
	}

	throw new HttpError(404, `No route ${method} /api/v1/${splat}`);
}

export async function handleApi(request: Request, splat: string) {
	try {
		return json(await route(request, splat));
	} catch (err) {
		if (err instanceof HttpError)
			return json({ error: err.message }, err.status);
		const message = err instanceof Error ? err.message : String(err);
		const status = /^Unknown (project|run|scenario)/.test(message) ? 404 : 400;
		return json({ error: message }, status);
	}
}
