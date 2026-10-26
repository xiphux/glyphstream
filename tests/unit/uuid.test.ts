import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from '#lib/uuid.js';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('randomUUID', () => {
	it('uses crypto.randomUUID where it exists', () => {
		vi.stubGlobal('crypto', { randomUUID: () => 'native' });
		expect(randomUUID()).toBe('native');
	});

	it('builds a v4 UUID from getRandomValues in an insecure context', () => {
		// Plain-http browsers expose getRandomValues but not randomUUID.
		const real = globalThis.crypto;
		vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
		const ids = new Set(Array.from({ length: 100 }, () => randomUUID()));
		expect(ids.size).toBe(100);
		for (const id of ids) expect(id).toMatch(V4);
	});

	it('sets the version and variant bits whatever the random bytes are', () => {
		vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.fill(0xff) });
		expect(randomUUID()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
		vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.fill(0) });
		expect(randomUUID()).toBe('00000000-0000-4000-8000-000000000000');
	});
});

// Client code runs in the browser, where a direct crypto.randomUUID() throws
// over plain http. Server code always has it (node), so it's exempt.
describe('client code goes through #lib/uuid', () => {
	const SRC = resolve(__dirname, '../../src');
	const isServer = (rel: string) =>
		rel.startsWith('lib/server/') || /(^|\/)\+server\.ts$|\.server\.ts$/.test(rel);

	function files(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
			const p = join(dir, e.name);
			if (e.isDirectory()) return files(p);
			return /\.(ts|svelte)$/.test(e.name) ? [p] : [];
		});
	}

	it('has no direct crypto.randomUUID() call outside the helper', () => {
		const offenders = files(SRC)
			.map((p) => relative(SRC, p))
			.filter((rel) => !isServer(rel) && rel !== 'lib/uuid.ts')
			.filter((rel) => readFileSync(join(SRC, rel), 'utf8').includes('crypto.randomUUID('));
		expect(offenders).toEqual([]);
	});
});
