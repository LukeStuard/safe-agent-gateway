// OAuth front door for the Safe Agent Gateway.
//
// The Worker is the OAuth 2.1 authorization server for MCP clients (via workers-oauth-provider),
// and Salesforce is the upstream identity provider.
//   GET  /authorize  Parse the MCP client's request. Show a consent page, unless this browser
//                    already approved this client.
//   POST /authorize  Record the decision. On approve, redirect to Salesforce login.
//   GET  /callback   Redeem the Salesforce code (PKCE + secret), read /userinfo, check the org,
//                    then issue the gateway's own grant to the MCP client.
// The Salesforce access token is used once for /userinfo and then revoked. It is never stored
// and never handed to the MCP client.

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

export interface GatewayProps {
	userId: string;
	username: string;
	email: string | null;
}

interface Flow {
	oauthReq: AuthRequest;
	codeVerifier?: string; // set once the user has consented and been sent to Salesforce
}

interface SalesforceUserInfo {
	user_id: string;
	organization_id: string;
	preferred_username: string;
	email?: string;
}

const FLOW_PREFIX = "gw_flow:";
const FLOW_TTL_SECONDS = 600;
const FLOW_COOKIE = "gw_flow";
const APPROVED_COOKIE = "gw_approved";
const APPROVED_MAX_AGE = 60 * 60 * 24 * 30;
const MAX_APPROVED_CLIENTS = 20;
export const GATEWAY_SCOPES = ["gateway:read"];

// ---------- encoding, cookies, responses ----------

function b64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function randomToken(bytes = 32): string {
	return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256b64url(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return b64url(new Uint8Array(digest));
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function getCookie(request: Request, name: string): string | null {
	for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=");
	}
	return null;
}

function setCookie(request: Request, name: string, value: string, maxAge: number): string {
	const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
	return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function redirect(location: string, cookies: string[] = []): Response {
	const headers = new Headers({ Location: location });
	for (const c of cookies) headers.append("Set-Cookie", c);
	return new Response(null, { status: 302, headers });
}

function htmlError(status: number, message: string): Response {
	return new Response(
		`<!doctype html><meta charset="utf-8"><title>Sign-in error</title><p>${escapeHtml(message)}</p>`,
		{ status, headers: { "Content-Type": "text/html; charset=utf-8" } },
	);
}

const callbackUrl = (request: Request) => new URL("/callback", request.url).href;

// ---------- flow state (KV, single use, 10 minutes) ----------

async function loadFlow(env: AuthEnv, flowId: string): Promise<Flow | null> {
	const raw = await env.OAUTH_KV.get(FLOW_PREFIX + flowId);
	return raw ? (JSON.parse(raw) as Flow) : null;
}

async function saveFlow(env: AuthEnv, flowId: string, flow: Flow): Promise<void> {
	await env.OAUTH_KV.put(FLOW_PREFIX + flowId, JSON.stringify(flow), { expirationTtl: FLOW_TTL_SECONDS });
}

// ---------- approved-clients cookie (HMAC-signed) ----------

async function hmacKey(env: AuthEnv): Promise<CryptoKey> {
	const raw = new Uint8Array(env.COOKIE_ENCRYPTION_KEY.match(/../g)!.map((h) => parseInt(h, 16)));
	return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function readApproved(request: Request, env: AuthEnv): Promise<string[]> {
	const value = getCookie(request, APPROVED_COOKIE);
	const [payload, sig] = value?.split(".") ?? [];
	if (!payload || !sig) return [];
	try {
		const valid = await crypto.subtle.verify("HMAC", await hmacKey(env), b64urlDecode(sig), new TextEncoder().encode(payload));
		if (!valid) return [];
		const list = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
		return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

async function approvedCookie(request: Request, env: AuthEnv, clientIds: string[]): Promise<string> {
	const payload = b64url(new TextEncoder().encode(JSON.stringify(clientIds.slice(-MAX_APPROVED_CLIENTS))));
	const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(payload));
	return setCookie(request, APPROVED_COOKIE, `${payload}.${b64url(new Uint8Array(sig))}`, APPROVED_MAX_AGE);
}

// ---------- consent page ----------

function consentPage(flowId: string, clientName: string, redirectUri: string): Response {
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize access</title>
<style>
body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
code{background:#f2f2f2;padding:.1rem .3rem;border-radius:4px;word-break:break-all}
button{font-size:1rem;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0}
</style></head>
<body>
<h1>Safe Agent Gateway</h1>
<p><strong>${escapeHtml(clientName)}</strong> is requesting access to the gateway's application tools on your behalf.</p>
<p>After you approve, you'll be returned to:<br><code>${escapeHtml(redirectUri)}</code></p>
<p>If you didn't start this, or don't recognize that address, deny.</p>
<form method="post" action="/authorize">
<input type="hidden" name="flow" value="${escapeHtml(flowId)}">
<button type="submit" name="decision" value="approve">Approve and sign in with Salesforce</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</body></html>`;
	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
		},
	});
}

// ---------- steps ----------

async function redirectToSalesforce(request: Request, env: AuthEnv, flowId: string, flow: Flow, cookies: string[]) {
	const codeVerifier = randomToken(48);
	await saveFlow(env, flowId, { ...flow, codeVerifier });

	const url = new URL("/services/oauth2/authorize", env.SF_LOGIN_URL);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: env.SF_LOGIN_CLIENT_ID,
		redirect_uri: callbackUrl(request),
		scope: "openid id",
		state: flowId,
		code_challenge: await sha256b64url(codeVerifier),
		code_challenge_method: "S256",
	}).toString();
	return redirect(url.href, cookies);
}

async function startAuthorize(request: Request, env: AuthEnv): Promise<Response> {
	let oauthReq: AuthRequest;
	try {
		oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	} catch (err) {
		console.warn("Invalid authorization request", err);
		return htmlError(400, "Invalid authorization request.");
	}

	const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
	if (!client) return htmlError(400, "Unknown client.");

	const flowId = randomToken();
	const flow: Flow = { oauthReq };
	const flowCookie = setCookie(request, FLOW_COOKIE, flowId, FLOW_TTL_SECONDS);

	// This browser already approved this exact client: skip straight to Salesforce.
	if ((await readApproved(request, env)).includes(oauthReq.clientId)) {
		return redirectToSalesforce(request, env, flowId, flow, [flowCookie]);
	}

	await saveFlow(env, flowId, flow);
	const res = consentPage(flowId, client.clientName ?? oauthReq.clientId, oauthReq.redirectUri);
	res.headers.append("Set-Cookie", flowCookie);
	return res;
}

async function submitConsent(request: Request, env: AuthEnv): Promise<Response> {
	const form = await request.formData();
	const flowId = String(form.get("flow") ?? "");

	// The form value must match this browser's flow cookie. SameSite=Lax keeps the cookie off
	// cross-site POSTs, so another site can't submit consent on the user's behalf.
	if (!flowId || flowId !== getCookie(request, FLOW_COOKIE)) {
		return htmlError(400, "This approval form is invalid. Start again from your MCP client.");
	}

	const flow = await loadFlow(env, flowId);
	if (!flow || flow.codeVerifier) {
		return htmlError(400, "This sign-in attempt expired or was already used. Start again from your MCP client.");
	}

	if (form.get("decision") !== "approve") {
		await env.OAUTH_KV.delete(FLOW_PREFIX + flowId);
		const denied = new URL(flow.oauthReq.redirectUri); // already validated by parseAuthRequest
		denied.searchParams.set("error", "access_denied");
		if (flow.oauthReq.state) denied.searchParams.set("state", flow.oauthReq.state);
        if (flow.oauthReq.issuer) denied.searchParams.set("iss", flow.oauthReq.issuer);
		return redirect(denied.href, [setCookie(request, FLOW_COOKIE, "", 0)]);
	}

	const approved = new Set(await readApproved(request, env));
	approved.add(flow.oauthReq.clientId);
	return redirectToSalesforce(request, env, flowId, flow, [await approvedCookie(request, env, [...approved])]);
}

async function handleCallback(request: Request, env: AuthEnv, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const state = url.searchParams.get("state");

	// State must match this browser's flow cookie (blocks login CSRF and links opened elsewhere).
	if (!state || state !== getCookie(request, FLOW_COOKIE)) {
		return htmlError(400, "This sign-in link is invalid or was opened in a different browser. Start again from your MCP client.");
	}

	const flow = await loadFlow(env, state);
	await env.OAUTH_KV.delete(FLOW_PREFIX + state); // single use
	if (!flow?.codeVerifier) {
		return htmlError(400, "This sign-in attempt expired or was already used. Start again from your MCP client.");
	}

	const sfError = url.searchParams.get("error");
	if (sfError) {
		console.warn("Salesforce authorization error", sfError, url.searchParams.get("error_description"));
		return htmlError(403, "Salesforce did not authorize this sign-in. Your account may not have access to the gateway.");
	}

	const code = url.searchParams.get("code");
	if (!code) return htmlError(400, "Missing authorization code.");

	const tokenRes = await fetch(new URL("/services/oauth2/token", env.SF_LOGIN_URL), {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: env.SF_LOGIN_CLIENT_ID,
			client_secret: env.SF_LOGIN_CLIENT_SECRET,
			redirect_uri: callbackUrl(request),
			code_verifier: flow.codeVerifier,
		}),
	});
	if (!tokenRes.ok) {
		console.error("Salesforce token exchange failed", tokenRes.status, await tokenRes.text());
		return htmlError(502, "Sign-in failed while contacting Salesforce.");
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
		return htmlError(502, "Sign-in failed while reading your Salesforce identity.");
	}
	const info = (await userRes.json()) as SalesforceUserInfo;

	// Only identities from this gateway's own Salesforce org are accepted.
	if (info.organization_id !== env.SF_ORG_ID) {
		console.warn("Rejected login from another org", info.organization_id);
		return htmlError(403, "This Salesforce account belongs to a different organization.");
	}

	const props: GatewayProps = { userId: info.user_id, username: info.preferred_username, email: info.email ?? null };
	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: flow.oauthReq,
		userId: info.user_id,
		metadata: { label: info.preferred_username },
		scope: GATEWAY_SCOPES, // the gateway decides what's granted, not the client
		props,
	});
	return redirect(redirectTo, [setCookie(request, FLOW_COOKIE, "", 0)]);
}

// ---------- router (OAuthProvider's defaultHandler) ----------

export async function handleAuth(request: Request, env: AuthEnv, ctx: ExecutionContext): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === "/authorize" && request.method === "GET") return startAuthorize(request, env);
	if (pathname === "/authorize" && request.method === "POST") return submitConsent(request, env);
	if (pathname === "/callback" && request.method === "GET") return handleCallback(request, env, ctx);
	return new Response("Not found", { status: 404 });
}