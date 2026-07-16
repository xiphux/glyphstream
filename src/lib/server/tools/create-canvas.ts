/**
 * `create_canvas` — open a side-by-side document the model revises across turns
 * (canvas mode). Statically registered under the `canvas` feature category, so
 * it's advertised in every text chat (image/video generation runs with no
 * tools[] at all) unless the user turned the category off.
 *
 * A conversation may hold several canvases (e.g. a spec + its notes); each call
 * creates a new one. Errors are returned as `{ isError: true }` (the clock.ts
 * philosophy) so the model self-corrects rather than aborting the turn.
 */

import { register } from './registry';
import type { Tool } from './types';
import { renderMarkdown } from '../markdown/render';
import { createCanvas } from '../db/queries/artifacts';
import { getActiveLeafMessageId } from '../db/queries/messages';

export const createCanvasTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'create_canvas',
			description:
				'Open a canvas — a document shown beside the chat that you revise across turns. Use it for substantial work the user will iterate on (prose, a spec, a plan, a report), not for short answers or snippets that belong inline. Always give it a short, descriptive title so the user can tell it apart from other canvases. Provide the initial markdown content; edit it afterward with update_canvas.',
			parameters: {
				type: 'object',
				properties: {
					title: {
						type: 'string',
						description: 'A short, descriptive title naming the document (a few words).',
					},
					content: {
						type: 'string',
						description: 'Initial document content, as markdown.',
					},
				},
				required: ['title', 'content'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Canvas', icon: 'file-text', category: 'canvas' },
	async execute(args, ctx) {
		if (ctx.disabledFeatures.includes('canvas')) {
			return {
				content: JSON.stringify({ error: 'Canvas is disabled for this conversation.' }),
				isError: true,
			};
		}
		const { title, content } = parseArgs(args);
		if (content === null) {
			return {
				content: JSON.stringify({ error: 'create_canvas requires a `content` string.' }),
				isError: true,
			};
		}

		const contentHtml = await renderMarkdown(content);
		const doc = createCanvas({
			userId: ctx.userId,
			conversationId: ctx.conversationId,
			// `title` is required in the schema, but not every model honors that —
			// fall back to a title derived from the content so a canvas is never
			// nameless (the whole point of naming it: telling canvases apart).
			title: title ?? deriveCanvasTitle(content),
			content,
			contentHtml,
			createdByMessageId: getActiveLeafMessageId(ctx.conversationId, ctx.userId),
		});

		return {
			content: JSON.stringify({
				ok: true,
				artifactId: doc.id,
				version: doc.versionNumber,
				title: doc.title,
				message:
					'Canvas created and shown to the user. Make further changes with update_canvas — do not repaste the document into chat.',
			}),
			canvas: {
				artifactId: doc.id,
				versionId: doc.currentVersionId!,
				title: doc.title,
				content: doc.content,
				contentHtml: doc.contentHtml,
				versionNumber: doc.versionNumber,
				editSource: 'agent',
			},
		};
	},
};

function parseArgs(args: unknown): { title: string | null; content: string | null } {
	if (!args || typeof args !== 'object') return { title: null, content: null };
	const a = args as Record<string, unknown>;
	const title = typeof a.title === 'string' && a.title.trim().length > 0 ? a.title.trim() : null;
	const content = typeof a.content === 'string' ? a.content : null;
	return { title, content };
}

/**
 * Best-effort title from the document itself, for when the model omits one:
 * the first markdown heading, else the first non-empty line — stripped of
 * heading/emphasis markers and truncated. Exported for unit tests.
 */
export function deriveCanvasTitle(content: string): string {
	for (const rawLine of content.split('\n')) {
		const text = rawLine
			.replace(/^\s*#{1,6}\s+/, '') // heading markers
			.replace(/[*_`#>]/g, '') // inline emphasis / stray markers
			.trim();
		if (text) return text.length > 60 ? text.slice(0, 57).trimEnd() + '…' : text;
	}
	return 'Untitled canvas';
}

register(createCanvasTool);
