// Audit layer for the Safe Agent Gateway.
// Wraps the /mcp endpoint so every tools/call is logged, including calls the SDK rejects
// during input validation (those never reach tool code). Fails closed: if the audit
// write fails, the caller gets an error instead of the result.

export interface AuditEnv {
	AUDIT_DB: D1Database;
}

type Handler<E> = (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;
type Decision = "allow" | "deny" | "error";

const IDENTITY = "anonymous-local"; // replaced by the OAuth identity later in Phase 3
const MAX_ARGS_CHARS = 1000;
const SALESFORCE_FAILURE = "The Salesforce request failed";

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
		const call = parseToolCall(await request.clone().text());

		// Batches could hide tool calls from the audit layer, so refuse them outright.
		if (call === "batch") return rpcError(null, -32600, "Batch requests are not supported.", 400);

		const response = await handle(request, env, ctx);
		if (!call) return response; // initialize, tools/list, notifications: not audited

		const responseText = await response.text();
		const { decision, reason, summary } = classify(parseRpcResponse(responseText));

		try {
			await env.AUDIT_DB.prepare(
				`INSERT INTO audit_log (request_id, identity, tool, arguments, decision, reason, result_summary, duration_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(
					crypto.randomUUID(),
					IDENTITY,
					call.tool,
					JSON.stringify(call.args).slice(0, MAX_ARGS_CHARS),
					decision,
					reason,
					summary,
					Date.now() - started,
				)
				.run();
		} catch (err) {
			console.error("Audit write failed; blocking response", err);
			return rpcError(call.id, -32603, "Audit log unavailable; request blocked.");
		}

		return new Response(responseText, { status: response.status, headers: response.headers });
	};
}