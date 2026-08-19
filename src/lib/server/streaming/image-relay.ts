/**
 * Streaming image-generation relay — the one and only image-generation path,
 * used unconditionally by both a single-mode send and each multi-model fan-out
 * branch (the route streams image regardless; there's no sync POST→JSON variant
 * anymore).
 *
 * The full relay lifecycle (slot/queued, start, title, persist as a sibling,
 * notify, done) lives in the shared `startMediaRelay`
 * scaffold — see media-relay.ts for why streaming a one-shot generate matters
 * (the per-endpoint concurrency slot makes queued-vs-generating observable).
 * This module supplies only the image-specific `generate` step: i2i when input
 * images are attached, else t2i, then persist the result.
 */

import { imageEdit, imageGeneration, type ImageEditInputFile } from '../endpoints/client';
import { logLevel } from '../env';
import { loadMediaBytes } from '../media/data-url';
import { persistGeneratedImage } from '../media/persister';
import { runPromptEnhancement } from './media-enhance';
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
	/** Narrows the base's optional `sourceMediaId` to REQUIRED here: an image
	 *  dispatch always knows whether it has an input, so state it (`null` for
	 *  t2i) rather than letting a future call site omit it silently. */
	sourceMediaId: string | null;
	/** Target model's preferred prompt style (canonical key) or null when
	 *  unknown — null runs the enhancer's format-preserving clarify-only pass. */
	promptStyle?: string | null;
	/** Per-model freeform enhancer hint, or null. */
	promptHint?: string | null;
	/** Whether image-prompt enhancement is enabled for this send (the feature
	 *  category is not in the conversation's disabledFeatures). */
	enhancementEnabled?: boolean;
	/**
	 * Persist the result as a display-only image — rendered in the thread but
	 * never sent upstream. Set by avatar generation: the portrait should be
	 * visible at full size (32px tells you nothing), but re-sending it every
	 * turn is rent for what the description beside it already says in text.
	 * See the `displayOnly` note on the image MessagePart.
	 */
	displayOnly?: boolean;
}

export function startImageRelay(params: ImageRelayParams): ReadableStream<Uint8Array> {
	// `effectivePrompt` is what actually generates the image (the enhanced prompt
	// when enhancement changed it, else the verbatim prompt); `originalPrompt`
	// preserves the user's text only when it changed. Both are populated by the
	// prepare step below and read by the generate step.
	let effectivePrompt = params.prompt;
	let originalPrompt: string | null = null;

	// Prompt enhancement runs as the relay's PRE-SLOT prepare step (shared with
	// the video relay — see `media-enhance.ts`). Text-to-image only: an i2i
	// prompt is an edit instruction, not a scene to rewrite.
	const prepare = async (ctx: {
		write: (e: StreamProgressEvent) => void;
		abortSignal?: AbortSignal;
	}) => {
		const r = await runPromptEnhancement(
			{
				prompt: params.prompt,
				medium: 'image',
				isTextToMedia: params.dispatchMediaIds.length === 0,
				enabled: params.enhancementEnabled,
				promptStyle: params.promptStyle,
				promptHint: params.promptHint,
			},
			ctx,
		);
		effectivePrompt = r.effectivePrompt;
		originalPrompt = r.originalPrompt;
	};

	return startMediaRelay({ ...params, prepare }, async ({ write, abortSignal }) => {
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
				part: params.displayOnly
					? { type: 'image', mediaId, displayOnly: true }
					: { type: 'image', mediaId },
				mediaId,
				rawResponseJson: JSON.stringify(upstream),
				modality: 'image',
			};
		} catch (e) {
			// A Stop click aborts the upstream fetch — treat as a cancellation (no
			// noisy "failed" message) and bail quietly (return null). A genuine
			// failure returns a MediaFailure and leaves the `error` frame to the
			// scaffold, which persists a durable error sibling first and emits the
			// frame with that row's id (same as the video path).
			if (isAbortError(e) || abortSignal?.aborted) {
				write({ type: 'error', message: 'Cancelled' } satisfies StreamErrorEvent);
				return null;
			}
			const msg = errorMessage(e);
			if (DEBUG) console.error('[image-relay] generation failed:', msg);
			return { error: msg };
		}
	});
}
