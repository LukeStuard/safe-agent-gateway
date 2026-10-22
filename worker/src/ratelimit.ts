// Per-IP flood limit in front of everything an anonymous caller can reach: the MCP endpoint and the
// OAuth endpoints (token, dynamic registration, authorize, callback). Unauthenticated traffic has no
// other identity, so IP is the key here by design. Refusals are deliberately not audited: writing a
// row per flooded request would recreate the D1 cost this limiter exists to prevent.

type Handler<E> = (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;

const LIMITED_PATHS = new Set(["/mcp", "/token", "/register", "/authorize", "/callback"]);
const RETRY_AFTER_SECONDS = "60";

export function withIpLimit<E extends { IP_RATE_LIMITER: RateLimit }>(
	handle: Handler<E>,
): Handler<E> {
	return async (request, env, ctx) => {
		const { pathname } = new URL(request.url);
		if (!LIMITED_PATHS.has(pathname)) return handle(request, env, ctx);

		const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
		const { success } = await env.IP_RATE_LIMITER.limit({ key: `ip:${ip}` });
		if (!success) {
			console.warn("IP rate limit exceeded", pathname);
			return new Response("Too many requests.", {
				status: 429,
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"Retry-After": RETRY_AFTER_SECONDS,
				},
			});
		}
		return handle(request, env, ctx);
	};
}
