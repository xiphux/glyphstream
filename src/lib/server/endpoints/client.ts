import { Buffer } from 'node:buffer';
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

// --- video generation (Sora-shaped async) -------------------------------

export interface VideoCreateRequest {
	model: string;
	prompt: string;
	size?: string;
	seconds?: number;
}

export type VideoStatus = 'queued' | 'in_progress' | 'completed' | 'failed';

export interface VideoJob {
	id: string;
	object?: 'video';
	model?: string;
	status: VideoStatus;
	progress: number | null;
	seconds: number | null;
	size: string | null;
	created_at?: number;
	completed_at?: number | null;
	error: { message?: string; type?: string; code?: string } | null;
}

/** POST /v1/videos. Multipart per the bridge's contract. Returns the queued job. */
export async function videoCreate(
	endpoint: LoadedEndpoint,
	body: VideoCreateRequest
): Promise<VideoJob> {
	const url = `${endpoint.baseUrl}/videos`;
	const form = new FormData();
	form.append('model', body.model);
	form.append('prompt', body.prompt);
	if (body.size) form.append('size', body.size);
	if (body.seconds !== undefined) form.append('seconds', String(body.seconds));

	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: { ...authHeaders(endpoint) }, // do NOT set Content-Type — fetch handles multipart
			body: form,
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
			`Endpoint "${endpoint.id}" returned HTTP ${res.status} from /videos`,
			res.status,
			bodyText
		);
	}
	return (await res.json()) as VideoJob;
}

/** GET /v1/videos/{id} for polling. */
export async function videoStatus(
	endpoint: LoadedEndpoint,
	videoId: string
): Promise<VideoJob> {
	const url = `${endpoint.baseUrl}/videos/${encodeURIComponent(videoId)}`;
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
			`Network error polling endpoint "${endpoint.id}" at ${url}: ${cause}`,
			null,
			null
		);
	}
	if (!res.ok) {
		const bodyText = await safeReadBody(res);
		throw new UpstreamError(
			`Endpoint "${endpoint.id}" returned HTTP ${res.status} from /videos/${videoId}`,
			res.status,
			bodyText
		);
	}
	return (await res.json()) as VideoJob;
}

/** GET /v1/videos/{id}/content — raw mp4 bytes. Only valid once status === "completed". */
export async function videoFetchContent(
	endpoint: LoadedEndpoint,
	videoId: string
): Promise<{ bytes: Buffer; contentType: string }> {
	const url = `${endpoint.baseUrl}/videos/${encodeURIComponent(videoId)}/content`;
	let res: Response;
	try {
		res = await fetch(url, {
			method: 'GET',
			headers: authHeaders(endpoint),
			// No timeout — large videos legitimately take a while to download.
			signal: AbortSignal.timeout(endpoint.requestTimeoutSeconds * 1000 * 5)
		});
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		throw new UpstreamError(
			`Network error fetching video content at ${url}: ${cause}`,
			null,
			null
		);
	}
	if (!res.ok) {
		throw new UpstreamError(`Fetching video content returned HTTP ${res.status}`, res.status, null);
	}
	const arrayBuf = await res.arrayBuffer();
	const contentType = res.headers.get('content-type') ?? 'video/mp4';
	return { bytes: Buffer.from(arrayBuf), contentType };
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
