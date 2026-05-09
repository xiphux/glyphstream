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

/** Chat completion request shape we forward upstream. */
export interface ChatCompletionRequest {
	model: string;
	messages: Array<{
		role: 'system' | 'user' | 'assistant' | 'tool';
		content: string;
	}>;
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
}

/** Just enough of the OpenAI response shape for v1 to extract the assistant text + usage. */
export interface ChatCompletionResponse {
	choices?: Array<{
		message?: {
			role?: string;
			content?: string | null;
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}

/**
 * Open a streaming POST /v1/chat/completions against `endpoint`. Returns
 * the upstream Response so the caller can `.body.tee()` for fan-out into
 * client + recorder branches.
 *
 * No timeout signal — streaming responses legitimately stay open longer
 * than the per-request timeout. Idle/stall protection happens upstream.
 */
export async function chatCompletionStream(
	endpoint: LoadedEndpoint,
	body: ChatCompletionRequest
): Promise<Response> {
	const url = `${endpoint.baseUrl}/chat/completions`;
	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'text/event-stream',
				...authHeaders(endpoint)
			},
			body: JSON.stringify({ ...body, stream: true })
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
		const bodyText = await safeReadBody(res);
		throw new UpstreamError(
			`Endpoint "${endpoint.id}" returned HTTP ${res.status} from /chat/completions (stream)`,
			res.status,
			bodyText
		);
	}
	if (!res.body) {
		throw new UpstreamError(
			`Endpoint "${endpoint.id}" returned 200 but no response body`,
			200,
			null
		);
	}
	return res;
}

// --- image generation ---------------------------------------------------

export interface ImageGenerationRequest {
	model: string;
	prompt: string;
	n?: number;
	size?: string;
	response_format?: 'url' | 'b64_json';
}

export interface ImageGenerationResponse {
	created?: number;
	data?: Array<{
		url?: string;
		b64_json?: string;
		revised_prompt?: string;
	}>;
}

export async function imageGeneration(
	endpoint: LoadedEndpoint,
	body: ImageGenerationRequest
): Promise<ImageGenerationResponse> {
	const url = `${endpoint.baseUrl}/images/generations`;
	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...authHeaders(endpoint)
			},
			body: JSON.stringify(body),
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
		const bodyText = await safeReadBody(res);
		throw new UpstreamError(
			`Endpoint "${endpoint.id}" returned HTTP ${res.status} from /images/generations`,
			res.status,
			bodyText
		);
	}
	let parsed: unknown;
	try {
		parsed = await res.json();
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		throw new UpstreamError(`Endpoint "${endpoint.id}" returned non-JSON: ${cause}`, 200, null);
	}
	return parsed as ImageGenerationResponse;
}

/**
 * Fetch raw bytes from an upstream-returned URL. Used by the media persister
 * to pull image/video content into local storage. Forwards the endpoint's
 * Authorization header in case the URL is on the same upstream and requires
 * auth (e.g. openai-api-bridge's /v1/files/{id}/content).
 */
export async function fetchUpstreamBytes(
	endpoint: LoadedEndpoint,
	urlString: string
): Promise<{ bytes: Buffer; contentType: string }> {
	let res: Response;
	try {
		res = await fetch(urlString, {
			method: 'GET',
			headers: authHeaders(endpoint),
			signal: AbortSignal.timeout(endpoint.requestTimeoutSeconds * 1000)
		});
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		throw new UpstreamError(
			`Network error fetching media from ${urlString}: ${cause}`,
			null,
			null
		);
	}
	if (!res.ok) {
		throw new UpstreamError(
			`Fetching media from ${urlString} returned HTTP ${res.status}`,
			res.status,
			null
		);
	}
	const arrayBuf = await res.arrayBuffer();
	const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
	return { bytes: Buffer.from(arrayBuf), contentType };
}

/**
 * POST /v1/chat/completions against `endpoint`. Non-streaming only — used
 * for the JSON-mode response path (no `?stream=1`).
 */
export async function chatCompletionSync(
	endpoint: LoadedEndpoint,
	body: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
	const url = `${endpoint.baseUrl}/chat/completions`;
	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...authHeaders(endpoint)
			},
			body: JSON.stringify({ ...body, stream: false }),
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
		const bodyText = await safeReadBody(res);
		throw new UpstreamError(
			`Endpoint "${endpoint.id}" returned HTTP ${res.status} from /chat/completions`,
			res.status,
			bodyText
		);
	}
	let parsed: unknown;
	try {
		parsed = await res.json();
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		throw new UpstreamError(`Endpoint "${endpoint.id}" returned non-JSON: ${cause}`, 200, null);
	}
	return parsed as ChatCompletionResponse;
}
