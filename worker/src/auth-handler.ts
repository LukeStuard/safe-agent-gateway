// OAuth front door for the Safe Agent Gateway.
//
// The Worker is the OAuth 2.1 authorization server for MCP clients (workers-oauth-provider),
// and Salesforce is the upstream identity provider. Consent, browser binding, and single-use
// state come from the library's helpers, which implement the MCP confused-deputy requirements
// for proxy servers:
//   GET  /authorize  Validate the client's request. Skip to Salesforce if this browser already
//                    approved this client, otherwise show the consent page.
//   POST /authorize  Approve (remembered 30 days) or deny. Approve starts the Salesforce redirect.
//   GET  /callback   Recover the original request, redeem the Salesforce code (PKCE + secret),
//                    read /userinfo, check the org, and issue the gateway's own grant.
// The Salesforce token is used once for /userinfo and then revoked. It is never stored and
// never handed to the MCP client.

import {
	AuthorizationError,
	type AuthRequest,
	type ConsentDescription,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

export type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

export interface GatewayProps {
	userId: string;
	username: string;
	email: string | null;
}

export const GATEWAY_SCOPES = ["gateway:read"];

interface UpstreamData {
	verifier: string;
}

interface SalesforceUserInfo {
	user_id: string;
	organization_id: string;
	preferred_username: string;
	email?: string;
}

// ---------- helpers ----------

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function htmlError(status: number, message: string, headers?: Headers): Response {
	const res = new Response(
		`<!doctype html><meta charset="utf-8"><title>Sign-in error</title><p>${escapeHtml(message)}</p>`,
		{ status, headers: { "Content-Type": "text/html; charset=utf-8" } },
	);
	// Carry the helpers' cookie-clearing headers, if any.
	for (const cookie of headers?.getSetCookie() ?? []) res.headers.append("Set-Cookie", cookie);
	return res;
}

function found(headers: Headers, location: string): Response {
	headers.set("Location", location);
	return new Response(null, { status: 302, headers });
}

// OAuth error back to the MCP client. Only called with a request recovered from storage,
// whose redirect URI the library already validated.
function clientError(
	authReq: AuthRequest,
	code: string,
	description: string,
	headers: Headers,
): Response {
	const to = new URL(authReq.redirectUri);
	to.searchParams.set("error", code);
	to.searchParams.set("error_description", description);
	if (authReq.state) to.searchParams.set("state", authReq.state);
	if (authReq.issuer) to.searchParams.set("iss", authReq.issuer);
	return found(headers, to.href);
}

function b64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return b64url(new Uint8Array(digest));
}

const callbackUrl = (request: Request) => new URL("/callback", request.url).href;

// Remembered approvals live in a signed __Host- cookie, bound to client, redirect URI,
// resource, and scopes. No subject: as a proxy, the gateway only learns who the user is
// from Salesforce after consent.
const remember = (env: AuthEnv) => ({ secret: env.COOKIE_ENCRYPTION_KEY });

// ---------- consent page ----------

function consentPage(details: ConsentDescription, handle: string): string {
	const name = escapeHtml(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
		: "This app registered itself; its name is not verified.";
	const loopback = details.redirectIsLoopback
		? `<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>`
		: "";
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
.warn{background:#fff4e5;border-left:4px solid #e8a33d;padding:.5rem .75rem}
button{font-size:1rem;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0}
</style></head>
<body>
<h1>Safe Agent Gateway</h1>
<p><strong>${name}</strong> is requesting access to the gateway's application tools on your behalf.</p>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<p>Permissions: ${GATEWAY_SCOPES.map(escapeHtml).join(", ")}</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button type="submit" name="decision" value="approve">Approve and sign in with Salesforce</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</body></html>`;
}

// ---------- steps ----------

async function redirectToSalesforce(
	request: Request,
	env: AuthEnv,
	authReq: AuthRequest,
	headers?: Headers,
) {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
	// beginUpstream stores the approved request and the verifier server-side, encrypted,
	// and binds the state to this browser.
	const upstream = await env.OAUTH_PROVIDER.beginUpstream(authReq, {
		data: { verifier } satisfies UpstreamData,
		headers,
	});

	const url = new URL("/services/oauth2/authorize", env.SF_LOGIN_URL);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: env.SF_LOGIN_CLIENT_ID,
		redirect_uri: callbackUrl(request),
		scope: "openid id",
		state: upstream.state,
		code_challenge: await pkceChallenge(verifier),
		code_challenge_method: "S256",
	}).toString();
	return found(upstream.headers, url.href);
}

async function startAuthorize(request: Request, env: AuthEnv): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const authReq = await oauth.parseAuthRequest(request);

	if (await oauth.isConsentRemembered(request, authReq, remember(env))) {
		return redirectToSalesforce(request, env, authReq);
	}

	const details = await oauth.describeConsent(authReq); // before beginConsent: a failed lookup leaves nothing in KV
	const consent = await oauth.beginConsent(authReq); // binding cookie, no framing, no caching
	consent.headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function submitConsent(request: Request, env: AuthEnv): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const form = await request.formData();
	const handle = String(form.get("handle") ?? "");

	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(request, handle); // access_denied, state, iss
		return new Response(null, { status: 302, headers: denied.headers });
	}

	// The authorization request comes back from storage, not from the form.
	const approved = await oauth.approveConsent(request, handle, {
		scope: GATEWAY_SCOPES,
		remember: remember(env),
	});
	return redirectToSalesforce(request, env, approved.request, approved.headers);
}

async function handleCallback(
	request: Request,
	env: AuthEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	// Refused without the matching browser cookie; single use; recovers the original request.
	const {
		request: original,
		data,
		headers,
	} = await env.OAUTH_PROVIDER.finishUpstream<UpstreamData>(request);
	const url = new URL(request.url);

	const sfError = url.searchParams.get("error");
	if (sfError) {
		console.warn(
			"Salesforce authorization error",
			sfError,
			url.searchParams.get("error_description"),
		);
		return clientError(
			original,
			"access_denied",
			"Salesforce did not authorize this sign-in.",
			headers,
		);
	}

	const code = url.searchParams.get("code");
	if (!code)
		return htmlError(
			400,
			"Missing authorization code. Start again from your MCP client.",
			headers,
		);

	const tokenRes = await fetch(new URL("/services/oauth2/token", env.SF_LOGIN_URL), {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: env.SF_LOGIN_CLIENT_ID,
			client_secret: env.SF_LOGIN_CLIENT_SECRET,
			redirect_uri: callbackUrl(request),
			code_verifier: data.verifier,
		}),
	});
	if (!tokenRes.ok) {
		console.error("Salesforce token exchange failed", tokenRes.status, await tokenRes.text());
		return htmlError(502, "Sign-in failed while contacting Salesforce.", headers);
	}
	const { access_token } = (await tokenRes.json()) as { access_token: string };

	const userRes = await fetch(new URL("/services/oauth2/userinfo", env.SF_LOGIN_URL), {
		headers: { Authorization: `Bearer ${access_token}` },
	});

	// The gateway never keeps Salesforce user tokens: revoke it in the background either way.
	ctx.waitUntil(
		fetch(new URL("/services/oauth2/revoke", env.SF_LOGIN_URL), {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token: access_token }),
		}).catch((err) => console.warn("Salesforce token revoke failed", err)),
	);

	if (!userRes.ok) {
		console.error("Salesforce userinfo failed", userRes.status, await userRes.text());
		return htmlError(502, "Sign-in failed while reading your Salesforce identity.", headers);
	}
	const info = (await userRes.json()) as SalesforceUserInfo;

	// Only identities from this gateway's own Salesforce org are accepted.
	if (info.organization_id !== env.SF_ORG_ID) {
		console.warn("Rejected login from another org", info.organization_id);
		return clientError(
			original,
			"access_denied",
			"This Salesforce account belongs to a different organization.",
			headers,
		);
	}

	const props: GatewayProps = {
		userId: info.user_id,
		username: info.preferred_username,
		email: info.email ?? null,
	};
	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: original,
		userId: info.user_id,
		metadata: { label: info.preferred_username },
		scope: GATEWAY_SCOPES, // the gateway decides what's granted, not the client
		props,
	});
	return found(headers, redirectTo);
}

// ---------- router (OAuthProvider's defaultHandler) ----------

export async function handleAuth(
	request: Request,
	env: AuthEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	const { pathname } = new URL(request.url);
	try {
		if (pathname === "/authorize" && request.method === "GET")
			return await startAuthorize(request, env);
		if (pathname === "/authorize" && request.method === "POST")
			return await submitConsent(request, env);
		if (pathname === "/callback" && request.method === "GET")
			return await handleCallback(request, env, ctx);
		return new Response("Not found", { status: 404 });
	} catch (error) {
		if (error instanceof AuthorizationError) {
			// Redirect only when parseAuthRequest validated the client and its exact redirect URI.
			if (error.redirectUri) {
				const to = new URL(error.redirectUri);
				to.searchParams.set("error", error.code);
				to.searchParams.set("error_description", error.description);
				if (error.state) to.searchParams.set("state", error.state);
				if (error.issuer) to.searchParams.set("iss", error.issuer);
				return Response.redirect(to.href, 302);
			}
			// Expired, already used, opened in another browser, or an untrusted client: render here.
			return htmlError(400, error.description);
		}
		throw error; // a bug or an outage, not the user's doing: surface as a 500
	}
}
