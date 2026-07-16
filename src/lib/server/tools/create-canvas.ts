/**
 * `create_canvas` — open a side-by-side document the model revises across turns
 * (canvas mode). Statically registered under the `canvas` feature category, so
 * it's advertised in every text chat (image/video generation runs with no
 * tools[] at all) unless the user turned the category off.
 *
 * Phase 1 is one canvas per conversation: if an active canvas already exists,
 * this declines in-band and points the model at `update_canvas`. Errors are
 * returned as `{ isError: true }` (the clock.ts philosophy) so the model
 * self-corrects rather than aborting the turn.
 */

import { register } from './registry';
import type { Tool } from './types';
import { renderMarkdown } from '../markdown/render';
import { createCanvas, getActiveCanvas } from '../db/queries/artifacts';
import { getActiveLeafMessageId } from '../db/queries/messages';

export const createCanvasTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'create_canvas',
			description:
				'Open a canvas — a document shown beside the chat that you revise across turns. Use it for substantial work the user will iterate on (prose, a spec, a plan, a report, a config), not for short answers or snippets that belong inline. Creates the document with initial markdown content; afterward edit it with update_canvas.',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'Short title for the document.' },
					content: {
						type: 'string',
						description: 'Initial document content, as markdown.',
					},
				},
				required: ['content'],
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

		// Phase 1: one canvas per conversation. Steer edits to update_canvas.
		const existing = getActiveCanvas(ctx.conversationId, ctx.userId);
		if (existing) {
			return {
				content: JSON.stringify({
					error:
						'A canvas already exists in this conversation. Use update_canvas to change it (command "rewrite" to replace it wholesale).',
				}),
				isError: true,
			};
		}

		const contentHtml = await renderMarkdown(content);
		const doc = createCanvas({
			userId: ctx.userId,
			conversationId: ctx.conversationId,
			title: title,
			content,
			contentHtml,
			createdByMessageId: getActiveLeafMessageId(ctx.conversationId),
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
	const title = typeof a.title === 'string' && a.title.length > 0 ? a.title : null;
	const content = typeof a.content === 'string' ? a.content : null;
	return { title, content };
}

register(createCanvasTool);
