/**
 * Local Dev Hub - Magic Login for Next.js (App Router).
 *
 * 1. Copy adapters/node/devhub-magic-login.ts to e.g. src/lib/devhub-magic-login.ts.
 * 2. Copy this file to app/api/devhub/login/route.ts
 *    (folders starting with "_" are private in the App Router, so the endpoint
 *    is /api/devhub/login rather than /__devhub/login).
 * 3. .env.development.local:  DEVHUB_PUBLIC_KEY=...  (from the hub's Settings page)
 * 4. .dev/project.yaml:
 *      magicLogin:
 *        endpoint: http://localhost:3000/api/devhub/login
 *        redirect: /dashboard
 * 5. Fill in findUser() and startSession() below for your auth setup.
 *
 * In production builds NODE_ENV is "production", so isDevhubLoginEnabled()
 * is false and this route answers 404 before looking at the token.
 */
import { type NextRequest, NextResponse } from "next/server";
import {
	createUsedTokenStore,
	type DevhubClaims,
	isDevhubLoginEnabled,
	safeRedirect,
	verifyDevhubToken,
} from "@/lib/devhub-magic-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROJECT_ID = "fitbase"; // `id` in .dev/project.yaml
const usedTokens = createUsedTokenStore();

type User = { id: string; email: string; name?: string | null };

/** Look up the persona's user. `claims.sub` is `personas.<key>.user`. */
async function findUser(claims: DevhubClaims): Promise<User | null> {
	// Prisma:  return db.user.findUnique({ where: { email: claims.sub } });
	// Drizzle: return db.query.users.findFirst({ where: eq(users.email, claims.sub) });
	throw new Error(`Implement findUser() for ${claims.sub}`);
}

/** Create a normal session for `user` by setting cookies on `res`. */
async function startSession(user: User, res: NextResponse) {
	// --- Auth.js v5 / NextAuth with the default JWT session strategy:
	//
	// import { encode } from "next-auth/jwt";
	// const cookie = "authjs.session-token"; // dev is http, so no __Secure- prefix
	// const token = await encode({
	// 	token: { sub: user.id, email: user.email, name: user.name },
	// 	secret: process.env.AUTH_SECRET as string,
	// 	salt: cookie,
	// 	maxAge: 60 * 60 * 24 * 30,
	// });
	// res.cookies.set(cookie, token, { httpOnly: true, sameSite: "lax", path: "/" });
	//
	// --- Auth.js with database sessions: create a row with your adapter
	// (adapter.createSession({ sessionToken, userId: user.id, expires })) and
	// set the same cookie to `sessionToken`.
	//
	// --- iron-session / lucia / custom: call the same function your password
	// login calls after checking the password.
	throw new Error(`Implement startSession() for ${user.email} (${res.status})`);
}

export async function GET(req: NextRequest) {
	if (!isDevhubLoginEnabled())
		return new NextResponse("Not found", { status: 404 });

	let claims: DevhubClaims;
	try {
		claims = verifyDevhubToken(req.nextUrl.searchParams.get("token") ?? "", {
			publicKey: process.env.DEVHUB_PUBLIC_KEY as string,
			audience: PROJECT_ID,
		});
	} catch (err) {
		return new NextResponse(`Magic Login failed: ${(err as Error).message}`, {
			status: 401,
		});
	}
	if (!usedTokens.claim(claims)) {
		return new NextResponse("Magic Login failed: token already used", {
			status: 401,
		});
	}

	const user = await findUser(claims);
	if (!user) return new NextResponse(`No user ${claims.sub}`, { status: 404 });

	const res = NextResponse.redirect(
		new URL(safeRedirect(claims.redirect), req.url),
	);
	await startSession(user, res);
	return res;
}
