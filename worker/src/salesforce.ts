// Salesforce access for the Safe Agent Gateway.
// Authenticates as the Gateway Integration user (OAuth client credentials). Reads with SOQL and creates
// review note requests. The integration user's permission set decides what any call can actually do:
// it can create requests but can't edit or approve anything, and can't write to applications.
// Fails closed: any auth or API error throws, and the caller returns no data.

export interface SfEnv {
	SF_LOGIN_URL: string;
	SF_API_VERSION: string;
	SF_CLIENT_ID: string;
	SF_CLIENT_SECRET: string;
}

type Token = { accessToken: string; instanceUrl: string; fetchedAt: number };

// The only object the gateway code is allowed to create.
type CreatableObject = "Review_Note_Request__c";

let cached: Token | null = null;
const TOKEN_TTL_MS = 15 * 60 * 1000;

async function getToken(env: SfEnv, force = false): Promise<Token> {
	if (!force && cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached;

	const res = await fetch(`${env.SF_LOGIN_URL}/services/oauth2/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "client_credentials",
			client_id: env.SF_CLIENT_ID,
			client_secret: env.SF_CLIENT_SECRET,
		}),
	});
	if (!res.ok) throw new Error(`Salesforce token request failed (${res.status})`);

	const data = await res.json<{ access_token: string; instance_url: string }>();
	cached = {
		accessToken: data.access_token,
		instanceUrl: data.instance_url,
		fetchedAt: Date.now(),
	};
	return cached;
}

// One authenticated REST call. On 401 the cached token is refreshed once and the call retried.
async function sfFetch(env: SfEnv, path: string, init: RequestInit = {}): Promise<Response> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const tok = await getToken(env, attempt > 0);
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${tok.accessToken}`);
		const res = await fetch(`${tok.instanceUrl}/services/data/${env.SF_API_VERSION}${path}`, {
			...init,
			headers,
		});
		if (res.status === 401 && attempt === 0) continue; // expired token: refresh once, then retry
		return res;
	}
	throw new Error("Salesforce authentication failed");
}

export async function soqlQuery<T>(env: SfEnv, soql: string): Promise<T[]> {
	const res = await sfFetch(env, `/query?q=${encodeURIComponent(soql)}`);
	if (!res.ok) {
		console.error("Salesforce query failed", res.status, await res.text());
		throw new Error(`Salesforce query failed (${res.status})`);
	}
	const data = await res.json<{ records: T[] }>();
	return data.records;
}

export async function sfCreate(
	env: SfEnv,
	sobject: CreatableObject,
	fields: Record<string, string>,
): Promise<{ id: string }> {
	const res = await sfFetch(env, `/sobjects/${sobject}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(fields),
	});
	if (!res.ok) {
		console.error("Salesforce create failed", res.status, await res.text());
		throw new Error(`Salesforce create failed (${res.status})`);
	}
	const data = await res.json<{ id?: string; success?: boolean }>();
	if (!data.success || !data.id) throw new Error("Salesforce create returned no id");
	return { id: data.id };
}
