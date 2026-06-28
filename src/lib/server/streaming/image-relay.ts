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
import { logLevel } from '../env';
import { loadMediaBytes } from '../media/data-url';
import { persistGeneratedImage } from '../media/persister';
import { getImageEnhancerModel } from '../tasks/image-enhancer-model';
import { enhancePrompt } from './prompt-enhancer';
import { normalizeStyle } from './prompt-styles';
import { startMediaRelay, type MediaRelayParams } from './media-relay';
import { errorMessage, isAbortError } from './sse-transport';
import type { StreamErrorEvent, StreamProgressEvent } from '$lib/types/api';

const DEBUG = logLevel() === 'debug';

export interface ImageRelayParams extends MediaRelayParams {
	/** The bare upstream model id sent to the endpoint. */
	upstreamModelId: string;
	prompt: string;
	/** Image ids to forward as i2i input (empty = text-to-image). */
	dispatchMediaIds: string[];
	/** Provenance: the (first) input image, for the split grid. Null for t2i. */
	sourceMediaId: string | null;
	/** Target model's preferred prompt style (canonical key) or null when
	 *  unknown — null runs the enhancer's format-preserving clarify-only pass. */
	promptStyle?: string | null;
	/** Per-model freeform enhancer hint, or null. */
	promptHint?: string | null;
	/** Whether image-prompt enhancement is enabled for this send (the feature
	 *  category is not in the conversation's disabledFeatures). */
	enhancementEnabled?: boolean;
}

export function startImageRelay(params: ImageRelayParams): ReadableStream<Uint8Array> {
	return startMediaRelay(params, async ({ write, abortSignal }) => {
		try {
			// Optional prompt enhancement (text-to-image only — an i2i prompt is an
			// edit instruction, not a scene description, so reformatting it into a
			// model's style is wrong). Gated on the feature toggle + a configured
			// enhancer model. Strictly non-fatal: enhancePrompt swallows its own
			// failures and returns the original, so a down enhancer never blocks
			// generation. `promptFull` ends up holding what actually generated the
			// image; `originalPrompt` preserves the user's text only when it changed.
			let effectivePrompt = params.prompt;
			let originalPrompt: string | null = null;
			const isT2I = params.dispatchMediaIds.length === 0;
			if (isT2I && params.enhancementEnabled) {
				const enhancerModel = getImageEnhancerModel();
				if (enhancerModel) {
					write({
						type: 'progress',
						percent: null,
						status: 'Enhancing prompt…',
					} satisfies StreamProgressEvent);
					const { enhanced, changed } = await enhancePrompt({
						prompt: params.prompt,
						style: normalizeStyle(params.promptStyle),
						hint: params.promptHint,
						model: enhancerModel,
					});
					if (changed) {
						effectivePrompt = enhanced;
						originalPrompt = params.prompt;
					}
				}
			}

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
						prompt: effectivePrompt,
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
						prompt: effectivePrompt,
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
				prompt: effectivePrompt,
				originalPrompt,
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
			// noisy "failed" message) and bail quietly (return null). A genuine
			// failure emits the error event AND returns a MediaFailure so the
			// scaffold persists a durable error sibling (recoverable after a
			// disconnect, same as the video path).
			if (isAbortError(e) || abortSignal?.aborted) {
				write({ type: 'error', message: 'Cancelled' } satisfies StreamErrorEvent);
				return null;
			}
			const msg = errorMessage(e);
			if (DEBUG) console.error('[image-relay] generation failed:', msg);
			write({ type: 'error', message: msg } satisfies StreamErrorEvent);
			return { error: msg };
		}
	});
}
