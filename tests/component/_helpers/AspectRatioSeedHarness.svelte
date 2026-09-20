<!--
	Harness for AspectRatioSelector's two bindings.

	`seed` and `value` are `$bindable`, and a binding only actually syncs through
	a real `bind:` — a getter/setter pair on a plain props object does not. So a
	test that needs to observe what the child wrote into its parent has to have a
	parent. This exposes both through callbacks the test can spy on.

	It also lets a test UNMOUNT and REMOUNT the selector (via `mounted`), which is
	the sequence the seed-retirement fix exists for: the real composer destroys
	the selector whenever no selected model offers ratios.
-->
<script lang="ts">
	import AspectRatioSelector from '$lib/components/chat/AspectRatioSelector.svelte';
	import type { AspectRatioOption } from '$lib/types/api';

	interface Props {
		options: AspectRatioOption[];
		defaultValue?: string;
		initialSeed?: string | null;
		/** The live prompt, as the composer passes it — re-passed to retype. */
		promptText?: string;
		/** Toggle to destroy and recreate the selector, as the composer does. */
		mounted?: boolean;
		onSeedChange?: (seed: string | null) => void;
		onValueChange?: (value: string | null) => void;
	}

	let {
		options,
		defaultValue,
		initialSeed = null,
		promptText = '',
		mounted = true,
		onSeedChange,
		onValueChange,
	}: Props = $props();

	// Page-level state, exactly as `(app)/+page.svelte` holds it.
	// svelte-ignore state_referenced_locally
	// Capturing only the INITIAL value is the point: a rerender that re-passes the
	// same `initialSeed` must not re-seed, or the remount test below could never
	// tell a retired seed from a re-applied one.
	let seed = $state<string | null>(initialSeed);
	let value = $state<string | null>(null);
	// Page-level too, and for the same reason: it has to outlive the `mounted`
	// toggle below, which is what makes the remount cases testable at all.
	let dismissedRatio = $state<string | null>(null);
	// The composers hold the selector this way to commit a pending detection on
	// send; the tests need the same handle to prove it lands in one tick.
	let ratioRef = $state<{ flushDetection: () => void } | null>(null);
	export function flushDetection() {
		ratioRef?.flushDetection();
	}
	/**
	 * The bound value, read synchronously — the way a send builder reads it.
	 * `onValueChange` cannot serve here: it fires from an `$effect`, and effects are
	 * batched to a microtask, so it would report one tick late and a test using it
	 * would fail against a flush that is working correctly.
	 */
	export function currentValue(): string | null {
		return value;
	}

	$effect(() => {
		onSeedChange?.(seed);
	});
	$effect(() => {
		onValueChange?.(value);
	});
</script>

{#if mounted && options.length > 0}
	<AspectRatioSelector
		bind:this={ratioRef}
		{options}
		{defaultValue}
		{promptText}
		bind:seed
		bind:value
		bind:dismissedRatio
	/>
{/if}
