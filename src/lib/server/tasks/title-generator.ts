/**
 * Conversation-title task. Builds a small chat-completion request against
 * the configured task model and writes the resulting title back to the
 * conversation row via the conditional fallback-only UPDATE — so a
 * user-rename racing with this task is preserved.
 *
 * The prompt mode is hybrid by modality:
 *   - When the first assistant message has text content (the text-chat
 *     case), the user message AND assistant message both go into the
 *     prompt. The assistant response often disambiguates the topic
 *     ("what does this mean?" → "TypeScript generics explanation"),
 *     which prompt-only titles couldn't capture.
 *   - When the first assistant message is missing or has no text (the
 *     image/video case — title gen runs concurrently with asset
 *     generation, and the asset doesn't carry text), only the user's
 *     prompt feeds the task model. The prompt IS the conversation topic
 *     in those modalities.
 *
 * Failures are non-fatal: task model unset, upstream error, timeout, or
 * empty/garbage response all return null and leave the row's fallback
 * title in place.
 */

import { logLevel } from '../env';
import { chatCompletionSync, UpstreamError } from '../endpoints/client';
import type { LoadedEndpoint } from '../endpoints/config';
import {
	getConversationFirstExchange,
	setConversationTitleIfFallback
} from '../db/queries/conversations';
import { getTaskModel, type ResolvedTaskModel } from './task-model';
import { truncateEllipsis } from '$lib/text';

const DEBUG = logLevel() === 'debug';

const PROMPT_TRUNCATE_CHARS = 500;
const MAX_TITLE_CHARS = 100;

const SYSTEM_PROMPT =
	'Generate a 3-7 word title that captures the topic of this conversation. ' +
	'Output only the title — no quotes, no trailing punctuation, no preamble.';

// Restated after the content. Without a trailing reminder, weaker task models
// see a transcript ending in a truncated Assistant turn and continue it
// (e.g. write more of the user's story) instead of titling it. Having the
// last tokens before generation say "title only" pulls them back on task.
const TRAILER_INSTRUCTION =
	'Write a 3-7 word title summarizing the topic of the conversation above. ' +
	'Output the title only — no quotes, no trailing punctuation, no preamble.';

export interface GenerateTitleResult {
	title: string;
	persisted: boolean;
}

/**
 * Run the title task for `conversationId`. Returns the generated title
 * (whether or not it was persisted; persistence loses to a concurrent
 * user-rename, in which case `persisted: false`) or `null` when title
 * generation was skipped/failed and the fallback should remain.
 *
 * `taskModel` is an injection seam for tests; production callers leave
 * it undefined to use the resolved global task model.
 */
export async function generateConversationTitle(
	conversationId: string,
	opts: { taskModel?: ResolvedTaskModel | null } = {}
): Promise<GenerateTitleResult | null> {
	const taskModel = opts.taskModel === undefined ? getTaskModel() : opts.taskModel;
	if (!taskModel) {
		if (DEBUG) console.debug('[title-gen] no task_model configured; skipping');
		return null;
	}

	const exchange = getConversationFirstExchange(conversationId);
	if (!exchange) {
		if (DEBUG) console.debug(`[title-gen] no first exchange for ${conversationId}; skipping`);
		return null;
	}

	const promptMessages = buildTitlePrompt(exchange);
	if (!promptMessages) {
		if (DEBUG)
			console.debug(`[title-gen] empty prompt for ${conversationId}; skipping`);
		return null;
	}

	let upstreamContent: string;
	try {
		upstreamContent = await callTaskModel(taskModel.endpoint, taskModel.upstreamId, promptMessages);
	} catch (e) {
		const cause = e instanceof UpstreamError ? e.message : e instanceof Error ? e.message : String(e);
		if (DEBUG) console.debug(`[title-gen] task model call failed for ${conversationId}: ${cause}`);
		return null;
	}

	const title = sanitizeTitle(upstreamContent);
	if (!title) {
		if (DEBUG)
			console.debug(`[title-gen] task model returned empty/garbage for ${conversationId}`);
		return null;
	}

	const persisted = setConversationTitleIfFallback(conversationId, title);
	if (DEBUG)
		console.debug(
			`[title-gen] ${conversationId} → "${title}" (${persisted ? 'persisted' : 'skipped: user/ai title already set'})`
		);
	return { title, persisted };
}

interface TaskMessage {
	role: 'system' | 'user';
	content: string;
}

/**
 * Build the chat-completions messages array for the title task. Exported
 * for testing; returns null when there's nothing usable (no user text and
 * no assistant text), since the title task can't help without input.
 */
export function buildTitlePrompt(exchange: {
	userText: string;
	userMediaKinds: ('image' | 'video')[];
	assistantText: string | null;
	assistantHasMedia: boolean;
}): TaskMessage[] | null {
	const userText = exchange.userText.trim();
	const assistantText = (exchange.assistantText ?? '').trim();

	if (!userText && !assistantText) return null;

	const userTruncated = truncateEllipsis(userText, PROMPT_TRUNCATE_CHARS);
	const assistantTruncated = truncateEllipsis(assistantText, PROMPT_TRUNCATE_CHARS);

	const useAssistant = assistantTruncated.length > 0;
	const inner = useAssistant
		? `User: ${userTruncated}\n\nAssistant: ${assistantTruncated}`
		: userTruncated;

	// Wrap in <conversation> tags so the model reads the body as data to
	// summarize, not as a live transcript to continue.
	const body = `<conversation>\n${inner}\n</conversation>\n\n${TRAILER_INSTRUCTION}`;

	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: body }
	];
}

/**
 * Strip the kinds of decorations LLMs habitually add to short
 * single-line outputs even when explicitly told not to: surrounding
 * quotes, trailing punctuation, leading "Title:" labels, plus
 * length-capping. Exported for testing.
 */
export function sanitizeTitle(raw: string): string {
	let s = raw.trim();
	// Strip leading "Title:" / "title -" prefixes a model might add.
	s = s.replace(/^\s*title\s*[:\-]\s*/i, '');
	// Strip surrounding ASCII or smart quotes (single pair only — repeated
	// pairs are likely intentional).
	const quotePairs: Array<[string, string]> = [
		['"', '"'],
		["'", "'"],
		['“', '”'],
		['‘', '’'],
		['«', '»']
	];
	for (const [open, close] of quotePairs) {
		if (s.startsWith(open) && s.endsWith(close) && s.length >= 2) {
			s = s.slice(open.length, s.length - close.length).trim();
			break;
		}
	}
	// Collapse internal newlines/whitespace runs to single spaces — titles
	// are always one-line.
	s = s.replace(/\s+/g, ' ');
	// Trailing sentence-style punctuation looks wrong on a title.
	s = s.replace(/[.!?;:,]+$/, '').trim();
	// Hard cap so a runaway model can't write a 10kb "title."
	return truncateEllipsis(s, MAX_TITLE_CHARS);
}

async function callTaskModel(
	endpoint: LoadedEndpoint,
	upstreamId: string,
	taskMessages: TaskMessage[]
): Promise<string> {
	const resp = await chatCompletionSync(endpoint, {
		model: upstreamId,
		messages: taskMessages,
		// Modest cap so a chatty task model can't run away on token cost;
		// 60 tokens is enough for any sane 3-7 word title with room.
		max_tokens: 60,
		// Lower temperature for deterministic title-like output.
		temperature: 0.3
	});
	return resp.choices?.[0]?.message?.content ?? '';
}
