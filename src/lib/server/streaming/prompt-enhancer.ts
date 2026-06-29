/**
 * The image-prompt enhancement call. Given a raw image prompt and the target
 * model's preferred style, asks the configured enhancer LLM to rewrite the
 * prompt into that style (or, when the style is unknown, to clarify-only while
 * preserving the user's format). Returns the rewritten prompt.
 *
 * Non-fatal for FAILURES: any upstream error, timeout, or empty/garbage
 * response returns the ORIGINAL prompt with `changed: false` — enhancement is
 * an optimization, never a gate. The ONE exception is a user Stop (the abort
 * signal): that RE-THROWS so the relay's prepare step cancels the whole
 * generation, rather than quietly proceeding to generate from the original.
 *
 * The auxiliary call mirrors the title task (`title-generator.ts`): a single
 * `chatCompletionSync` against a resolved utility model, prompt wrapped in
 * tags so a weak model reads it as data to transform rather than a turn to
 * continue.
 */

import { logLevel } from '../env';
import { chatCompletionSync, UpstreamError } from '../endpoints/client';
import { isAbortError } from './sse-transport';
import type { ResolvedImageEnhancerModel } from '../tasks/image-enhancer-model';
import {
	CLARIFY_ONLY_INSTRUCTION,
	ENHANCER_BASE,
	STYLE_INSTRUCTIONS,
	type PromptStyle,
} from './prompt-styles';

const DEBUG = logLevel() === 'debug';

export interface EnhancePromptInput {
	prompt: string;
	/** The target model's style, or null to run the format-preserving clarify-only pass. */
	style: PromptStyle | null;
	/** Optional per-model freeform nudge appended after the style instruction. */
	hint?: string | null;
	model: ResolvedImageEnhancerModel;
	/** The relay's abort signal — lets a user "Stop" during the (inline)
	 *  enhancing phase abort the call instead of waiting out its timeout. */
	signal?: AbortSignal;
}

export interface EnhancePromptResult {
	enhanced: string;
	/** True when the enhancer MEANINGFULLY rewrote the prompt. Differences that are
	 *  only a trailing period or surrounding whitespace don't count (see
	 *  {@link trivialNormalize}) — a clarify-only pass that just appends a full
	 *  stop shouldn't surface the enhanced-vs-original split. */
	changed: boolean;
}

/** Compose the enhancer system prompt: shared base + style (or clarify-only) +
 *  per-model hint + any operator override of the style instruction. */
function buildSystemPrompt(
	style: PromptStyle | null,
	hint: string | null | undefined,
	overrides: Record<string, string>,
): string {
	const styleInstruction =
		style === null ? CLARIFY_ONLY_INSTRUCTION : (overrides[style] ?? STYLE_INSTRUCTIONS[style]);
	const parts = [ENHANCER_BASE, styleInstruction];
	if (hint && hint.trim()) {
		parts.push(`Additional guidance for this specific model:\n${hint.trim()}`);
	}
	return parts.join('\n\n');
}

export async function enhancePrompt(input: EnhancePromptInput): Promise<EnhancePromptResult> {
	const original = input.prompt;
	const trimmed = original.trim();
	// Nothing to enhance — an empty prompt (e.g. an image-only edit that slipped
	// through) is passed through untouched.
	if (!trimmed) return { enhanced: original, changed: false };

	const system = buildSystemPrompt(input.style, input.hint, input.model.styleInstructionOverrides);
	// Wrap the prompt in tags so a weak enhancer reads it as data to rewrite,
	// not a conversation to continue (same trick as the title task's
	// <conversation> wrap).
	const user = `Rewrite this image prompt:\n\n<prompt>\n${trimmed}\n</prompt>`;

	let content: string;
	try {
		const resp = await chatCompletionSync(
			input.model.endpoint,
			{
				model: input.model.upstreamId,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user },
				],
				max_tokens: input.model.maxTokens,
				temperature: input.model.temperature,
			},
			input.signal,
		);
		content = resp.choices?.[0]?.message?.content ?? '';
	} catch (e) {
		// A user Stop (the relay's abort signal firing mid-call) must cancel the
		// WHOLE generation, not silently fall back to the original prompt — so
		// re-throw it and let the relay's prepare step emit Cancelled + close.
		// Everything else (timeout, 5xx, network, garbage) is a genuine failure
		// and stays non-fatal: use the original prompt.
		if (isAbortError(e) || input.signal?.aborted) throw e;
		const cause =
			e instanceof UpstreamError ? e.message : e instanceof Error ? e.message : String(e);
		if (DEBUG) console.debug(`[prompt-enhancer] call failed, using original: ${cause}`);
		return { enhanced: original, changed: false };
	}

	const enhanced = sanitizeEnhanced(content);
	if (!enhanced) {
		if (DEBUG) console.debug('[prompt-enhancer] empty/garbage response, using original');
		return { enhanced: original, changed: false };
	}

	// "Changed" decides whether we store the original alongside the enhanced (the
	// lightbox's enhanced-vs-original split). Ignore generation-irrelevant
	// trivia so a clarify-only pass that only appends a full stop (or fiddles
	// surrounding whitespace) doesn't surface a spurious split — when the only
	// diff is that noise, we treat it as unchanged and keep the user's prompt.
	const changed = trivialNormalize(enhanced) !== trivialNormalize(trimmed);
	if (DEBUG && changed) {
		console.debug(
			`[prompt-enhancer] style=${input.style ?? 'clarify-only'} "${trimmed.slice(0, 40)}…" → "${enhanced.slice(0, 40)}…"`,
		);
	}
	return { enhanced, changed };
}

/**
 * Normalize away differences that don't matter to an image model when deciding
 * whether the enhancer actually changed the prompt: surrounding whitespace and
 * trailing periods/whitespace (a weak clarify-only pass often just appends a
 * full stop). Used only for the changed/unchanged comparison — the real
 * enhanced text is stored verbatim when a genuine change survives this. Note
 * `!`/`?` are deliberately preserved, as those read as intentional emphasis.
 * Exported for testing.
 */
export function trivialNormalize(s: string): string {
	return s.trim().replace(/[.\s]+$/, '');
}

/**
 * Strip the decorations a chat model habitually wraps around a single-block
 * output even when told not to: surrounding code fences, a leading
 * "Prompt:"/"Enhanced prompt:" label, and surrounding quotes. Exported for
 * testing.
 */
export function sanitizeEnhanced(raw: string): string {
	let s = raw.trim();
	// Strip a ```/```lang fenced block if the whole response is one.
	const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(s);
	if (fence) s = fence[1].trim();
	// Strip a leading "Prompt:" / "Enhanced prompt -" style label.
	s = s.replace(/^\s*(?:enhanced\s+)?prompt\s*[:\-]\s*/i, '');
	// Strip a single surrounding pair of quotes.
	if (s.length >= 2) {
		const pairs: Array<[string, string]> = [
			['"', '"'],
			["'", "'"],
			['“', '”'],
		];
		for (const [open, close] of pairs) {
			if (s.startsWith(open) && s.endsWith(close)) {
				s = s.slice(open.length, s.length - close.length).trim();
				break;
			}
		}
	}
	return s.trim();
}
