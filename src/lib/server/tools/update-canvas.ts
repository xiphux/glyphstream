/**
 * `update_canvas` — apply a targeted edit to the conversation's open canvas.
 *
 * Registered `isAvailable: () => false` so it's never in the static tool
 * advertisement; `augmentRequestForCanvas` (called from the two send-path
 * handlers) appends its definition per-request only when the conversation has an
 * active canvas. That keeps `tools[]` prefix-stable: the tool appears once a
 * canvas exists and stays, rather than blinking on volatile state.
 *
 * Two commands: `str_replace` (one exact-match find/replace — token-cheap
 * targeted edits) and `rewrite` (full replacement — for large restructures).
 * The read-render-write is guarded by an optimistic compare-and-swap on the
 * current version id, so two edits racing in one parallel tool batch can't lose
 * an update (the loser gets an in-band retry error).
 */

import { register } from './registry';
import type { Tool } from './types';
import { renderMarkdown } from '../markdown/render';
import { appendCanvasVersion, listActiveCanvases } from '../db/queries/artifacts';
import { getActiveLeafMessageId } from '../db/queries/messages';

export const updateCanvasTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'update_canvas',
			description:
				'Edit an open canvas. With command "str_replace", replace the single exact occurrence of old_str with new_str (include enough surrounding text that old_str matches exactly once). With command "rewrite", replace the whole document with content. Prefer str_replace for targeted changes. Pass title to rename. When more than one canvas is open, pass artifact_id (shown on each canvas) to say which to edit.',
			parameters: {
				type: 'object',
				properties: {
					command: {
						type: 'string',
						enum: ['str_replace', 'rewrite'],
						description: 'The edit to perform.',
					},
					artifact_id: {
						type: 'string',
						description: 'Which canvas to edit. Required only when more than one is open.',
					},
					title: {
						type: 'string',
						description: 'Optional new title, to rename the document.',
					},
					old_str: {
						type: 'string',
						description: 'str_replace: the exact text to find (must occur exactly once).',
					},
					new_str: {
						type: 'string',
						description: 'str_replace: the replacement text.',
					},
					content: {
						type: 'string',
						description: 'rewrite: the full new document content, as markdown.',
					},
				},
				required: ['command'],
				additionalProperties: false,
			},
		},
	},
	// Never statically advertised — appended per-request when a canvas exists.
	isAvailable: () => false,
	metadata: { displayLabel: 'Canvas', icon: 'file-text', category: 'canvas' },
	async execute(args, ctx) {
		if (ctx.disabledFeatures.includes('canvas')) {
			return err('Canvas is disabled for this conversation.');
		}
		const canvases = listActiveCanvases(ctx.conversationId, ctx.userId);
		if (canvases.length === 0) {
			return err('There is no canvas to edit. Create one first with create_canvas.');
		}

		// Resolve which canvas to edit. With one open, edit it; with several, the
		// model must name it by artifact_id (listed in the current-state blocks).
		const requestedId = parseArtifactId(args);
		let doc;
		if (requestedId) {
			doc = canvases.find((c) => c.id === requestedId);
			if (!doc) {
				return err(
					`No open canvas has artifact_id "${requestedId}". Open canvases: ${describeCanvases(canvases)}.`,
				);
			}
		} else if (canvases.length === 1) {
			doc = canvases[0];
		} else {
			return err(
				`More than one canvas is open — pass artifact_id to say which to edit. Open canvases: ${describeCanvases(canvases)}.`,
			);
		}

		const edit = computeEdit(args, doc.content);
		if ('error' in edit) return err(edit.error);

		const newTitle = parseTitle(args);
		const contentHtml = await renderMarkdown(edit.content);
		const result = appendCanvasVersion({
			artifactId: doc.id,
			userId: ctx.userId,
			expectedCurrentVersionId: doc.currentVersionId,
			content: edit.content,
			contentHtml,
			createdByMessageId: getActiveLeafMessageId(ctx.conversationId, ctx.userId),
			editSource: 'agent',
			...(newTitle !== null ? { title: newTitle } : {}),
		});
		if (!result.ok) {
			return err(
				result.reason === 'conflict'
					? 'The canvas changed while you were editing. Re-read the current canvas state and try the edit again.'
					: 'The canvas could not be found.',
			);
		}

		const next = result.doc;
		return {
			content: JSON.stringify({
				ok: true,
				artifactId: next.id,
				applied: edit.command,
				version: next.versionNumber,
				title: next.title,
				message: 'Canvas updated and shown to the user.',
			}),
			canvas: {
				artifactId: next.id,
				versionId: next.currentVersionId!,
				title: next.title,
				content: next.content,
				contentHtml: next.contentHtml,
				versionNumber: next.versionNumber,
				editSource: 'agent',
			},
		};
	},
};

export type EditResult =
	{ command: 'str_replace' | 'rewrite'; content: string } | { error: string };

/** Pure edit computation — exported for unit tests. Validates args and applies
 *  the edit to `current`, returning the new content or an in-band error. */
export function computeEdit(args: unknown, current: string): EditResult {
	const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
	const command = a.command;
	if (command === 'rewrite') {
		if (typeof a.content !== 'string') return { error: 'rewrite requires a `content` string.' };
		return { command: 'rewrite', content: a.content };
	}
	if (command === 'str_replace') {
		const oldStr = a.old_str;
		const newStr = a.new_str;
		if (typeof oldStr !== 'string' || oldStr.length === 0) {
			return { error: 'str_replace requires a non-empty `old_str`.' };
		}
		if (typeof newStr !== 'string') {
			return { error: 'str_replace requires a `new_str` string.' };
		}
		const occurrences = current.split(oldStr).length - 1;
		if (occurrences === 0) {
			return {
				error:
					'old_str was not found in the canvas. Re-read the current content and copy the text to replace exactly.',
			};
		}
		if (occurrences > 1) {
			return {
				error: `old_str matched ${occurrences} times; it must match exactly once. Include more surrounding text to make it unique.`,
			};
		}
		return { command: 'str_replace', content: current.replace(oldStr, newStr) };
	}
	return { error: 'command must be "str_replace" or "rewrite".' };
}

/** The new title from a rename, or null when none was supplied. */
function parseTitle(args: unknown): string | null {
	if (!args || typeof args !== 'object') return null;
	const t = (args as Record<string, unknown>).title;
	return typeof t === 'string' && t.trim().length > 0 ? t.trim() : null;
}

/** The target artifact id, or null when the model didn't name one. */
function parseArtifactId(args: unknown): string | null {
	if (!args || typeof args !== 'object') return null;
	const id = (args as Record<string, unknown>).artifact_id;
	return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}

/** A compact "id (title)" listing for the disambiguation error messages. */
function describeCanvases(canvases: { id: string; title: string | null }[]): string {
	return canvases.map((c) => `${c.id} (${c.title ?? 'Canvas'})`).join(', ');
}

function err(message: string) {
	return { content: JSON.stringify({ error: message }), isError: true };
}

register(updateCanvasTool);
