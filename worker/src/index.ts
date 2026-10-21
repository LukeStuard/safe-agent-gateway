import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { soqlQuery, type SfEnv } from "./salesforce";

// Allowlists. Agent input is validated against these and never spliced into SOQL as free text.
const TERMS = ["Fall 2026", "Spring 2027", "Summer 2027", "Fall 2027"] as const;
const DIMENSIONS = { program: "Program__c", term: "Term__c", status: "Status__c" } as const;
type Dimension = keyof typeof DIMENSIONS;

function createServer(env: SfEnv) {
	const server = new McpServer({ name: "Safe Agent Gateway", version: "0.1.0" });

	server.registerTool(
		"get_program_summary",
		{
			description:
				"Counts of applications grouped by program, term, and/or status. Aggregates only; never returns individual records.",
			inputSchema: z.object({
				groupBy: z
					.array(z.enum(["program", "term", "status"]))
					.min(1)
					.max(3)
					.default(["program", "term"])
					.describe("Dimensions to group by"),
				term: z.enum(TERMS).optional().describe("Optional: limit to one term"),
			}),
		},
		async ({ groupBy, term }) => {
			const dims = [...new Set(groupBy)] as Dimension[];
			const fields = dims.map((d) => DIMENSIONS[d]).join(", ");
			const where = term ? ` WHERE Term__c = '${term}'` : ""; // safe: term is enum-validated
			const soql = `SELECT ${fields}, COUNT(Id) total FROM Application__c${where} GROUP BY ${fields} ORDER BY ${fields}`;

			try {
				const rows = await soqlQuery<Record<string, unknown>>(env, soql);
				const summary = rows.map((r) => {
					const out: Record<string, unknown> = {};
					for (const d of dims) out[d] = r[DIMENSIONS[d]] ?? null;
					out.count = r.total;
					return out;
				});
				return {
					content: [
						{ type: "text", text: JSON.stringify({ groupBy: dims, term: term ?? "all", rows: summary }, null, 2) },
					],
				};
			} catch (err) {
				console.error(err);
				return {
					isError: true,
					content: [{ type: "text", text: "The Salesforce request failed. No data was returned." }],
				};
			}
		},
	);

	return server;
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return createMcpHandler(() => createServer(env))(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;