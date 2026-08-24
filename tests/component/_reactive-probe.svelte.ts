/**
 * Rune harness for tests that need to observe the reactive graph the way a
 * component does.
 *
 * Lives in a `.svelte.ts` module because runes are only compiled in `.svelte`
 * and `.svelte.js/ts` files — using `$effect` directly inside a `.test.ts`
 * throws `rune_outside_svelte`. The leading underscore keeps it out of
 * vitest's test include glob, which only matches `.test.` / `.spec.` files.
 *
 * Importing tests MUST carry the `@vitest-environment happy-dom` header: under
 * the default `node` environment Svelte resolves to its SSR runtime, where
 * effects never run, so the probe records nothing at all. An assertion on a
 * published VALUE then fails loudly (`seen` is empty) — annoying but safe. The
 * dangerous shape is an assertion that something did NOT happen, e.g. checking
 * `seen.length` stayed put: that passes for the wrong reason, because nothing
 * was ever recorded. Prefer asserting on values.
 */

import { flushSync } from 'svelte';

/**
 * A reactive `{ value }` box, for stubbing a dep the controller under test reads
 * through a getter.
 *
 * A plain object won't do when the test needs the reactive graph to NOTICE the
 * change: controllers take their page state as getters (`convId: () => convId`),
 * and in the real page that closes over a `$state` binding. Stub it with a plain
 * field and a write is invisible to any derived or effect that depends on it —
 * so a test asserting "this republishes when the page navigates" would fail
 * against correct code, and one asserting the opposite would pass against
 * broken code.
 */
export function reactiveBox<T>(initial: T): { value: T } {
	let value = $state(initial);
	return {
		get value() {
			return value;
		},
		set value(next: T) {
			value = next;
		},
	};
}

/**
 * Subscribe to `read()` from inside a real `$effect` and record every value the
 * reactive graph publishes.
 *
 * Why an effect and not just calling `read()`: reading a `$derived` outside an
 * effect owner recomputes it eagerly, which masks a MISSING notification — the
 * exact failure mode worth testing. Only a real subscriber sees the difference
 * between "recomputed because something invalidated it" and "recomputed because
 * you happened to ask".
 *
 * Call `flushSync()` after each mutation, then assert on `seen.at(-1)`.
 * Remember to `dispose()` (an `afterEach` is the usual place).
 */
export function trackReactive<T>(read: () => T): { seen: T[]; dispose: () => void } {
	const seen: T[] = [];
	const dispose = $effect.root(() => {
		$effect(() => {
			seen.push(read());
		});
	});
	flushSync();
	return { seen, dispose };
}
