/**
 * The arithmetic that keeps a response inside a reverse proxy's header buffer.
 *
 * Worth testing precisely because both failure directions are silent and remote:
 * over budget, nginx swaps the response for its own 502 while this server logs a
 * clean 200; over-trimmed, the page still renders and simply stops hydrating
 * promptly, because in this app the modulepreload hints exist only in that
 * header.
 */
import { describe, expect, it } from 'vitest';
import {
	HEADER_BUDGET_RESERVE_BYTES,
	PROXY_HEADER_BUFFER_BYTES,
	TRANSPORT_OVERHEAD_BYTES,
	headerBlockBytes,
	trimToBudget,
} from '../../src/lib/server/util/header-budget';

describe('headerBlockBytes', () => {
	it('counts what a proxy counts, not what a Headers object reports', () => {
		// `a: b\r\n` is 6, `cc: dd\r\n` is 8, plus the terminating CRLF.
		expect(headerBlockBytes([['a', 'b']])).toBe(8);
		expect(
			headerBlockBytes([
				['a', 'b'],
				['cc', 'dd'],
			]),
		).toBe(16);
	});

	it('counts an empty block as just the terminator', () => {
		expect(headerBlockBytes([])).toBe(2);
	});

	it('counts duplicate names separately', () => {
		// Set-Cookie legitimately repeats, and each copy costs bytes on the wire.
		expect(
			headerBlockBytes([
				['set-cookie', 'x'],
				['set-cookie', 'y'],
			]),
		).toBe(2 + 15 + 15);
	});
});

describe('trimToBudget', () => {
	const entries = (n: number) =>
		Array.from({ length: n }, (_, i) => `<//_app/immutable/c${i}.js>; rel="modulepreload"`).join(
			', ',
		);

	it('leaves a value that already fits completely alone', () => {
		const v = entries(3);
		expect(trimToBudget(v, v.length)).toBe(v);
		expect(trimToBudget(v, v.length + 100)).toBe(v);
	});

	it('keeps a whole-entry prefix rather than a truncated entry', () => {
		// A half-written entry is not a smaller hint, it is a malformed header —
		// the browser may discard the whole field and lose every hint in it.
		const v = entries(10);
		const out = trimToBudget(v, 120)!;
		expect(out.length).toBeLessThanOrEqual(120);
		expect(v.startsWith(out)).toBe(true);
		for (const part of out.split(', ')) expect(part).toMatch(/^<\S+>; rel="modulepreload"$/);
	});

	it('keeps the earliest entries, which are the entry chunks', () => {
		// SvelteKit emits them in dependency order, so a prefix is the slice that
		// unblocks the most work — dropping the tail costs the least.
		const out = trimToBudget(entries(10), 120)!;
		expect(out.startsWith('<//_app/immutable/c0.js>')).toBe(true);
	});

	it('returns null when not even one entry fits', () => {
		// Signals "drop the header" rather than emitting an empty or partial one.
		expect(trimToBudget(entries(5), 10)).toBeNull();
		expect(trimToBudget(entries(5), 0)).toBeNull();
		expect(trimToBudget(entries(5), -50)).toBeNull();
	});

	it('does not split on commas inside an entry', () => {
		// Link params are semicolon-separated and SvelteKit joins entries with
		// ", " exactly; splitting on a bare comma would corrupt a value.
		const v = '<//a.js>; rel="preload"; as="font"; crossorigin, <//b.js>; rel="modulepreload"';
		expect(trimToBudget(v, 1000)).toBe(v);
		// 47 is exactly the first entry; 46 can't fit it, so nothing survives.
		expect(trimToBudget(v, 47)).toBe('<//a.js>; rel="preload"; as="font"; crossorigin');
		expect(trimToBudget(v, 46)).toBeNull();
	});
});

describe('the budget constants', () => {
	it('reserves for the bytes a Response object cannot show', () => {
		// The status line and Node's transport fields (Date, Connection,
		// Keep-Alive, content-length) are counted by the proxy and invisible to
		// `finalResponse.headers` — measured at 76 on this stack. Budgeting
		// without them puts the block over the buffer by exactly that much, and
		// the only symptom is a 502 from someone else's logs.
		expect(TRANSPORT_OVERHEAD_BYTES).toBeGreaterThan(76);
	});

	it('leaves real headroom under the proxy buffer', () => {
		// The reserve is the whole point: production sat 20 bytes under the raw
		// buffer and a single Set-Cookie tipped it.
		expect(HEADER_BUDGET_RESERVE_BYTES).toBeGreaterThan(0);
		expect(PROXY_HEADER_BUFFER_BYTES - HEADER_BUDGET_RESERVE_BYTES).toBeLessThan(
			PROXY_HEADER_BUFFER_BYTES,
		);
	});
});
