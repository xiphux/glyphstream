/**
 * The unit suite must not read the developer's real ./config.toml.
 *
 * It used to. `vitest.config.ts` set `env: { CONFIG_PATH: … }`, but `configPath()`
 * reads `$env/dynamic/private`, which is populated by the SvelteKit SERVER at
 * runtime and is an EMPTY object under vitest — so the setting never landed and
 * every read fell through to the './config.toml' fallback. Tests that don't fully
 * mock the config layer therefore behaved one way on a dev machine (a real config,
 * with [search] and [embeddings] blocks) and another way in CI (no config at all).
 *
 * `vitest.config.ts` now aliases that module to `tests/_stubs/env-dynamic-private.ts`,
 * which reads `process.env`. This test is the guard: it fails the moment the alias
 * is dropped, rather than letting the suite quietly go back to reading whatever
 * happens to be on the machine running it.
 */
import { describe, expect, it } from 'vitest';
import { configPath } from '$lib/server/env';
import { loadEndpoints } from '$lib/server/endpoints/config';

describe('config isolation', () => {
	it("resolves CONFIG_PATH from vitest's env, not the './config.toml' fallback", () => {
		expect(configPath()).toBe('/glyphstream-test-no-such-config.toml');
	});

	it('sees no config at all, on any machine', () => {
		// The deterministic baseline every unmocked test is written against. (A dev
		// machine's real config.toml defines endpoints; this must still be empty.)
		expect(loadEndpoints()).toEqual([]);
	});
});
