/**
 * Shared pre-slot prompt-enhancement step for the media relays (image + video).
 *
 * Both relays run enhancement identically: as the relay's PRE-SLOT `prepare`
 * phase, so it does NOT hold the (single-GPU) generation slot while doing the
 * LLM rewrite — it acquires the ENHANCER endpoint's own slot instead. If that's
 * the same endpoint as the generation model, the two serialize; separate
 * endpoints pipeline. The only per-medium differences are which style set the
 * raw style normalizes against and the enhancer's template pack (selected by
 * `medium`), so the whole flow lives here and each relay passes its `medium`.
 *
 * Strictly non-fatal by construction: `enhancePrompt` swallows its own
 * failures (timeout / 5xx / garbage) and returns the original prompt. The one
 * thing that propagates is a user Stop (the abort signal) — it re-throws so the
 * `media-relay` scaffold's prepare handler turns it into a Cancelled and closes,
 * rather than quietly generating from the un-enhanced prompt.
 */

import { acquireEndpointSlot, type EndpointSlot } from '../endpoints/concurrency';
import { getImageEnhancerModel } from '../tasks/image-enhancer-model';
import { enhancePrompt, type EnhancerMedium } from './prompt-enhancer';
import { normalizeStyle } from './prompt-styles';
import { normalizeVideoStyle } from './prompt-styles-video';
import type { StreamProgressEvent } from '$lib/types/api';

export interface MediaEnhanceInput {
	/** The user's raw prompt. */
	prompt: string;
	/** Which medium's style pack + normalizer to use. */
	medium: EnhancerMedium;
	/**
	 * True only for a fresh text-to-media generation. Enhancement is skipped for
	 * an edit / reference-frame send (i2i edit instruction, i2v anchor frame) —
	 * that prompt isn't a scene description to rewrite.
	 */
	isTextToMedia: boolean;
	/** Whether the per-conversation feature toggle is on for this send. */
	enabled: boolean | undefined;
	/** Target model's preferred style (raw or canonical) — normalized here
	 *  against `medium`. Null/unknown runs the format-preserving clarify-only pass. */
	promptStyle?: string | null;
	/** Per-model freeform enhancer hint, or null. */
	promptHint?: string | null;
}

export interface MediaEnhanceResult {
	/** What to actually generate from: the enhanced prompt when it meaningfully
	 *  changed, else the verbatim prompt. */
	effectivePrompt: string;
	/** The user's pre-enhancement prompt, only when enhancement changed it (so a
	 *  caller records the original-vs-enhanced split); null otherwise. */
	originalPrompt: string | null;
}

/**
 * Run the prompt-enhancement pass for one media send. Returns the prompt to
 * generate from (+ the original when it changed). A no-op — returning the raw
 * prompt unchanged — when enhancement is off, the send is an edit/reference,
 * or no enhancer model is configured. Emits the transient "Enhancing prompt…"
 * status via `ctx.write` (which also doubles as the fan-out dispatch-release
 * signal, so it's emitted before waiting on the enhancer slot).
 */
export async function runPromptEnhancement(
	input: MediaEnhanceInput,
	ctx: { write: (e: StreamProgressEvent) => void; abortSignal?: AbortSignal },
): Promise<MediaEnhanceResult> {
	const passthrough: MediaEnhanceResult = { effectivePrompt: input.prompt, originalPrompt: null };
	if (!input.isTextToMedia || !input.enabled) return passthrough;
	const enhancerModel = getImageEnhancerModel();
	if (!enhancerModel) return passthrough;

	ctx.write({ type: 'progress', percent: null, status: 'Enhancing prompt…' });
	let enhSlot: EndpointSlot | null = null;
	try {
		enhSlot = await acquireEndpointSlot(
			enhancerModel.endpoint.id,
			enhancerModel.endpoint.maxConcurrent,
			{ signal: ctx.abortSignal },
		);
		const normalize = input.medium === 'video' ? normalizeVideoStyle : normalizeStyle;
		const { enhanced, changed } = await enhancePrompt({
			prompt: input.prompt,
			medium: input.medium,
			style: normalize(input.promptStyle),
			hint: input.promptHint,
			model: enhancerModel,
			signal: ctx.abortSignal,
		});
		return changed ? { effectivePrompt: enhanced, originalPrompt: input.prompt } : passthrough;
	} finally {
		enhSlot?.release();
	}
	// No explicit "clear" event: the branch next acquires the generation slot and
	// emits `queued`/`start`, and both clients clear the enhancing status on
	// those — so it doesn't stick into the generating phase.
}
