/**
 * Streaming image-generation relay — the one and only image-generation path,
 * used unconditionally by both a single-mode send and each multi-model fan-out
 * branch (the route streams image regardless; there's no sync POST→JSON variant
 * anymore).
 *
 * The full relay lifecycle (slot/queued, start, title, persist as a sibling,
 * regenerate replace-delete, notify, done) lives in the shared `startMediaRelay`
 * scaffold — see media-relay.ts for why streaming a one-shot generate matters
 * (the per-endpoint concurrency slot makes queued-vs-generating observable).
 * This module supplies only the image-specific `generate` step: i2i when input
 * images are attached, else t2i, then persist the result.
 */

import { imageEdit, imageGeneration, type ImageEditInputFile } from '../endpoints/client';
import type { LoadedEndpoint } from '../endpoints/config';
import { logLevel } from '../env';
import { loadMediaBytes } from '../media/data-url';
import { persistGeneratedImage } from '../media/persister';
import { startMediaRelay, type MediaRelayParams } from './media-relay';
import { errorMessage, isAbortError } from './sse-transport';
import type { StreamErrorEvent } from '$lib/types/api';

const DEBUG = logLevel() === 'debug';

export interface ImageRelayParams extends MediaRelayParams {
	/** The bare upstream model id sent to the endpoint. */
	upstreamModelId: string;
	prompt: string;
	/** Image ids to forward as i2i input (empty = text-to-image). */
	dispatchMediaIds: string[];
	/** Provenance: the (first) input image, for the split grid. Null for t2i. */
	sourceMediaId: string | null;
}

export function startImageRelay(params: ImageRelayParams): ReadableStream<Uint8Array> {
	return startMediaRelay(params, async ({ write, abortSignal }) => {
		try {
			// I2I when input images are attached, else T2I. The bridge consumes
			// repeated `image` fields in order for multi-input ComfyUI workflows.
			let upstream;
			if (params.dispatchMediaIds.length > 0) {
				const images: ImageEditInputFile[] = [];
				for (const mid of params.dispatchMediaIds) {
					const loaded = await loadMediaBytes(mid, params.userId);
					images.push({ bytes: loaded.bytes, contentType: loaded.contentType });
				}
				upstream = await imageEdit(
					params.endpoint,
					{
						model: params.upstreamModelId,
						prompt: params.prompt,
						images,
						n: 1,
						response_format: 'url',
					},
					abortSignal,
				);
			} else {
				upstream = await imageGeneration(
					params.endpoint,
					{
						model: params.upstreamModelId,
						prompt: params.prompt,
						n: 1,
						response_format: 'url',
					},
					abortSignal,
				);
			}
			const result = upstream.data?.[0];
			if (!result || (!result.url && !result.b64_json)) {
				throw new Error('Upstream returned no image data');
			}
			const mediaId = await persistGeneratedImage({
				userId: params.userId,
				endpoint: params.endpoint,
				sourceModel: params.storedModelId,
				prompt: params.prompt,
				urlOrB64: { url: result.url, b64_json: result.b64_json },
				sourceMediaId: params.sourceMediaId,
			});
			return {
				part: { type: 'image', mediaId },
				mediaId,
				rawResponseJson: JSON.stringify(upstream),
				modality: 'image',
			};
		} catch (e) {
			// A Stop click aborts the upstream fetch — treat as a cancellation (no
			// noisy "failed" message), else surface it. Returning null bails.
			if (isAbortError(e) || abortSignal?.aborted) {
				write({ type: 'error', message: 'Cancelled' } satisfies StreamErrorEvent);
			} else {
				const msg = errorMessage(e);
				if (DEBUG) console.error('[image-relay] generation failed:', msg);
				write({ type: 'error', message: msg } satisfies StreamErrorEvent);
			}
			return null;
		}
	});
}
