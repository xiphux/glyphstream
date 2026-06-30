import { describe, expect, it } from 'vitest';
import type { ChatMessage, MessageRole } from '$lib/types/api';
import {
	arrangeForDisplay,
	canCompact,
	compactionWorthwhile,
	computeCompactionCut,
	currentContextTokens,
	displayContextTokens,
	estimateContentTokens,
	isCompactionSummary,
	MIN_COMPACTIBLE_TOKENS,
	shouldAutoCompact,
	splitAtCompaction,
	SUMMARY_MAX_TOKENS_CAP,
	SUMMARY_MIN_TOKENS,
	summaryMaxTokens,
	upstreamBranch,
} from '$lib/chat-compaction';

let seq = 0;
function msg(
	role: MessageRole,
	overrides: Partial<ChatMessage> & { id?: string } = {},
): ChatMessage {
	seq += 1;
	return {
		id: overrides.id ?? `m${seq}`,
		role,
		parts: [{ type: 'text', text: overrides.id ?? `m${seq}` }],
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: null,
		genMs: null,
		createdAt: seq,
		compactionResumeFromMessageId: null,
		...overrides,
	};
}

/** A summary message resuming from `resumeId`, created after the branch. */
function summary(id: string, resumeId: string, createdAt: number): ChatMessage {
	return msg('assistant', { id, compactionResumeFromMessageId: resumeId, createdAt });
}

/** Build u0/a0/u1/a1/... — `n` user+assistant turns (tiny text). */
function turns(n: number): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (let i = 0; i < n; i++) {
		out.push(msg('user', { id: `u${i}`, createdAt: i * 2 + 1 }));
		out.push(msg('assistant', { id: `a${i}`, createdAt: i * 2 + 2 }));
	}
	return out;
}

/** `n` turns whose user messages carry substantial text (~600 tokens each), so
 *  the foldable history clears `MIN_COMPACTIBLE_TOKENS`. */
const BIG_TEXT = 'x'.repeat(2400);
function bigTurns(n: number): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (let i = 0; i < n; i++) {
		out.push(
			msg('user', { id: `u${i}`, createdAt: i * 2 + 1, parts: [{ type: 'text', text: BIG_TEXT }] }),
		);
		out.push(msg('assistant', { id: `a${i}`, createdAt: i * 2 + 2 }));
	}
	return out;
}

describe('computeCompactionCut', () => {
	it('returns null when there are not more than keepTurns turns', () => {
		expect(computeCompactionCut(turns(2), 2)).toBeNull();
		expect(computeCompactionCut(turns(1), 2)).toBeNull();
	});

	it('keeps the last keepTurns turns verbatim, cutting at the right user message', () => {
		// 4 turns, keep 2 → resume at u2 (the 3rd user message).
		const branch = turns(4);
		const cut = computeCompactionCut(branch, 2);
		expect(cut).not.toBeNull();
		expect(cut!.resumeMessageId).toBe('u2');
		expect(cut!.cutIndex).toBe(branch.findIndex((m) => m.id === 'u2'));
	});

	it('honors keepTurns = 1', () => {
		const cut = computeCompactionCut(turns(3), 1);
		expect(cut!.resumeMessageId).toBe('u2');
	});

	it('returns null when the summarized slice would hold only a prior summary', () => {
		// [S, u0, a0, u1, a1] — keep 2 turns → resume at u0, summarized = [S] only.
		const branch = [summary('S', 'u0', 100), ...turns(2)];
		expect(computeCompactionCut(branch, 2)).toBeNull();
	});

	it('compacts again once new turns accumulate past a prior summary', () => {
		// [S, u0,a0, u1,a1, u2,a2] keep 2 → resume u1, summarized = [S, u0, a0] (real material).
		const branch = [summary('S', 'u0', 100), ...turns(3)];
		const cut = computeCompactionCut(branch, 2);
		expect(cut!.resumeMessageId).toBe('u1');
	});
});

describe('splitAtCompaction', () => {
	it('passes through a branch with no summary', () => {
		const branch = turns(3);
		const split = splitAtCompaction(branch);
		expect(split.summary).toBeNull();
		expect(split.summarized).toEqual([]);
		expect(split.live).toBe(branch);
	});

	it('partitions around the summary appended at the leaf', () => {
		// branch order: u0 a0 u1 a1 u2 a2 S(resume=u1)
		const base = turns(3);
		const s = summary('S', 'u1', 100);
		const branch = [...base, s];
		const split = splitAtCompaction(branch);
		expect(split.summary).toBe(s);
		expect(split.summarized.map((m) => m.id)).toEqual(['u0', 'a0']);
		expect(split.live.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
	});

	it('includes post-summary turns in live, after the verbatim tail', () => {
		const base = turns(3);
		const s = summary('S', 'u1', 100);
		const post = [
			msg('user', { id: 'u3', createdAt: 200 }),
			msg('assistant', { id: 'a3', createdAt: 201 }),
		];
		const branch = [...base, s, ...post];
		const split = splitAtCompaction(branch);
		expect(split.live.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
	});

	it('uses the latest of multiple summaries', () => {
		const branch = [
			...turns(2), // u0 a0 u1 a1
			summary('S1', 'u0', 50),
			msg('user', { id: 'u2', createdAt: 60 }),
			msg('assistant', { id: 'a2', createdAt: 61 }),
			summary('S2', 'u1', 100),
		];
		const split = splitAtCompaction(branch);
		expect(split.summary!.id).toBe('S2');
		// Everything before u1 (incl. S1) is summarized-away upstream.
		expect(split.summarized.map((m) => m.id)).toEqual(['u0', 'a0']);
		expect(split.live.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
	});

	it('degrades a dangling resume pointer to no verbatim tail', () => {
		const branch = [...turns(2), summary('S', 'gone', 100)];
		const split = splitAtCompaction(branch);
		expect(split.summarized.map((m) => m.id)).toEqual(['u0', 'a0', 'u1', 'a1']);
		expect(split.live).toEqual([]);
	});
});

describe('upstreamBranch', () => {
	it('leads with the summary then the live tail', () => {
		const branch = [...turns(3), summary('S', 'u1', 100)];
		expect(upstreamBranch(branch).map((m) => m.id)).toEqual(['S', 'u1', 'a1', 'u2', 'a2']);
	});

	it('is the untouched branch without a summary', () => {
		const branch = turns(2);
		expect(upstreamBranch(branch)).toBe(branch);
	});
});

describe('arrangeForDisplay', () => {
	it('is identity without a summary', () => {
		const branch = turns(2);
		expect(arrangeForDisplay(branch)).toBe(branch);
	});

	it('moves a leaf-appended summary to just before its resume target', () => {
		const branch = [...turns(3), summary('S', 'u1', 100)];
		expect(arrangeForDisplay(branch).map((m) => m.id)).toEqual([
			'u0',
			'a0',
			'S',
			'u1',
			'a1',
			'u2',
			'a2',
		]);
	});

	it('places each of multiple summaries before its own target', () => {
		const branch = [
			...turns(2),
			summary('S1', 'u0', 50),
			msg('user', { id: 'u2', createdAt: 60 }),
			msg('assistant', { id: 'a2', createdAt: 61 }),
			summary('S2', 'u1', 100),
		];
		expect(arrangeForDisplay(branch).map((m) => m.id)).toEqual([
			'S1',
			'u0',
			'a0',
			'S2',
			'u1',
			'a1',
			'u2',
			'a2',
		]);
	});

	it('appends a summary whose target is missing', () => {
		const branch = [...turns(2), summary('S', 'gone', 100)];
		const ids = arrangeForDisplay(branch).map((m) => m.id);
		expect(ids).toEqual(['u0', 'a0', 'u1', 'a1', 'S']);
	});
});

describe('canCompact', () => {
	it('is true for a structurally long-enough branch (regardless of size)', () => {
		expect(canCompact(turns(4), 2)).toBe(true);
	});
	it('is false when too short', () => {
		expect(canCompact(turns(2), 2)).toBe(false);
	});
});

describe('estimateContentTokens', () => {
	it('estimates ~chars/4 across text parts', () => {
		expect(
			estimateContentTokens([msg('user', { parts: [{ type: 'text', text: 'x'.repeat(400) }] })]),
		).toBe(100);
	});

	it('counts tool-call arguments and tool-result output, not just text', () => {
		// Tool-heavy turns (code/PDF ops) carry their bulk here — a text-only
		// estimate would wrongly report them as tiny.
		const branch = [
			msg('assistant', {
				parts: [
					{ type: 'text', text: '' },
					{ type: 'tool_call', toolCallId: 'c1', toolName: 'run', arguments: 'a'.repeat(200) },
				],
			}),
			msg('tool', {
				parts: [{ type: 'tool_result', toolCallId: 'c1', result: 'r'.repeat(8000) }],
			}),
		];
		// (200 + 3 ['run']) + 8000 = 8203 chars → ~2051 tokens.
		expect(estimateContentTokens(branch)).toBe(Math.ceil((200 + 3 + 8000) / 4));
	});
});

describe('compactionWorthwhile', () => {
	it('is false when structurally too short', () => {
		expect(compactionWorthwhile(turns(2), 2)).toBe(false);
	});

	it('is false when there are enough turns but the foldable history is tiny', () => {
		// 4 one-word turns — canCompact is true, but folding them saves nothing.
		expect(canCompact(turns(4), 2)).toBe(true);
		expect(compactionWorthwhile(turns(4), 2)).toBe(false);
	});

	it('is true once the foldable history clears the floor', () => {
		// 4 big turns, keep 2 → folds 2 (~1200 tokens) > MIN_COMPACTIBLE_TOKENS.
		expect(compactionWorthwhile(bigTurns(4), 2)).toBe(true);
	});

	it('respects an explicit minTokens override', () => {
		expect(compactionWorthwhile(turns(4), 2, 1)).toBe(true); // tiny floor → worthwhile
	});

	it('uses a 1000-token default floor', () => {
		expect(MIN_COMPACTIBLE_TOKENS).toBe(1000);
	});
});

describe('summaryMaxTokens', () => {
	it('falls back to the floor when the window is unknown', () => {
		expect(summaryMaxTokens(5000, null)).toBe(SUMMARY_MIN_TOKENS);
		expect(summaryMaxTokens(5000, 0)).toBe(SUMMARY_MIN_TOKENS);
	});

	it('grows toward the cap on a large window with lots of free room', () => {
		// 40960 ctx, ~32k prompt → ~8.7k headroom, capped at the ceiling.
		expect(summaryMaxTokens(32000, 40960)).toBe(SUMMARY_MAX_TOKENS_CAP);
	});

	it('never exceeds what fits on a tighter window', () => {
		// 8192 ctx, ~6500 prompt → 8192-6500-256 = 1436 of room, below the floor.
		expect(summaryMaxTokens(6500, 8192)).toBe(1436);
	});

	it('scales between floor and cap with mid-range headroom', () => {
		// 16384 ctx, ~13k prompt → 16384-13000-256 = 3128, between floor and cap.
		expect(summaryMaxTokens(13000, 16384)).toBe(3128);
	});

	it('takes the hard floor when even the room is gone (degenerate near-full)', () => {
		// 2048 ctx, ~1900 prompt → negative-ish headroom → clamps up to 512.
		expect(summaryMaxTokens(1900, 2048)).toBe(512);
	});

	it('caps a large window with a huge prompt at what remains, not the ceiling', () => {
		// 40960 ctx, ~39k prompt → only ~1704 left, under the floor.
		expect(summaryMaxTokens(39000, 40960)).toBe(40960 - 39000 - 256);
	});
});

describe('isCompactionSummary', () => {
	it('detects the resume marker', () => {
		expect(isCompactionSummary(summary('S', 'u0', 1))).toBe(true);
		expect(isCompactionSummary(msg('assistant'))).toBe(false);
	});
});

describe('displayContextTokens', () => {
	it('reads the most recent assistant usage', () => {
		const branch = [
			msg('user', { id: 'u0', createdAt: 1 }),
			msg('assistant', { id: 'a0', createdAt: 2, tokensIn: 1000, tokensOut: 200 }),
		];
		expect(displayContextTokens(branch)).toBe(1200);
	});

	it('reads 0 right after a compaction (pre-summary usage is stale)', () => {
		const branch = [
			msg('user', { id: 'u0', createdAt: 1 }),
			msg('assistant', { id: 'a0', createdAt: 2, tokensIn: 6000, tokensOut: 400 }),
			summary('S', 'u0', 3),
		];
		expect(displayContextTokens(branch)).toBe(0);
	});

	it('reads the post-compaction turn once it has usage', () => {
		const branch = [
			msg('user', { id: 'u0', createdAt: 1 }),
			msg('assistant', { id: 'a0', createdAt: 2, tokensIn: 6000, tokensOut: 400 }),
			summary('S', 'u0', 3),
			msg('user', { id: 'u1', createdAt: 4 }),
			msg('assistant', { id: 'a1', createdAt: 5, tokensIn: 800, tokensOut: 150 }),
		];
		expect(displayContextTokens(branch)).toBe(950);
	});
});

describe('currentContextTokens', () => {
	it('reads the latest real assistant usage, ignoring summaries', () => {
		const branch = [
			msg('user', { id: 'u0', createdAt: 1 }),
			msg('assistant', { id: 'a0', createdAt: 2, tokensIn: 6000, tokensOut: 400 }),
			summary('S', 'u0', 3),
		];
		expect(currentContextTokens(branch)).toBe(6400);
	});
});

describe('shouldAutoCompact', () => {
	// Substantial turns (so the worthwhile floor is met) with the latest assistant
	// carrying near-window usage.
	const longBranch = () => {
		const b = bigTurns(4);
		b[b.length - 1] = msg('assistant', { id: 'a3', createdAt: 99, tokensIn: 7000, tokensOut: 200 });
		return b;
	};

	it('fires when enabled, over threshold, and compactable', () => {
		expect(
			shouldAutoCompact({
				branch: longBranch(),
				enabled: true,
				contextWindow: 8192,
				threshold: 80,
			}),
		).toBe(true);
	});

	it('does not fire when disabled', () => {
		expect(
			shouldAutoCompact({
				branch: longBranch(),
				enabled: false,
				contextWindow: 8192,
				threshold: 80,
			}),
		).toBe(false);
	});

	it('does not fire when under threshold', () => {
		const b = bigTurns(4);
		b[b.length - 1] = msg('assistant', { id: 'a3', createdAt: 99, tokensIn: 1000, tokensOut: 50 });
		expect(
			shouldAutoCompact({ branch: b, enabled: true, contextWindow: 8192, threshold: 80 }),
		).toBe(false);
	});

	it('does not fire when over threshold but the foldable history is tiny (not worthwhile)', () => {
		// The system-prompt/tool/memory-heavy case: total is over threshold, there
		// are enough turns to be structurally compactable, but the history itself
		// is trivially small — compacting would churn for ~nothing.
		const b = turns(4); // tiny one-word turns
		b[b.length - 1] = msg('assistant', { id: 'a3', createdAt: 99, tokensIn: 7000, tokensOut: 200 });
		expect(canCompact(b, 2)).toBe(true); // structurally yes
		expect(
			shouldAutoCompact({ branch: b, enabled: true, contextWindow: 8192, threshold: 80 }),
		).toBe(false); // but not worthwhile → hold off
	});

	it('does not fire when the window is unknown', () => {
		expect(
			shouldAutoCompact({
				branch: longBranch(),
				enabled: true,
				contextWindow: null,
				threshold: 80,
			}),
		).toBe(false);
	});

	it('does not fire when there is nothing to compact even if over threshold', () => {
		// 2 turns, latest near window, but too short to compact.
		const b = turns(2);
		b[b.length - 1] = msg('assistant', { id: 'a1', createdAt: 99, tokensIn: 7000, tokensOut: 200 });
		expect(
			shouldAutoCompact({ branch: b, enabled: true, contextWindow: 8192, threshold: 80 }),
		).toBe(false);
	});
});
