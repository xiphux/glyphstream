/**
 * Compose server `handle` hooks, outermost first: each hook's work before
 * `resolve` runs in order, and its work after `resolve` in reverse.
 *
 * Not Kit's own `sequence()`: in SvelteKit 3 that reads Kit's internal
 * request store, which exists only inside the real server, so a hook built
 * with it can't be called from a unit test, and `hooks-handle.test.ts` is
 * what holds the gates' order. Kit still sets that store up around `handle`
 * itself in production, so nothing inside these hooks loses it.
 *
 * Resolve options a hook passes are merged into those of the hooks outside
 * it, inner winning, and reach Kit's `resolve` together. Only one of ours
 * passes any (the theme's `transformPageChunk`), so nothing here composes
 * two transforms.
 */
import type { Handle, ResolveOptions } from '@sveltejs/kit/hooks';

export function chainHandles(...hooks: Handle[]): Handle {
	return ({ event, resolve }) => {
		const run = (
			i: number,
			ev: typeof event,
			opts: ResolveOptions | undefined,
		): Response | Promise<Response> =>
			i === hooks.length
				? resolve(ev, opts)
				: hooks[i]({
						event: ev,
						resolve: async (next, more) => run(i + 1, next, more ? { ...opts, ...more } : opts),
					});
		return run(0, event, undefined);
	};
}
