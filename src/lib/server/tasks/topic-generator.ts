/**
 * Memory-topic task. Generates the short `[id] topic` label shown for a saved
 * memory in the over-budget memory index, using the configured task model — the
 * same tier that generates conversation titles. Labelling one sentence in a few
 * words is title-generation difficulty, so a weak task model handles it.
 *
 * Used only by the phase-3 topic-backfill worker to fill the historical backlog
 * of rows created before `topic` existed (new rows get a model-authored topic
 * from the save_memory/update_memory tools). It writes only the `topic` column,
 * never the memory `content`, so a mislabel never damages the underlying fact.
 *
 * `generateMemoryTopic` returns null on an empty/garbage response but lets an
 * upstream error propagate, so the worker can tell "endpoint down → retry the
 * whole sweep later" from "model produced nothing → write a content-derived
 * fallback so the row still drains."
 */

import { chatCompletionSync } from '../endpoints/client';
import type { LoadedEndpoint } from '../endpoints/config';
import type { ResolvedTaskModel } from './task-model';
import { sanitizeModelLabel } from './sanitize-label';
import { truncateEllipsis } from '$lib/text';

// Matches the cap the save_memory tool enforces on model-authored topics, so a
// backfilled label and a tool-authored one render at the same scale.
const MAX_TOPIC_CHARS = 80;
// Memories are capped at 500 chars by the tool, but guard anyway for legacy rows.
const CONTENT_TRUNCATE_CHARS = 500;

const SYSTEM_PROMPT =
	'You label a saved note about a user with a short topic. ' +
	'Output a 3-6 word topic naming what the note is about (e.g. "Dietary preferences", "Employer", "Kids\' names"). ' +
	'Output only the topic — no quotes, no trailing punctuation, no preamble.';

// Restated after the content so a weaker model that might continue the note
// instead of labelling it is pulled back on task by the last tokens it reads.
const TRAILER_INSTRUCTION =
	'Give a 3-6 word topic naming what the note above is about. ' +
	'Output the topic only — no quotes, no trailing punctuation, no preamble.';

interface TaskMessage {
	role: 'system' | 'user';
	content: string;
}

/**
 * Generate a topic label for a memory's content. Returns the sanitized label, or
 * null when the content is empty or the model returned nothing usable. Lets an
 * upstream error (timeout / endpoint down) propagate — the caller decides
 * whether that's retryable. `model` is resolved by the caller (once per sweep),
 * not here, so the worker doesn't re-resolve per row.
 */
export async function generateMemoryTopic(
	model: ResolvedTaskModel,
	content: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const messages = buildTopicPrompt(content);
	if (!messages) return null;
	const raw = await callTaskModel(model.endpoint, model.upstreamId, messages, signal);
	const topic = sanitizeTopic(raw);
	return topic || null;
}

/**
 * A last-resort topic when the model returns nothing usable: the first few words
 * of the content, so the row still drains (its label ≈ the content snippet the
 * index would otherwise show for a null topic) instead of re-queueing forever.
 */
export function fallbackTopic(content: string): string {
	const words = content.trim().split(/\s+/).slice(0, 8).join(' ');
	return truncateEllipsis(words, MAX_TOPIC_CHARS) || 'Saved note';
}

/**
 * Build the chat-completions messages for the topic task. Exported for testing;
 * returns null when the content is empty (nothing to label). Wraps the note in
 * `<memory>` tags so the model reads it as data, not an instruction to follow.
 */
export function buildTopicPrompt(content: string): TaskMessage[] | null {
	const trimmed = content.trim();
	if (!trimmed) return null;
	const body = `<memory>\n${truncateEllipsis(trimmed, CONTENT_TRUNCATE_CHARS)}\n</memory>\n\n${TRAILER_INSTRUCTION}`;
	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: body },
	];
}

/**
 * Strip the decorations LLMs habitually add to short outputs — surrounding
 * quotes, a leading "Topic:" label, trailing punctuation — collapse whitespace,
 * and length-cap. Exported for testing. (Same shape as title-generator's
 * `sanitizeTitle`, retuned for the "Topic:" prefix and topic length.)
 */
export function sanitizeTopic(raw: string): string {
	return sanitizeModelLabel(raw, { labelWord: 'topic', maxChars: MAX_TOPIC_CHARS });
}

async function callTaskModel(
	endpoint: LoadedEndpoint,
	upstreamId: string,
	messages: TaskMessage[],
	signal?: AbortSignal,
): Promise<string> {
	const resp = await chatCompletionSync(
		endpoint,
		{
			model: upstreamId,
			messages,
			// A few words fit in well under 24 tokens; the cap keeps a chatty model
			// from running away.
			max_tokens: 24,
			temperature: 0.3,
		},
		signal,
	);
	return resp.choices?.[0]?.message?.content ?? '';
}
