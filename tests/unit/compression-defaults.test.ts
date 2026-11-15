/**
 * Both compression switches default ON and turn off only on an explicit
 * falsy value. Defaulting COMPRESS_DYNAMIC off on the theory that a proxy
 * compresses and doing it twice is waste is wrong: a proxy passes an
 * already-encoded response through, so it never happens twice — and deploys
 * whose proxy can't compress ship everything raw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressDynamicResponses, compressStreamingResponses } from '#lib/server/env.js';

afterEach(() => vi.unstubAllEnvs());

describe.each([
	['COMPRESS_DYNAMIC', compressDynamicResponses],
	['COMPRESS_STREAMS', compressStreamingResponses],
] as const)('%s', (name, read) => {
	it('is on when unset, or set to anything but off', () => {
		vi.stubEnv(name, '');
		expect(read()).toBe(true);
		for (const v of ['1', 'true', 'on', 'yes']) {
			vi.stubEnv(name, v);
			expect(read()).toBe(true);
		}
	});

	it('turns off on 0 / false / no / off', () => {
		for (const v of ['0', 'false', 'no', 'off', 'OFF']) {
			vi.stubEnv(name, v);
			expect(read()).toBe(false);
		}
	});
});
