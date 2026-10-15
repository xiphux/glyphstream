/**
 * Memoised configuration: values derived from config.toml or the environment,
 * which don't change while the process runs, computed on first use.
 *
 * Every cache made here registers itself, so a test that changes the config or
 * the environment resets all of them with one `resetConfigCachesForTests()`
 * instead of knowing which modules memoise what. That used to be eight
 * differently named reset hooks, and several getters had none.
 *
 * Call `memoizeConfig` at module scope only (directly, or through a factory
 * like `createModelResolver` that is itself called at module scope). Each call
 * registers a cache for the life of the process, so one per request would leak.
 *
 * The registry is per module instance. After `vi.resetModules()` a test's
 * freshly imported modules register in a fresh registry, which a
 * `resetConfigCachesForTests` imported before the reset can't reach. Re-import
 * it, as with `setDbForTests`.
 *
 * Configuration only. Runtime state — endpoint gates, worker pools, in-flight
 * registries — keeps its own reset, because clearing it mid-test means
 * something different. One config cache stays outside: `push/web-push.ts`,
 * whose setup also configures the web-push library (`setVapidDetails`), a side
 * effect that forgetting the value wouldn't undo. It keeps
 * `_resetWebPushForTest`.
 */

export interface ConfigCache<T> {
	(): T;
	/** Forget the value, so the next call loads it again. */
	reset: () => void;
}

const caches = new Set<ConfigCache<unknown>>();

/**
 * `load`, run once and remembered. A throw is not remembered: the next call
 * tries again, so a transient failure (a config file mid-write, a mount that
 * isn't up yet) doesn't pin the process to it.
 */
export function memoizeConfig<T>(load: () => T): ConfigCache<T> {
	let slot: { value: T } | undefined;
	const get = (() => (slot ??= { value: load() }).value) as ConfigCache<T>;
	get.reset = () => {
		slot = undefined;
	};
	caches.add(get);
	return get;
}

/** Forget every memoised config value. For tests. */
export function resetConfigCachesForTests(): void {
	for (const cache of caches) cache.reset();
}
