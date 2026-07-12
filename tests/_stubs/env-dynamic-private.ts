/**
 * Test stand-in for SvelteKit's `$env/dynamic/private`.
 *
 * Under vitest that module resolves to an EMPTY object: it's populated by the
 * SvelteKit server at runtime, and nothing in a bare vitest run does that. So
 * every `env.X` read in `src/lib/server/env.ts` fell through to its hard-coded
 * fallback, and `vitest.config.ts`'s `env: { CONFIG_PATH: … }` — which sets
 * `process.env` — never reached it. The isolation it claimed to provide was inert,
 * and the unit suite had been quietly reading the developer's REAL `./config.toml`
 * all along (which is why the suite behaved differently on a dev machine than in
 * CI, where there is no config.toml at all).
 *
 * Aliasing the module to `process.env` closes that: vitest's `env` block now
 * actually lands, `configPath()` resolves to a path that doesn't exist, and the
 * loaders degrade to their documented defaults. Tests get one deterministic
 * baseline regardless of what's on the developer's disk.
 */
export const env = process.env as Record<string, string | undefined>;
