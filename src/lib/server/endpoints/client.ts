import type { LoadedEndpoint } from './config';
import type { UpstreamModel } from '$lib/types/api';

export class UpstreamError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
		readonly body: string | null
	) {
		super(message);
	}
}

function authHeaders(endpoint: LoadedEndpoint): Record<string, string> {
	return endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {};
}

/** GET /v1/models against an endpoint. */
export async function listUpstreamModels(endpoint: LoadedEndpoint): Promise<UpstreamModel[]> {
	const url = `${endpoint.baseUrl}/models`;
	let res: Response;
	try {
		res = await fetch(url, {
			method: 'GET',
			headers: authHeaders(endpoint),
			signal: AbortSignal.timeout(endpoint.requestTimeoutSeconds * 1000)
		});
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		throw new UpstreamError(
			`Network error contacting endpoint "${endpoint.id}" at ${url}: ${cause}`,
			null,
			null
		);
	}

	if (!res.ok) {
		const body = await safeReadBody(res);
		throw new UpstreamError(
			`Endpoint "${endpoint.id}" returned HTTP ${res.status} from /models`,
			res.status,
			body
		);
	}

	let parsed: unknown;
	try {
		parsed = await res.json();
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		throw new UpstreamError(`Endpoint "${endpoint.id}" returned non-JSON /models: ${cause}`, 200, null);
	}

	const data = (parsed as { data?: unknown }).data;
	if (!Array.isArray(data)) {
		throw new UpstreamError(
			`Endpoint "${endpoint.id}" returned malformed /models (missing data[] array)`,
			200,
			null
		);
	}
	return data as UpstreamModel[];
}

async function safeReadBody(res: Response): Promise<string | null> {
	try {
		return await res.text();
	} catch {
		return null;
	}
}
