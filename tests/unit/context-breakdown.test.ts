import { describe, expect, it } from 'vitest';
import {
	buildContextBreakdown,
	dataUrlChars,
	type ContextBreakdownInput,
	type MediaSize,
} from '$lib/server/chat/context-breakdown';
import type { ChatMessage, ContextSegmentKey, MessagePart } from '$lib/types/api';
import type { OpenAIToolDefinition } from '$lib/server/tools/types';

function msg(
	role: ChatMessage['role'],
	parts: MessagePart[],
	extra: Partial<ChatMessage> = {},
): ChatMessage {
	return {
		id: 'm1',
		role,
		parts,
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: null,
		genMs: null,
		createdAt: 0,
		...extra,
	};
}

function toolDef(name: string, description: string): OpenAIToolDefinition {
	return {
		type: 'function',
		function: { name, description, parameters: { type: 'object', properties: {} } },
	};
}

const PNG: MediaSize = { byteSize: 3_000, contentType: 'image/png' };

function input(over: Partial<ContextBreakdownInput> = {}): ContextBreakdownInput {
	return {
		branch: [],
		personaParts: [],
		customSystemPrompt: null,
		// Empty by default so the segment assertions below aren't perturbed by it;
		// the preamble has its own suite (environment-context.test.ts).
		environmentBlock: '',
		skillsCatalog: null,
		toolSearchHint: null,
		toolDefs: [],
		mediaSize: async () => PNG,
		contextWindow: null,
		...over,
	};
}

/** Chars attributed to a segment, or 0 when the segment is absent. */
function chars(
	segments: { key: ContextSegmentKey; chars: number }[],
	key: ContextSegmentKey,
): number {
	return segments.find((s) => s.key === key)?.chars ?? 0;
}

describe('buildContextBreakdown', () => {
	it('separates overhead from history', async () => {
		const b = await buildContextBreakdown(
			input({
				personaParts: [
					{ key: 'persona:name', text: 'name!!' },
					{ key: 'persona:memories', text: 'memories!!!' },
				],
				skillsCatalog: 'catalog',
				toolSearchHint: 'hint',
				branch: [msg('user', [{ type: 'text', text: 'hello' }])],
			}),
		);

		expect(chars(b.segments, 'persona:name')).toBe(6);
		expect(chars(b.segments, 'persona:memories')).toBe(11);
		expect(chars(b.segments, 'skills:catalog')).toBe(7);
		expect(chars(b.segments, 'tools:hint')).toBe(4);
		expect(chars(b.segments, 'history:text')).toBe(5);
	});

	it('prices each tool definition and itemizes them largest-first', async () => {
		const small = toolDef('a', 'x');
		const big = toolDef('b', 'x'.repeat(500));
		const b = await buildContextBreakdown(input({ toolDefs: [small, big] }));

		const defs = b.segments.find((s) => s.key === 'tools:defs')!;
		expect(defs.chars).toBe(JSON.stringify(small).length + JSON.stringify(big).length);
		expect(defs.items?.map((i) => i.label)).toEqual(['b', 'a']);
	});

	it('bills tool results separately from assistant text', async () => {
		const b = await buildContextBreakdown(
			input({
				branch: [
					msg('assistant', [
						{ type: 'text', text: 'ok' },
						{
							type: 'tool_call',
							toolCallId: 'c1',
							toolName: 'fetch_url',
							arguments: '{"url":"x"}',
						},
					]),
					msg('tool', [{ type: 'tool_result', toolCallId: 'c1', result: 'r'.repeat(4000) }]),
				],
			}),
		);

		expect(chars(b.segments, 'history:tool_results')).toBe(4000);
		expect(chars(b.segments, 'history:text')).toBe(2);
		// name + serialized arguments
		expect(chars(b.segments, 'history:tool_calls')).toBe('fetch_url'.length + '{"url":"x"}'.length);
	});

	it('prices images from byte size, not as text tokens', async () => {
		const b = await buildContextBreakdown(
			input({
				branch: [
					msg('user', [
						{ type: 'text', text: 'look' },
						{ type: 'image', mediaId: 'img1' },
					]),
				],
			}),
		);

		const images = b.segments.find((s) => s.key === 'history:images')!;
		expect(images.chars).toBe(dataUrlChars(3000, 'image/png'));
		expect(b.imageBytes).toBe(3000);
		// base64 is not text: chars/4 on it would be a lie, so it contributes no
		// estimated tokens and shows up in the reported-vs-estimated gap instead.
		expect(images.tokens).toBe(0);
		expect(b.estimatedTokens).toBe(1); // just the 4-char "look"
	});

	it('ignores media the serializer would degrade to an [Image deleted] note', async () => {
		const b = await buildContextBreakdown(
			input({
				mediaSize: async () => null,
				branch: [msg('user', [{ type: 'image', mediaId: 'gone' }])],
			}),
		);

		expect(chars(b.segments, 'history:images')).toBe(0);
		expect(b.imageBytes).toBe(0);
	});

	it('prices the model-visible branch, so a compacted thread excludes folded history', async () => {
		const old = msg('user', [{ type: 'text', text: 'x'.repeat(1000) }], {
			id: 'old',
			createdAt: 1,
		});
		const kept = msg('user', [{ type: 'text', text: 'kept' }], { id: 'kept', createdAt: 3 });
		const summary = msg('assistant', [{ type: 'text', text: 'summary text' }], {
			id: 'sum',
			createdAt: 2,
			compactionResumeFromMessageId: 'kept',
		});

		const b = await buildContextBreakdown(input({ branch: [old, summary, kept] }));

		// The folded message is gone from the payload entirely...
		expect(chars(b.segments, 'history:text')).toBe(4);
		// ...and the summary standing in for it is billed on its own line.
		expect(chars(b.segments, 'history:summary')).toBe('summary text'.length);
	});

	it('does not double-bill a skill body that was superseded by a later activation', async () => {
		const body = 'B'.repeat(10_000);
		const activation = (id: string) =>
			msg(
				'tool',
				[
					{
						type: 'tool_result',
						toolCallId: id,
						result: `<skill_content name="research">\n${body}\n</skill_content>`,
					},
				],
				{ id },
			);

		const b = await buildContextBreakdown(input({ branch: [activation('a1'), activation('a2')] }));

		// Only the most recent copy rides in full; the earlier one collapses to a
		// short placeholder. Two full copies would be >20k chars.
		expect(chars(b.segments, 'history:tool_results')).toBeLessThan(11_000);
		expect(chars(b.segments, 'history:tool_results')).toBeGreaterThan(10_000);
	});

	it('reports the last real assistant turn prompt_tokens, ignoring summaries', async () => {
		const b = await buildContextBreakdown(
			input({
				branch: [
					msg('assistant', [{ type: 'text', text: 'a' }], { id: 'a', tokensIn: 900 }),
					msg('assistant', [{ type: 'text', text: 's' }], {
						id: 's',
						tokensIn: 50,
						compactionResumeFromMessageId: 'a',
					}),
				],
			}),
		);

		expect(b.reportedPromptTokens).toBe(900);
	});

	it('reports null prompt_tokens on a thread that has not completed a turn', async () => {
		const b = await buildContextBreakdown(
			input({ branch: [msg('user', [{ type: 'text', text: 'hi' }])] }),
		);
		expect(b.reportedPromptTokens).toBeNull();
	});
});
