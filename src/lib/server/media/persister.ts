/**
 * Pulls media bytes from an upstream response (URL or b64) into our local
 * MediaStore + DB. Returns the new media id so the caller can attach it to
 * a message via linkMessageMedia.
 *
 * Why we fetch + store immediately on generation rather than passing the
 * upstream URL through to the client: openai-api-bridge evicts files on a
 * TTL/LRU schedule (see its README), so the upstream URL goes stale. We own
 * durability of the asset; the bridge is a transient cache.
 */

import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { fetchUpstreamBytes } from '../endpoints/client';
import type { LoadedEndpoint } from '../endpoints/config';
import { insertMedia } from '../db/queries/media';
import { getMediaStore } from './disk-store';
import { truncateEllipsis } from '$lib/text';

const PROMPT_EXCERPT_MAX = 500;

/** Build the {full, excerpt} pair for a generated-media prompt. Excerpt is
 *  capped for space-constrained UI surfaces (gallery thumbs, lightbox
 *  caption); full is untruncated for "Regenerate with this prompt" flows
 *  where silently dropping the tail of a long prompt would corrupt the
 *  generation. Both go on the media row. */
function promptFields(prompt: string): { promptFull: string; promptExcerpt: string } {
	return {
		promptFull: prompt,
		promptExcerpt: truncateEllipsis(prompt, PROMPT_EXCERPT_MAX),
	};
}

interface PersistImageInput {
	userId: string;
	endpoint: LoadedEndpoint;
	sourceModel: string;
	/** The prompt that actually generated the image — the ENHANCED prompt when
	 *  enhancement ran, else the verbatim user prompt. Stored as promptFull. */
	prompt: string;
	/** The user's pre-enhancement prompt, when the enhancer rewrote `prompt`.
	 *  Null when no enhancement happened. */
	originalPrompt?: string | null;
	urlOrB64: { url?: string; b64_json?: string };
	/** Input image this edit was produced from (i2i), for provenance + the
	 *  split-attachments grid. Null for text-to-image. */
	sourceMediaId?: string | null;
}

export async function persistGeneratedImage(input: PersistImageInput): Promise<string> {
	const { bytes, contentType } = await resolveBytes(input.endpoint, input.urlOrB64);
	const store = getMediaStore();
	const ref = await store.put({ bytes, contentType, kind: 'image' });
	const { id } = insertMedia({
		userId: input.userId,
		storagePath: ref.storagePath,
		contentType: ref.contentType,
		byteSize: ref.byteSize,
		kind: 'image',
		sourceEndpointId: input.endpoint.id,
		sourceModel: input.sourceModel,
		sourceMediaId: input.sourceMediaId ?? null,
		originalPrompt: input.originalPrompt ?? null,
		...promptFields(input.prompt),
	});
	return id;
}

interface PersistVideoInput {
	userId: string;
	endpoint: LoadedEndpoint;
	sourceModel: string;
	/** The prompt that actually generated the video — the ENHANCED prompt when
	 *  enhancement ran, else the verbatim user prompt. Stored as promptFull. */
	prompt: string;
	/** The user's pre-enhancement prompt, when the enhancer rewrote `prompt`.
	 *  Null when no enhancement happened. */
	originalPrompt?: string | null;
	stream: Readable;
	contentType: string;
	/** Input image this video was animated from (i2v). Null for text-to-video. */
	sourceMediaId?: string | null;
}

/** Persist a video stream directly to the media store without buffering in memory. */
export async function persistGeneratedVideo(input: PersistVideoInput): Promise<string> {
	const store = getMediaStore();
	const ref = await store.putStream({
		stream: input.stream,
		contentType: input.contentType || 'video/mp4',
		kind: 'video',
	});
	const { id } = insertMedia({
		userId: input.userId,
		storagePath: ref.storagePath,
		contentType: ref.contentType,
		byteSize: ref.byteSize,
		kind: 'video',
		sourceEndpointId: input.endpoint.id,
		sourceModel: input.sourceModel,
		sourceMediaId: input.sourceMediaId ?? null,
		originalPrompt: input.originalPrompt ?? null,
		...promptFields(input.prompt),
	});
	return id;
}

async function resolveBytes(
	endpoint: LoadedEndpoint,
	urlOrB64: { url?: string; b64_json?: string },
): Promise<{ bytes: Buffer; contentType: string }> {
	if (urlOrB64.b64_json) {
		// Bridge / OpenAI default to PNG when returning b64_json with no
		// MIME hint. We assume PNG; if a future upstream supplies a hint
		// (data URL prefix etc.) we can parse it here.
		return { bytes: Buffer.from(urlOrB64.b64_json, 'base64'), contentType: 'image/png' };
	}
	if (urlOrB64.url) {
		// Relative URL (e.g. "/v1/files/abc/content") resolves against the
		// endpoint's base URL and is trusted by construction — it lives on
		// the same host the operator configured. An absolute URL is the
		// untrusted case: a compromised or malicious upstream could point
		// us at 169.254.169.254 (cloud metadata) or an internal admin URL.
		// Allow it only when it stays on the configured endpoint's host, or
		// when the hostname is publicly routable. The most common
		// legitimate off-host case is OpenAI's image responses, which
		// return Azure-blob CDN URLs distinct from api.openai.com.
		if (urlOrB64.url.startsWith('http')) {
			let parsed: URL;
			try {
				parsed = new URL(urlOrB64.url);
			} catch {
				throw new Error(`Image generation response url is not a valid URL: ${urlOrB64.url}`);
			}
			const endpointHost = new URL(endpoint.baseUrl).hostname.toLowerCase();
			const offHost = parsed.hostname.toLowerCase() !== endpointHost;
			// Off-host absolute URLs are untrusted: guard every redirect hop
			// against the SSRF ranges (a public host can still 302 into the LAN
			// or the cloud-metadata endpoint). On-host URLs are the configured
			// backend — trusted, and may live on localhost/LAN — so they follow
			// redirects normally with the endpoint credential.
			return fetchUpstreamBytes(endpoint, urlOrB64.url, { guardRedirects: offHost });
		}
		const absolute = new URL(urlOrB64.url, endpoint.baseUrl + '/').toString();
		return fetchUpstreamBytes(endpoint, absolute);
	}
	throw new Error('Image generation response had neither url nor b64_json');
}
