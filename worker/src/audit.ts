// Audit layer for the Safe Agent Gateway.
// withAudit wraps the /mcp endpoint so every tools/call is logged, including calls the SDK rejects
// during input validation (those never reach tool code) and calls refused by the per-user rate limit.
// Fails closed: if the audit write for a served call fails, the caller gets an error instead of the
// result. withRejectionAudit wraps the OAuth provider so refused tokens are logged too.
import type { GatewayProps } from "./auth-handler";

export interface AuditEnv {
	AUDIT_DB: D1Database;
	TOOL_RATE_LIMITER: RateLimit;
}

type Handler<E> = (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;
type Decision = "allow" | "deny" | "error";
const MAX_ARGS_CHARS = 1000;
const SALESFORCE_FAILURE = "The Salesforce request failed";
const TOOL_LIMIT_DESCRIPTION = "10 tool calls per 60 seconds per user"; // keep in sync with wrangler.jsonc
const RETRY_AFTER_SECONDS = "60";

interface AuditRow {
	identity: string;
	tool: string;
	args: unknown;
	decision: Decision;
	reason: string | null;
	summary: string | null;
	durationMs: number;
}

async function writeAudit(env: AuditEnv, row: AuditRow): Promise<void> {
	await env.AUDIT_DB.prepare(
		`INSERT INTO audit_log (request_id, identity, tool, arguments, decision, reason, result_summary, duration_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			crypto.randomUUID(),
			row.identity,
			row.tool,
			JSON.stringify(row.args ?? null).slice(0, MAX_ARGS_CHARS),
			row.decision,
			row.reason,
			row.summary,
			row.durationMs,
		)
		.run();
}

function rpcError(id: unknown, code: number, message: string, status = 200) {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function parseToolCall(text: string): { id: unknown; tool: string; args: unknown } | "batch" | null {
	try {
		const msg = JSON.parse(text);
		if (Array.isArray(msg)) return "batch";
		if (msg?.method !== "tools/call") return null;
		return { id: msg.id ?? null, tool: String(msg.params?.name ?? ""), args: msg.params?.arguments ?? {} };
	} catch {
		return null;
	}
}

// Responses arrive as JSON or as server-sent events ("event: message / data: {...}").
function parseRpcResponse(text: string): any {
	const trimmed = text.trim();
	const payload = trimmed.startsWith("{")
		? trimmed
		: trimmed
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.join("");
	try {
		return JSON.parse(payload);
	} catch {
		return null;
	}
}

// Metadata only. The audit log must never become a second copy of the data.
function summarize(text: string): string {
	try {
		const obj = JSON.parse(text);
		if ("found" in obj) return `found=${obj.found}`;
		if ("count" in obj) return `rows=${obj.count} truncated=${obj.truncated}`;
		if (Array.isArray(obj.rows)) return `groups=${obj.rows.length}`;
	} catch {
		/* not JSON */
	}
	return `bytes=${text.length}`;
}

function classify(msg: any): { decision: Decision; reason: string | null; summary: string | null } {
	if (!msg) return { decision: "error", reason: "Unparseable response", summary: null };
	if (msg.error) {
		return { decision: "deny", reason: `JSON-RPC ${msg.error.code}: ${String(msg.error.message).slice(0, 300)}`, summary: null };
	}
	const result = msg.result ?? {};
	const text: string = result.content?.[0]?.text ?? "";
	if (result.isError) {
		const decision: Decision = text.startsWith(SALESFORCE_FAILURE) ? "error" : "deny";
		return { decision, reason: text.slice(0, 300), summary: null };
	}
	return { decision: "allow", reason: null, summary: summarize(text) };
}

export function withAudit<E extends AuditEnv>(handle: Handler<E>): Handler<E> {
	return async (request, env, ctx) => {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== "/mcp") return handle(request, env, ctx);

		const started = Date.now();
		// OAuthProvider only reaches this handler with a valid token, so props are always present here.
		const props = (ctx as ExecutionContext & { props?: GatewayProps }).props;
		const identity = props?.username ?? "unknown";
		const call = parseToolCall(await request.clone().text());

		// Batches could hide tool calls from the audit layer, so refuse them outright.
		if (call === "batch") return rpcError(null, -32600, "Batch requests are not supported.", 400);

		// Per-user limit on tool calls, keyed by Salesforce user ID (stable even if the username changes).
		// Counts every tools/call, including invalid ones, so probing spends the budget too.
		if (call) {
			const { success } = await env.TOOL_RATE_LIMITER.limit({ key: `user:${props?.userId ?? identity}` });
			if (!success) {
				const limited = rpcError(call.id, -32000, "Rate limit exceeded. Try again in 60 seconds.", 429);
				limited.headers.set("Retry-After", RETRY_AFTER_SECONDS);
				try {
					await writeAudit(env, {
						identity,
						tool: call.tool,
						args: call.args,
						decision: "deny",
						reason: `Rate limit exceeded (${TOOL_LIMIT_DESCRIPTION})`,
						summary: null,
						durationMs: Date.now() - started,
					});
				} catch (err) {
					// The caller is already refused, so a failed write only gets reported.
					console.error("Audit write failed for a rate-limited call", err);
				}
				return limited;
			}
		}

		const response = await handle(request, env, ctx);
		if (!call) return response; // initialize, tools/list, notifications: not audited

		const responseText = await response.text();
		const { decision, reason, summary } = classify(parseRpcResponse(responseText));

		try {
			await writeAudit(env, {
				identity,
				tool: call.tool,
				args: call.args,
				decision,
				reason,
				summary,
				durationMs: Date.now() - started,
			});
		} catch (err) {
			console.error("Audit write failed; blocking response", err);
			return rpcError(call.id, -32603, "Audit log unavailable; request blocked.");
		}

		return new Response(responseText, { status: response.status, headers: response.headers });
	};
}

// OAuthProvider refuses missing, invalid, and wrong-audience tokens before withAudit runs.
// This wraps the provider itself so those refusals are logged too. The caller is already
// refused, so a failed audit write is reported but doesn't change the response.
const MAX_REJECTED_BODY = 64 * 1024;

function rejectedTarget(request: Request, text: string): { tool: string; args: unknown } {
	if (Number(request.headers.get("content-length") ?? 0) > MAX_REJECTED_BODY) {
		return { tool: "(oversized)", args: null };
	}
	try {
		const msg = JSON.parse(text);
		if (Array.isArray(msg)) return { tool: "(batch)", args: null };
		if (msg?.method === "tools/call") {
			return { tool: String(msg.params?.name ?? ""), args: msg.params?.arguments ?? {} };
		}
		return { tool: `(${String(msg?.method ?? "unknown")})`, args: null };
	} catch {
		return { tool: "(unparseable)", args: null };
	}
}

function rejectionReason(request: Request, response: Response): string {
	const challenge = response.headers.get("WWW-Authenticate") ?? "";
	const code = /error="([^"]+)"/.exec(challenge)?.[1] ?? "no error code";
	const presented = request.headers.has("Authorization") ? "token presented" : "no token";
	return `HTTP ${response.status}: ${code} (${presented})`;
}

export function withRejectionAudit<E extends AuditEnv>(handle: Handler<E>): Handler<E> {
	return async (request, env, ctx) => {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== "/mcp") return handle(request, env, ctx);

		const started = Date.now();
		const copy = request.clone(); // the provider consumes the original body
		const response = await handle(request, env, ctx);

		// Only the provider's own refusals: 401/403 carrying a Bearer challenge.
		const challenge = response.headers.get("WWW-Authenticate") ?? "";
		if ((response.status !== 401 && response.status !== 403) || !challenge.startsWith("Bearer")) {
			return response;
		}

		const text = Number(copy.headers.get("content-length") ?? 0) > MAX_REJECTED_BODY ? "" : await copy.text();
		const target = rejectedTarget(copy, text);

		try {
			await writeAudit(env, {
				identity: "unauthenticated",
				tool: target.tool,
				args: target.args,
				decision: "deny",
				reason: rejectionReason(copy, response),
				summary: null,
				durationMs: Date.now() - started,
			});
		} catch (err) {
			console.error("Audit write failed for a rejected request", err);
		}
		return response;
	};
}