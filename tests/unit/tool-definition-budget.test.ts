/**
 * A size budget for the built-in tool definitions.
 *
 * `tools[]` is re-sent on EVERY request, in every conversation, whether or not
 * the model ever calls any of them. A description is therefore not free prose —
 * it's rent, charged per turn, forever. Left ungoverned it creeps: each
 * individual "let me clarify this edge case for the model" sentence is
 * defensible, and collectively they had grown the built-ins to ~7.8k characters
 * before this budget existed.
 *
 * These ceilings are deliberately close to the current sizes. A failure here is
 * not a bug — it's this test asking you to justify the growth, or to cut
 * something else to pay for it. Raise a ceiling when the words genuinely earn
 * their keep; don't raise it reflexively.
 *
 * What earns its keep: things the model cannot discover on its own (which
 * packages are preinstalled, that state persists across calls, that network may
 * be absent). What doesn't: restating a failure mode the error message already
 * announces, or re-explaining a mechanism the system prompt just explained.
 */

import { describe, expect, it } from 'vitest';
import {
	forgetMemoryTool,
	recallMemoryTool,
	saveMemoryTool,
	updateMemoryTool,
} from '$lib/server/tools/memory';
import { fetchUrlTool } from '$lib/server/tools/fetch-url';
import { runPythonTool } from '$lib/server/tools/run-python';
import { webSearchTool } from '$lib/server/tools/web-search';
import { searchConversationsTool } from '$lib/server/tools/conversation-search';
import { createCanvasTool } from '$lib/server/tools/create-canvas';
import { updateCanvasTool } from '$lib/server/tools/update-canvas';
import type { Tool } from '$lib/server/tools/types';

/** Serialized size of a definition exactly as it goes on the wire. */
function wireChars(tool: Tool): number {
	return JSON.stringify(tool.definition).length;
}

const BUDGETS: ReadonlyArray<readonly [string, Tool, number]> = [
	['run_python', runPythonTool, 1500],
	['save_memory', saveMemoryTool, 1350],
	['search_conversations', searchConversationsTool, 1450],
	['web_search', webSearchTool, 1450],
	['fetch_url', fetchUrlTool, 1150],
	['update_memory', updateMemoryTool, 950],
	['recall_memory', recallMemoryTool, 750],
	['forget_memory', forgetMemoryTool, 450],
	// Always advertised in every text chat (unless the canvas category is off).
	['create_canvas', createCanvasTool, 700],
];

describe('tool definition budget', () => {
	it.each(BUDGETS)('%s stays within its wire budget', (_name, tool, budget) => {
		expect(wireChars(tool)).toBeLessThanOrEqual(budget);
	});

	it('keeps the always-on built-ins under a combined ceiling', () => {
		// The number that actually matters: what a fully-featured turn pays before a
		// single MCP tool or skill is counted.
		const total = BUDGETS.reduce((sum, [, tool]) => sum + wireChars(tool), 0);
		expect(total).toBeLessThanOrEqual(9700);
	});

	it('keeps update_canvas within its wire budget', () => {
		// Not in the always-on total above: update_canvas is registered
		// isAvailable:false and appended per-request only once a conversation has a
		// canvas. But it's still re-sent every turn for the rest of that
		// conversation, so it earns a ceiling of its own.
		expect(wireChars(updateCanvasTool)).toBeLessThanOrEqual(900);
	});

	it('does not repeat the same parameter prose across the memory tools', () => {
		// The "self-contained note…" copy and the "bracketed value…" copy were each
		// pasted into multiple tools, so every turn paid for them two or three times.
		// They're shared constants now; this keeps them that way.
		const save = JSON.stringify(saveMemoryTool.definition);
		const update = JSON.stringify(updateMemoryTool.definition);
		const forget = JSON.stringify(forgetMemoryTool.definition);

		const contentProse = 'Self-contained note';
		expect(save).toContain(contentProse);
		expect(update).toContain(contentProse);

		const idProse = 'bracketed value';
		expect(update).toContain(idProse);
		expect(forget).toContain(idProse);

		// Each phrase appears at most once within a single definition — a tool whose
		// description AND parameter both explain the same thing is paying twice.
		for (const def of [save, update, forget]) {
			expect(def.split(contentProse).length - 1).toBeLessThanOrEqual(1);
			expect(def.split(idProse).length - 1).toBeLessThanOrEqual(1);
		}
	});
});
