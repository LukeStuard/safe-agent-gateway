import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { soqlQuery, type SfEnv } from "./salesforce";

// Allowlists. Agent input is validated against these and never spliced into SOQL as free text.
const TERMS = ["Fall 2026", "Spring 2027", "Summer 2027", "Fall 2027"] as const;
const DIMENSIONS = { program: "Program__c", term: "Term__c", status: "Status__c" } as const;
type Dimension = keyof typeof DIMENSIONS;

const PROGRAMS = ["MBA", "MS Management", "MS Data Analytics", "Certificate in Leadership"] as const;
const PENDING_STATUSES = ["Submitted", "In Review"] as const;
const MAX_ROWS = 25;

// Server-side redaction: only these fields ever leave the gateway, whatever Salesforce returns.
const REVIEW_OUTPUT = {
	applicationId: "Name",
	status: "Status__c",
	term: "Term__c",
	program: "Program__c",
	submittedDate: "Submitted_Date__c",
} as const;

function project(record: Record<string, unknown>, map: Record<string, string>) {
	const out: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(map)) out[key] = record[field] ?? null;
	return out;
}

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
			}).strict(),
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

		server.registerTool(
		"list_pending_reviews",
		{
			description:
				"Applications awaiting staff review (Submitted or In Review), oldest first. Returns application number, status, term, program, and submitted date only. Maximum 25 rows per call.",
			inputSchema: z
				.object({
					status: z.enum(PENDING_STATUSES).optional().describe("Optional: one pending status"),
					program: z.enum(PROGRAMS).optional().describe("Optional: limit to one program"),
					term: z.enum(TERMS).optional().describe("Optional: limit to one term"),
					limit: z.number().int().min(1).max(MAX_ROWS).default(10).describe(`Rows to return (1-${MAX_ROWS})`),
				})
				.strict(),
		},
		async ({ status, program, term, limit }) => {
			// Every value below is enum-validated, so quoting it into SOQL is safe.
			const filters = [
				status
					? `Status__c = '${status}'`
					: `Status__c IN (${PENDING_STATUSES.map((s) => `'${s}'`).join(", ")})`,
				...(program ? [`Program__c = '${program}'`] : []),
				...(term ? [`Term__c = '${term}'`] : []),
			];
			const fields = Object.values(REVIEW_OUTPUT).join(", ");
			const soql = `SELECT ${fields} FROM Application__c WHERE ${filters.join(" AND ")} ORDER BY Submitted_Date__c ASC NULLS LAST, Name ASC LIMIT ${limit + 1}`;

			try {
				const rows = await soqlQuery<Record<string, unknown>>(env, soql);
				const truncated = rows.length > limit;
				const items = rows.slice(0, limit).map((r) => project(r, REVIEW_OUTPUT));
				return {
					content: [{ type: "text", text: JSON.stringify({ count: items.length, truncated, items }, null, 2) }],
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