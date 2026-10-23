import { DurableObject } from "cloudflare:workers";

// Strict per-user tool-call limit. One instance per Salesforce user (getByName("user:<id>")).
// A Durable Object handles one request at a time and owns its SQLite storage, so the count is exact
// in every Cloudflare location. The Workers Rate Limiting binding is approximate and let 30 of 30
// parallel calls through in production, so it is kept only for the per-IP flood limit.
// Sliding window: a call is allowed when fewer than TOOL_CALL_LIMIT calls were allowed in the last
// TOOL_CALL_WINDOW_MS. The log is persisted, so the window survives eviction.

export const TOOL_CALL_LIMIT = 10;
export const TOOL_CALL_WINDOW_MS = 60_000;

export class UserQuota extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS calls (ts INTEGER NOT NULL)");
		});
	}

	// Synchronous SQL with no awaits in between, so check-and-record is atomic.
	async consumeToolCall(): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
		const now = Date.now();
		const sql = this.ctx.storage.sql;
		sql.exec("DELETE FROM calls WHERE ts <= ?", now - TOOL_CALL_WINDOW_MS);
		const row = sql
			.exec<{ n: number; oldest: number | null }>("SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM calls")
			.one();

		if (row.n >= TOOL_CALL_LIMIT) {
			const retryAfterMs = (row.oldest ?? now) + TOOL_CALL_WINDOW_MS - now;
			return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
		}
		sql.exec("INSERT INTO calls (ts) VALUES (?)", now);
		return { allowed: true, retryAfterSeconds: 0 };
	}
}