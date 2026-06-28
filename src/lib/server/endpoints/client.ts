import { Buffer } from 'node:buffer';
import type { LoadedEndpoint } from './config';
import type { UpstreamModel } from '$lib/types/api';
import { composeSignals } from '../util/abort';

export class UpstreamError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
		readonly body: string | null,
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
	const res = await doFetch(
		url,
		{
			method: 'GET',
			headers: authHeaders(endpoint),
			signal: AbortSignal.timeout(endpoint.requestTimeoutSeconds * 1000),
		},
		`Network error contacting endpoint "${endpoint.id}" at ${url}`,
	);
	await ensureOk(res, `Endpoint "${endpoint.id}" returned HTTP ${res.status} from /models`);

	const parsed = await parseJson<{ data?: unknown }>(
		res,
		`Endpoint "${endpoint.id}" returned non-JSON /models`,
	);
	const data = parsed.data;
	if (!Array.isArray(data)) {
		throw new UpstreamError(
			`Endpoint "${endpoint.id}" returned malformed /models (missing data[] array)`,
			200,
			null,
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

/**
 * Run a fetch, converting a network-level failure (DNS, connection
 * refused, abort, …) into an UpstreamError. `networkErrorPrefix` is the
 * human prefix — the thrown message appends ": <cause>". Every request
 * function below routes through this so the network-error shape can't
 * drift between them.
 */
async function doFetch(
	url: string,
	init: RequestInit,
	networkErrorPrefix: string,
): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		throw new UpstreamError(`${networkErrorPrefix}: ${cause}`, null, null);
	}
}

/**
 * Throw an UpstreamError when `res` is not ok. Always captures the
 * upstream's response body so formatUpstreamError can surface the
 * upstream's own error text — the video/media fetchers previously
 * passed null here and silently dropped that detail.
 */
async function ensureOk(res: Response, httpErrorMessage: string): Promise<void> {
	if (res.ok) return;
	const body = await safeReadBody(res);
	throw new UpstreamError(httpErrorMessage, res.status, body);
}

/**
 * Parse a JSON response body, converting a non-JSON body into an
 * UpstreamError tagged with HTTP 200 (the request itself succeeded).
 */
async function parseJson<T>(res: Response, nonJsonMessage: string): Promise<T> {
	try {
		return (await res.json()) as T;
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		throw new UpstreamError(`${nonJsonMessage}: ${cause}`, 200, null);
	}
}

/**
 * Pull a user-readable message out of an upstream error body. Handles
 * the OpenAI error shape ({error: {message}}), the simpler {error: "…"}
 * form, and falls back to a truncated raw body. Returns null when the
 * body is empty or unparseable to anything useful.
 *
 * llama.cpp, vLLM, OpenAI, and the bridge all emit {error:{message,…}};
 * a few homegrown servers stuff the message at the top level. The fall-
 * through path covers vendor proxies that emit plain HTML or text.
 */
export function extractUpstreamErrorMessage(body: string | null): string | null {
	if (!body) return null;
	try {
		const parsed = JSON.parse(body) as unknown;
		if (parsed && typeof parsed === 'object') {
			const err = (parsed as { error?: unknown }).error;
			// Once we recognize one of the known error fields, we commit to it
			// and return null for empty messages rather than falling through to
			// the raw-body fallback — the upstream signaled "this field is the
			// error" and we trust that, even if it's empty.
			if (typeof err === 'string') {
				const v = err.trim();
				return v.length > 0 ? v : null;
			}
			if (err && typeof err === 'object') {
				const msg = (err as { message?: unknown }).message;
				if (typeof msg === 'string') {
					const v = msg.trim();
					return v.length > 0 ? v : null;
				}
			}
			const topMsg = (parsed as { message?: unknown }).message;
			if (typeof topMsg === 'string') {
				const v = topMsg.trim();
				return v.length > 0 ? v : null;
			}
		}
	} catch {
		// Not JSON — fall through to plain-text handling.
	}
	const trimmed = body.trim();
	if (!trimmed) return null;
	return trimmed.length > 400 ? trimmed.slice(0, 400) + '…' : trimmed;
}

/**
 * Format an UpstreamError for user-facing display. Pairs the templated
 * "Endpoint X returned HTTP …" prefix with the upstream's own error
 * message (extracted from the response body) so the user sees both
 * "where it broke" and "what the upstream said about why."
 */
export function formatUpstreamError(e: UpstreamError): string {
	const detail = extractUpstreamErrorMessage(e.body);
	return detail ? `${e.message}: ${detail}` : e.message;
}

/**
 * OpenAI vision-spec content parts. When a user message has image
 * attachments we send `content` as a structured array; plain-text-only
 * messages stay as a bare string for max compat with non-vision upstreams.
 */
export type ChatCompletionContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

/**
 * Outgoing tool-call entry on an assistant message — OpenAI's
 * `assistant.tool_calls[]` shape. `arguments` is the raw JSON string the
 * model emitted; we forward it as-is rather than re-parsing, so the
 * upstream sees byte-identical content to what it generated.
 */
export interface ChatCompletionRequestToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

/** Chat completion request shape we forward upstream. */
export interface ChatCompletionRequest {
	model: string;
	messages: Array<{
		role: 'system' | 'user' | 'assistant' | 'tool';
		/** OpenAI permits null content on assistant messages that carry
		 *  `tool_calls` (the model spoke only via tools, no prose). */
		content: string | ChatCompletionContentPart[] | null;
		/** Present only on assistant messages that emitted tool invocations. */
		tool_calls?: ChatCompletionRequestToolCall[];
		/** Required on `role: 'tool'` messages — pairs the result back to
		 *  the `tool_calls[].id` from the preceding assistant message. */
		tool_call_id?: string;
	}>;
	stream?: boolean;
	/**
	 * Opt in to a final SSE chunk containing the request's usage block
	 * (prompt/completion token counts). Required by the OpenAI spec for
	 * streaming responses — without this, usage is omitted from streams
	 * even though it's always present on non-streaming responses.
	 * Backends that don't recognize the field will ignore it per the
	 * spec, and our recorder tolerates a missing usage block.
	 */
	stream_options?: { include_usage?: boolean };
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	/** Native OpenAI tool-calling. Omit (don't send `[]`) for endpoints
	 *  that don't support tools — some upstreams reject the empty array. */
	tools?: Array<{
		type: 'function';
		function: { name: string; description: string; parameters: Record<string, unknown> };
	}>;
	/** Spec values: 'auto' | 'required' | 'none' | { type:'function', function:{name} } */
	tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
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
 * No fetch-level timeout — streaming responses legitimately stay open
 * longer than the per-request timeout. Use `signal` to abort externally
 * (e.g. when the user clicks Stop).
 */
export async function chatCompletionStream(
	endpoint: LoadedEndpoint,
	body: ChatCompletionRequest,
	signal?: AbortSignal,
): Promise<Response> {
	const url = `${endpoint.baseUrl}/chat/completions`;
	const res = await doFetch(
		url,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'text/event-stream',
				...authHeaders(endpoint),
			},
			body: JSON.stringify({ ...body, stream: true }),
			signal,
		},
		`Network error contacting endpoint "${endpoint.id}" at ${url}`,
	);
	await ensureOk(
		res,
		`Endpoint "${endpoint.id}" returned HTTP ${res.status} from /chat/completions (stream)`,
	);
	if (!res.body) {
		throw new UpstreamError(
			`Endpoint "${endpoint.id}" returned 200 but no response body`,
			200,
			null,
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
	body: ImageGenerationRequest,
	signal?: AbortSignal,
): Promise<ImageGenerationResponse> {
	const url = `${endpoint.baseUrl}/images/generations`;
	const res = await doFetch(
		url,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...authHeaders(endpoint),
			},
			body: JSON.stringify(body),
			signal: composeSignals(AbortSignal.timeout(endpoint.requestTimeoutSeconds * 1000), signal),
		},
		`Network error contacting endpoint "${endpoint.id}" at ${url}`,
	);
	await ensureOk(
		res,
		`Endpoint "${endpoint.id}" returned HTTP ${res.status} from /images/generations`,
	);
	return parseJson<ImageGenerationResponse>(res, `Endpoint "${endpoint.id}" returned non-JSON`);
}

// --- image edit (I2I) ---------------------------------------------------

export interface ImageEditInputFile {
	bytes: Buffer;
	contentType: string;
}

export interface ImageEditRequest {
	model: string;
	prompt: string;
	/**
	 * Input image(s). OpenAI's spec is single-image, but multipart allows
	 * repeated field names — the bridge accepts an array for ComfyUI
	 * workflows that declare multiple `image_inputs`. Pass [single] for the
	 * standard OpenAI path.
	 */
	images: ImageEditInputFile[];
	mask?: ImageEditInputFile;
	n?: number;
	size?: string;
	response_format?: 'url' | 'b64_json';
}

/**
 * POST /v1/images/edits as multipart/form-data. Same response shape as
 * imageGeneration — caller persists the returned url/b64 via the media
 * persister.
 */
export async function imageEdit(
	endpoint: LoadedEndpoint,
	body: ImageEditRequest,
	signal?: AbortSignal,
): Promise<ImageGenerationResponse> {
	const url = `${endpoint.baseUrl}/images/edits`;
	const fd = new FormData();
	fd.append('model', body.model);
	fd.append('prompt', body.prompt);
	// Buffer is a Uint8Array<ArrayBufferLike> at the type level, but DOM
	// Blob's BlobPart wants the narrower ArrayBuffer-backed Uint8Array.
	// Slicing into a fresh ArrayBuffer satisfies the typecheck and copies
	// the bytes exactly once.
	for (const img of body.images) {
		fd.append('image', toBlob(img.bytes, img.contentType), filenameFor(img.contentType));
	}
	if (body.mask) {
		fd.append(
			'mask',
			toBlob(body.mask.bytes, body.mask.contentType),
			filenameFor(body.mask.contentType),
		);
	}
	if (body.n !== undefined) fd.append('n', String(body.n));
	if (body.size) fd.append('size', body.size);
	if (body.response_format) fd.append('response_format', body.response_format);

	// Don't set Content-Type — fetch fills it in with the right
	// multipart/form-data boundary when body is a FormData.
	const res = await doFetch(
		url,
		{
			method: 'POST',
			headers: authHeaders(endpoint),
			body: fd,
			signal: composeSignals(AbortSignal.timeout(endpoint.requestTimeoutSeconds * 1000), signal),
		},
		`Network error contacting endpoint "${endpoint.id}" at ${url}`,
	);
	await ensureOk(res, `Endpoint "${endpoint.id}" returned HTTP ${res.status} from /images/edits`);
	return parseJson<ImageGenerationResponse>(res, `Endpoint "${endpoint.id}" returned non-JSON`);
}

function filenameFor(contentType: string): string {
	switch (contentType.toLowerCase()) {
		case 'image/png':
			return 'image.png';
		case 'image/jpeg':
		case 'image/jpg':
			return 'image.jpg';
		case 'image/webp':
			return 'image.webp';
		case 'image/gif':
			return 'image.gif';
		case 'image/avif':
			return 'image.avif';
		default:
			return 'image';
	}
}

function toBlob(buffer: Buffer, contentType: string): Blob {
	const ab = buffer.buffer.slice(
		buffer.byteOffset,
		buffer.byteOffset + buffer.byteLength,
	) as ArrayBuffer;
	return new Blob([ab], { type: contentType });
}

// --- video generation (Sora-shaped async) -------------------------------

export interface VideoCreateRequest {
	model: string;
	prompt: string;
	size?: string;
	seconds?: number;
	/**
	 * Optional reference image for I2V workflows. Sent as the
	 * `input_reference` multipart field — the bridge routes it to a
	 * ComfyUI workflow that has `image_inputs` declared.
	 */
	inputReference?: { bytes: Buffer; contentType: string };
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
	body: VideoCreateRequest,
	signal?: AbortSignal,
): Promise<VideoJob> {
	const url = `${endpoint.baseUrl}/videos`;
	const form = new FormData();
	form.append('model', body.model);
	form.append('prompt', body.prompt);
	if (body.size) form.append('size', body.size);
	if (body.seconds !== undefined) form.append('seconds', String(body.seconds));
	if (body.inputReference) {
		form.append(
			'input_reference',
			toBlob(body.inputReference.bytes, body.inputReference.contentType),
			filenameFor(body.inputReference.contentType),
		);
	}

	const res = await doFetch(
		url,
		{
			method: 'POST',
			headers: { ...authHeaders(endpoint) }, // do NOT set Content-Type — fetch handles multipart
			body: form,
			signal: composeSignals(AbortSignal.timeout(endpoint.requestTimeoutSeconds * 1000), signal),
		},
		`Network error contacting endpoint "${endpoint.id}" at ${url}`,
	);
	await ensureOk(res, `Endpoint "${endpoint.id}" returned HTTP ${res.status} from /videos`);
	return parseJson<VideoJob>(res, `Endpoint "${endpoint.id}" returned non-JSON from /videos`);
}

/**
 * DELETE /v1/videos/{id} — bridge-side cancellation. Releases the bridge's
 * runner slot. Best-effort: swallows errors (the worst case is the bridge
 * keeps running the job; the caller's local state is already terminal).
 */
export async function videoCancel(endpoint: LoadedEndpoint, videoId: string): Promise<void> {
	const url = `${endpoint.baseUrl}/videos/${encodeURIComponent(videoId)}`;
	try {
		await fetch(url, {
			method: 'DELETE',
			headers: authHeaders(endpoint),
			signal: AbortSignal.timeout(10_000),
		});
	} catch (e) {
		console.warn(`[videoCancel] best-effort DELETE for ${videoId} failed:`, e);
	}
}

/** GET /v1/videos/{id} for polling. */
export async function videoStatus(endpoint: LoadedEndpoint, videoId: string): Promise<VideoJob> {
	const url = `${endpoint.baseUrl}/videos/${encodeURIComponent(videoId)}`;
	const res = await doFetch(
		url,
		{
			method: 'GET',
			headers: authHeaders(endpoint),
			signal: AbortSignal.timeout(endpoint.requestTimeoutSeconds * 1000),
		},
		`Network error polling endpoint "${endpoint.id}" at ${url}`,
	);
	await ensureOk(
		res,
		`Endpoint "${endpoint.id}" returned HTTP ${res.status} from /videos/${videoId}`,
	);
	return parseJson<VideoJob>(
		res,
		`Endpoint "${endpoint.id}" returned non-JSON from /videos/${videoId}`,
	);
}

/** GET /v1/videos/{id}/content — raw mp4 bytes. Only valid once status === "completed". */
export async function videoFetchContent(
	endpoint: LoadedEndpoint,
	videoId: string,
): Promise<{ bytes: Buffer; contentType: string }> {
	const url = `${endpoint.baseUrl}/videos/${encodeURIComponent(videoId)}/content`;
	const res = await doFetch(
		url,
		{
			method: 'GET',
			headers: authHeaders(endpoint),
			// Extended timeout — large videos legitimately take a while to download.
			signal: AbortSignal.timeout(endpoint.requestTimeoutSeconds * 1000 * 5),
		},
		`Network error fetching video content at ${url}`,
	);
	await ensureOk(res, `Fetching video content returned HTTP ${res.status}`);
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
	urlString: string,
): Promise<{ bytes: Buffer; contentType: string }> {
	const res = await doFetch(
		urlString,
		{
			method: 'GET',
			headers: authHeaders(endpoint),
			signal: AbortSignal.timeout(endpoint.requestTimeoutSeconds * 1000),
		},
		`Network error fetching media from ${urlString}`,
	);
	await ensureOk(res, `Fetching media from ${urlString} returned HTTP ${res.status}`);
	const arrayBuf = await res.arrayBuffer();
	const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
	return { bytes: Buffer.from(arrayBuf), contentType };
}

/**
 * POST /v1/chat/completions against `endpoint`. Non-streaming only — used
 * for the JSON-mode response path (no `?stream=1`).
 *
 * `signal` is composed with the per-request timeout (same pattern as
 * `imageGeneration`), so a caller on an interruptible path — e.g. the image
 * prompt-enhancer, which runs inline before generation — can abort the call on
 * a user "Stop" instead of waiting out the full request timeout.
 */
export async function chatCompletionSync(
	endpoint: LoadedEndpoint,
	body: ChatCompletionRequest,
	signal?: AbortSignal,
): Promise<ChatCompletionResponse> {
	const url = `${endpoint.baseUrl}/chat/completions`;
	const res = await doFetch(
		url,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...authHeaders(endpoint),
			},
			body: JSON.stringify({ ...body, stream: false }),
			signal: composeSignals(AbortSignal.timeout(endpoint.requestTimeoutSeconds * 1000), signal),
		},
		`Network error contacting endpoint "${endpoint.id}" at ${url}`,
	);
	await ensureOk(
		res,
		`Endpoint "${endpoint.id}" returned HTTP ${res.status} from /chat/completions`,
	);
	return parseJson<ChatCompletionResponse>(res, `Endpoint "${endpoint.id}" returned non-JSON`);
}

export interface EmbeddingsRequest {
	model: string;
	input: string[];
}

export interface EmbeddingsResponse {
	data?: Array<{ embedding?: number[]; index?: number }>;
}

/**
 * POST /v1/embeddings — batched text → vectors. Mirrors `chatCompletionSync`
 * (auth, doFetch/ensureOk/parseJson) with one deliberate difference: it does
 * NOT impose `endpoint.requestTimeoutSeconds`. The embeddings timeout comes
 * from the `[embeddings]` config block, which the caller bakes into `signal`
 * via composeSignals — so this trusts the passed signal as the sole deadline.
 */
export async function embeddings(
	endpoint: LoadedEndpoint,
	body: EmbeddingsRequest,
	signal?: AbortSignal,
): Promise<EmbeddingsResponse> {
	const url = `${endpoint.baseUrl}/embeddings`;
	const res = await doFetch(
		url,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...authHeaders(endpoint),
			},
			body: JSON.stringify(body),
			signal,
		},
		`Network error contacting endpoint "${endpoint.id}" at ${url}`,
	);
	await ensureOk(res, `Endpoint "${endpoint.id}" returned HTTP ${res.status} from /embeddings`);
	return parseJson<EmbeddingsResponse>(
		res,
		`Endpoint "${endpoint.id}" returned non-JSON /embeddings`,
	);
}

export interface RerankRequest {
	model: string;
	query: string;
	documents: string[];
	topN: number;
}

/**
 * One scored candidate, normalized to `{ index, score }` regardless of wire
 * shape. `index` points back into the request's `documents` array.
 */
export interface RerankResult {
	index: number;
	score: number;
}

/**
 * Wire-shape variant for the rerank endpoint. The Cohere/Jina shape is the
 * default — `{ documents }` in, `{ results: [{ index, relevance_score }] }` out,
 * served under the endpoint's `/v1` base — and is what vLLM, llama.cpp
 * (`--reranking`), Infinity, Jina, and Cohere all speak. HF TEI diverges on all
 * three axes (`texts` in, a bare `[{ index, score }]` array out, served at the
 * server root rather than `/v1`), so it gets its own variant rather than a pile
 * of conditionals. Mirrors the `provider_quirk` / normalizers.ts pattern.
 */
export type RerankQuirk = 'tei';

/**
 * POST a rerank request and return candidates scored by relevance to the query.
 * Like `embeddings()`, the timeout lives in the caller's `signal` (from the
 * `[rerank]` config block) rather than `endpoint.requestTimeoutSeconds`.
 *
 * Results are normalized to `{ index, score }` and returned in the upstream's
 * order (descending relevance for every backend we target); the caller maps
 * `index` back onto its candidate set.
 */
export async function rerank(
	endpoint: LoadedEndpoint,
	body: RerankRequest,
	quirk: RerankQuirk | undefined,
	signal?: AbortSignal,
): Promise<RerankResult[]> {
	// TEI is served at the server root and takes `texts`; the Cohere/Jina shape
	// rides the endpoint's `/v1` base and takes `documents`. `baseUrl` already
	// carries the `/v1` suffix, so strip it for the TEI variant.
	const url =
		quirk === 'tei'
			? `${endpoint.baseUrl.replace(/\/v1\/?$/, '')}/rerank`
			: `${endpoint.baseUrl}/rerank`;
	const payload =
		quirk === 'tei'
			? { query: body.query, texts: body.documents }
			: { model: body.model, query: body.query, documents: body.documents, top_n: body.topN };

	const res = await doFetch(
		url,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...authHeaders(endpoint),
			},
			body: JSON.stringify(payload),
			signal,
		},
		`Network error contacting endpoint "${endpoint.id}" at ${url}`,
	);
	await ensureOk(res, `Endpoint "${endpoint.id}" returned HTTP ${res.status} from /rerank`);
	const parsed = await parseJson<unknown>(
		res,
		`Endpoint "${endpoint.id}" returned non-JSON /rerank`,
	);
	return normalizeRerankResponse(parsed);
}

/**
 * Coerce either wire shape into `RerankResult[]`. Cohere/Jina nest the array
 * under `results` with `relevance_score`; TEI returns a bare array with `score`.
 * Rows without a finite numeric `index` and `score` are dropped — the caller
 * can't place a row without an index, and a non-finite score (NaN/Infinity from
 * a misbehaving backend) would scramble the downstream sort.
 */
export function normalizeRerankResponse(parsed: unknown): RerankResult[] {
	const rows = Array.isArray(parsed)
		? parsed
		: Array.isArray((parsed as { results?: unknown }).results)
			? ((parsed as { results: unknown[] }).results as unknown[])
			: [];
	const out: RerankResult[] = [];
	for (const r of rows) {
		if (!r || typeof r !== 'object') continue;
		const row = r as { index?: unknown; relevance_score?: unknown; score?: unknown };
		const index = row.index;
		const score = typeof row.relevance_score === 'number' ? row.relevance_score : row.score;
		if (
			typeof index === 'number' &&
			Number.isFinite(index) &&
			typeof score === 'number' &&
			Number.isFinite(score)
		) {
			out.push({ index, score });
		}
	}
	return out;
}
