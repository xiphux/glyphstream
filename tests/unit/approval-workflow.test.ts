/** Tests for the approval-workflow primitives. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildApprovalDecisionsSnapshot,
	runApprovalResume,
	type ApprovalAction,
} from '$lib/approval-workflow';

describe('buildApprovalDecisionsSnapshot', () => {
	it('maps each id to its decision, in iteration order', () => {
		const ids = ['t1', 't2', 't3'];
		const decisions = new Map<string, ApprovalAction>([
			['t1', 'allow'],
			['t2', 'allow_always'],
			['t3', 'reject'],
		]);
		expect(buildApprovalDecisionsSnapshot(ids, decisions)).toEqual([
			{ toolCallId: 't1', action: 'allow' },
			{ toolCallId: 't2', action: 'allow_always' },
			{ toolCallId: 't3', action: 'reject' },
		]);
	});

	it('defaults missing decisions to reject (the safe choice)', () => {
		const ids = ['t1', 't2'];
		const decisions = new Map<string, ApprovalAction>([['t1', 'allow']]);
		expect(buildApprovalDecisionsSnapshot(ids, decisions)).toEqual([
			{ toolCallId: 't1', action: 'allow' },
			{ toolCallId: 't2', action: 'reject' },
		]);
	});

	it('accepts any Iterable (Set works, for the live+persisted union case)', () => {
		const ids = new Set(['t1', 't2']);
		const decisions = new Map<string, ApprovalAction>([
			['t1', 'allow'],
			['t2', 'reject'],
		]);
		const snapshot = buildApprovalDecisionsSnapshot(ids, decisions);
		expect(snapshot).toHaveLength(2);
		expect(snapshot).toEqual(
			expect.arrayContaining([
				{ toolCallId: 't1', action: 'allow' },
				{ toolCallId: 't2', action: 'reject' },
			]),
		);
	});

	it('returns an empty array for an empty id set', () => {
		expect(buildApprovalDecisionsSnapshot([], new Map())).toEqual([]);
	});
});

describe('runApprovalResume', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function makeResponse(opts: {
		ok?: boolean;
		status?: number;
		body?: ReadableStream<Uint8Array> | null;
		jsonBody?: unknown;
	}): Response {
		const ok = opts.ok ?? true;
		const status = opts.status ?? (ok ? 200 : 500);
		const body = opts.body === undefined ? new ReadableStream() : opts.body;
		const res = {
			ok,
			status,
			body,
			json: async () => {
				if (opts.jsonBody === undefined) throw new Error('no json');
				return opts.jsonBody;
			},
		};
		return res as unknown as Response;
	}

	it('POSTs to the resume endpoint with the right URL, headers, body, and signal', async () => {
		const fetchMock = vi.fn(async () => makeResponse({}));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const consumeStream = vi.fn(async () => ({ sawToolCalls: false }));
		const signal = new AbortController().signal;

		await runApprovalResume(
			'conv-1',
			[{ toolCallId: 't1', action: 'allow' }],
			signal,
			consumeStream,
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/conversations/conv-1/tool-approval');
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
		expect((init.headers as Record<string, string>).Accept).toBe('text/event-stream');
		expect(init.body).toBe(JSON.stringify({ decisions: [{ toolCallId: 't1', action: 'allow' }] }));
		expect(init.signal).toBe(signal);
	});

	it('returns the result of consumeStream', async () => {
		globalThis.fetch = (async () => makeResponse({})) as unknown as typeof fetch;
		const result = await runApprovalResume(
			'conv-1',
			[],
			new AbortController().signal,
			async () => ({ sawToolCalls: true }),
		);
		expect(result).toEqual({ sawToolCalls: true });
	});

	it('throws with the server message on !res.ok', async () => {
		globalThis.fetch = (async () =>
			makeResponse({
				ok: false,
				status: 409,
				// SvelteKit's `error(409, msg)` surfaces as `{ message }` at the top level.
				jsonBody: { message: 'No pending tool calls matched' },
			})) as unknown as typeof fetch;

		await expect(
			runApprovalResume('conv-1', [], new AbortController().signal, async () => ({
				sawToolCalls: false,
			})),
		).rejects.toThrow(/No pending tool calls matched/);
	});

	it('throws on a missing response body', async () => {
		globalThis.fetch = (async () => makeResponse({ body: null })) as unknown as typeof fetch;
		await expect(
			runApprovalResume('conv-1', [], new AbortController().signal, async () => ({
				sawToolCalls: false,
			})),
		).rejects.toThrow(/no body/i);
	});

	it('does not call consumeStream when the fetch errors', async () => {
		globalThis.fetch = (async () =>
			makeResponse({ ok: false, status: 500 })) as unknown as typeof fetch;
		const consumeStream = vi.fn();
		await expect(
			runApprovalResume('conv-1', [], new AbortController().signal, consumeStream),
		).rejects.toThrow();
		expect(consumeStream).not.toHaveBeenCalled();
	});
});
