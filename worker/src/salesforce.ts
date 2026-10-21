// Salesforce access for the Safe Agent Gateway.
// Authenticates as the Gateway Integration user (OAuth client credentials) and runs SOQL.
// Fails closed: any auth or query error throws, and the caller returns no data.

export interface SfEnv {
	SF_LOGIN_URL: string;
	SF_API_VERSION: string;
	SF_CLIENT_ID: string;
	SF_CLIENT_SECRET: string;
}

type Token = { accessToken: string; instanceUrl: string; fetchedAt: number };

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
	cached = { accessToken: data.access_token, instanceUrl: data.instance_url, fetchedAt: Date.now() };
	return cached;
}

export async function soqlQuery<T>(env: SfEnv, soql: string): Promise<T[]> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const tok = await getToken(env, attempt > 0);
		const url = `${tok.instanceUrl}/services/data/${env.SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
		const res = await fetch(url, { headers: { Authorization: `Bearer ${tok.accessToken}` } });

		if (res.status === 401 && attempt === 0) continue; // expired token: refresh once, then retry

		if (!res.ok) {
			console.error("Salesforce query failed", res.status, await res.text());
			throw new Error(`Salesforce query failed (${res.status})`);
		}
		const data = await res.json<{ records: T[] }>();
		return data.records;
	}
	throw new Error("Salesforce authentication failed");
}