/**
 * Memory tools — the model's write path for the persistent per-user
 * memory store. The read path is implicit: every memory's content is
 * inlined into the system prompt via composeMemorySection so the model
 * always has the full index without calling a recall tool. (Phase 2
 * will add a recall_memory tool that activates when an embedding
 * endpoint is configured and the memory budget grows too large to
 * inline; the seam is the TODO marker in composePersonaSystemPrompt.)
 *
 * All three tools carry `category: 'personalization'`. The existing
 * per-conversation toggle that gates the persona prompt also seals
 * these — one switch closes every avenue that ships personal context
 * to the model. The filter happens at openaiToolDefinitions() time
 * (registry.ts), so when the toggle is off the model never sees these
 * tools advertised, can't "discover" them, and can't write.
 *
 * Wrong-id errors (foreign user's id, fabricated id, already-deleted
 * id) return `isError: true` rather than throwing — same recoverable
 * pattern as web_search's transport errors, so the model gets a tool
 * message it can apologize over instead of an aborted turn.
 */
import { createMemory, deleteMemory, updateMemory } from '../db/queries/memories';
import { register } from './registry';
import type { Tool, ToolExecution } from './types';

const MAX_CONTENT_CHARS = 500;

export const saveMemoryTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'save_memory',
			description:
				'Save a standing fact about the user that should persist across conversations. Use sparingly. Good: stable preferences ("prefers metric units"), persistent identity ("works as a backend engineer at Acme"), durable interests, opinions the user has stated as their own. Bad: anything tied to a single conversation, anything re-derivable from earlier in this thread, temporary state ("is currently debugging X"), or things the user has not actually told you. Keep each memory one self-contained sentence — it is read in isolation, with no surrounding context. Prefer updating an existing memory over saving a near-duplicate.',
			parameters: {
				type: 'object',
				properties: {
					content: {
						type: 'string',
						description: `The memory text. One self-contained sentence, at most ${MAX_CONTENT_CHARS} characters.`,
					},
				},
				required: ['content'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Save memory', icon: 'brain', category: 'personalization' },
	execute(args, ctx): ToolExecution {
		const parsed = parseContentArg(args);
		if ('error' in parsed) return errorResult(parsed.error);
		const { id } = createMemory(ctx.userId, parsed.content);
		return { content: JSON.stringify({ id, saved: true }) };
	},
};

export const updateMemoryTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'update_memory',
			description:
				'Replace the content of an existing memory in place when a stored fact needs to be corrected or refined. Prefer this over forget+save for edits — the memory keeps its id and the index ordering stays stable.',
			parameters: {
				type: 'object',
				properties: {
					id: {
						type: 'string',
						description:
							'The id of the memory to update — the bracketed value shown next to the entry in "Saved memories".',
					},
					content: {
						type: 'string',
						description: `The new memory text. One self-contained sentence, at most ${MAX_CONTENT_CHARS} characters.`,
					},
				},
				required: ['id', 'content'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Update memory', icon: 'brain', category: 'personalization' },
	execute(args, ctx): ToolExecution {
		const parsed = parseIdAndContentArgs(args);
		if ('error' in parsed) return errorResult(parsed.error);
		const matched = updateMemory(ctx.userId, parsed.id, parsed.content);
		if (!matched) return errorResult(`No memory with id "${parsed.id}".`);
		return { content: JSON.stringify({ id: parsed.id, updated: true }) };
	},
};

export const forgetMemoryTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'forget_memory',
			description:
				'Delete a saved memory by id. Use when the user explicitly retracts a fact, or when a memory has become wrong. The id is the bracketed value shown next to each entry in "Saved memories".',
			parameters: {
				type: 'object',
				properties: {
					id: {
						type: 'string',
						description:
							'The id of the memory to forget — the bracketed value shown next to the entry in "Saved memories".',
					},
				},
				required: ['id'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Forget memory', icon: 'brain', category: 'personalization' },
	execute(args, ctx): ToolExecution {
		const parsed = parseIdArg(args);
		if ('error' in parsed) return errorResult(parsed.error);
		const matched = deleteMemory(ctx.userId, parsed.id);
		if (!matched) return errorResult(`No memory with id "${parsed.id}".`);
		return { content: JSON.stringify({ id: parsed.id, forgotten: true }) };
	},
};

function parseContentArg(args: unknown): { content: string } | { error: string } {
	if (!args || typeof args !== 'object') {
		return { error: 'Expected an object argument with a `content` field.' };
	}
	const a = args as { content?: unknown };
	if (typeof a.content !== 'string') {
		return { error: 'Missing or non-string `content` argument.' };
	}
	const trimmed = a.content.trim();
	if (trimmed.length === 0) return { error: '`content` must be non-empty.' };
	if (trimmed.length > MAX_CONTENT_CHARS) {
		return {
			error: `\`content\` exceeds ${MAX_CONTENT_CHARS} characters — keep memories to one sentence.`,
		};
	}
	return { content: trimmed };
}

function parseIdArg(args: unknown): { id: string } | { error: string } {
	if (!args || typeof args !== 'object') {
		return { error: 'Expected an object argument with an `id` field.' };
	}
	const a = args as { id?: unknown };
	if (typeof a.id !== 'string' || a.id.length === 0) {
		return { error: 'Missing or empty `id` argument.' };
	}
	return { id: a.id };
}

function parseIdAndContentArgs(args: unknown): { id: string; content: string } | { error: string } {
	const idResult = parseIdArg(args);
	if ('error' in idResult) return idResult;
	const contentResult = parseContentArg(args);
	if ('error' in contentResult) return contentResult;
	return { id: idResult.id, content: contentResult.content };
}

function errorResult(message: string): ToolExecution {
	return { content: JSON.stringify({ error: message }), isError: true };
}

register(saveMemoryTool);
register(updateMemoryTool);
register(forgetMemoryTool);
