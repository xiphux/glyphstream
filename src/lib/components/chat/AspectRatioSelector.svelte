<!--
	Shape picker for image / video models that advertise `aspect_ratios`
	(openai-api-bridge; see its docs/aspect-ratios.md). Sits in the composer
	action row beside the model picker, because the shape is part of composing a
	prompt rather than a setting you go elsewhere to change.

	The whole menu is DATA — the ratios come off the model row, never from a
	table here. So the icon is drawn from the two numbers in the value rather
	than picked from a set of per-ratio glyphs: a workflow offering something
	unusual (a third-party resolution node's "5:7 (Balanced Portrait)") renders
	correctly with nothing in this file that knows it exists, and `label` is only
	ever decoration.

	Hand-rolled option buttons rather than a bits-ui ToggleGroup / Select: the
	chat route's initial bundle is budgeted (tests/e2e/bundle-budget.spec.ts) and
	`Popover` is the one primitive already in this chunk via FeatureTogglesMenu,
	so this adds markup and no library.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { Popover } from 'bits-ui';
	import { ChevronDown, Sparkles } from '@lucide/svelte';
	import type { AspectRatioOption } from '$lib/types/api';
	import {
		clearStickyRatio,
		detectRatioInPrompt,
		nearestOffered,
		parseRatio,
		readStickyRatio,
		writeStickyRatio,
	} from '$lib/aspect-ratio';

	interface Props {
		/** Ratios to offer — the union across the selected models, in render order. */
		options: AspectRatioOption[];
		/**
		 * What the selected model does when a request names no ratio — used to LABEL
		 * the "Default" entry, not to preselect a concrete shape.
		 *
		 * Undefined when there is nothing single to report: no model advertises a
		 * default, or several are selected and they disagree. Default still works
		 * then; it just can't say what it will resolve to, because per model it
		 * resolves to something different — which is the whole point of it.
		 */
		defaultValue?: string;
		/**
		 * A shape to open on regardless of the remembered preference — set when
		 * regenerating an existing image, so the re-run reproduces its framing.
		 *
		 * Bindable, and CLEARED here the moment the user picks: it is a one-shot
		 * intent, not a mode. It has to retire in the parent's state rather than in
		 * this component's, because this component unmounts whenever no selected
		 * model offers ratios — a local "already picked" flag resets on the remount
		 * and the stale seed would win again, silently reverting a choice the user
		 * had already made.
		 *
		 * Never rewrites the stored preference: reproducing one image is not a
		 * change of what they usually want.
		 */
		seed?: string | null;
		/**
		 * The ratio to send for this turn, or null for "send nothing".
		 *
		 * Null is a first-class choice, not an empty state: it is what the "Default"
		 * entry selects, and it is the only way to say "let each model use its own
		 * default" — which matters for a fan-out, where any concrete value would be
		 * imposed on every branch. The send builders already omit the field when
		 * this is falsy, so null needs no special handling downstream.
		 *
		 * Owned here and reported upward, so both composers get the
		 * remembered-preference behaviour for free.
		 */
		value: string | null;
		/**
		 * The prompt being composed, scanned for a ratio the user named in prose
		 * ("create a 9:16 poster of…"). Live text, not the sent message: the point is
		 * for the picker to reflect what they asked for while they are still typing.
		 *
		 * Debounced and matched HERE rather than in the composer so the rule lives
		 * once — there are two composers, and they had already drifted into
		 * byte-identical copies of the last derivation that escaped this file.
		 */
		promptText?: string;
		/**
		 * A detection the user has already answered by picking something else, so it
		 * stops outranking them.
		 *
		 * Bindable, and owned by whoever owns `promptText`, for the same reason `seed`
		 * is: this component is destroyed whenever no selected model offers ratios
		 * (and, on the chat page, for the duration of an inline edit), while the
		 * prompt that produced the detection is not. Held locally it would reset on
		 * the remount, the unchanged prompt would be re-detected, and the shape the
		 * user overrode would quietly come back — which is the same failure the
		 * `seed` note below describes, and the reason that one is a prop too.
		 *
		 * Held BY VALUE, not as a boolean: a boolean would either let every keystroke
		 * re-slam the picker over a deliberate choice, or kill detection for the rest
		 * of the compose so that editing 9:16 → 16:9 in the text did nothing. Keyed to
		 * the value, an overridden detection stays dead while a DIFFERENT one is a new
		 * signal and speaks up.
		 */
		dismissedRatio?: string | null;
		disabled?: boolean;
	}

	let {
		options,
		defaultValue,
		seed = $bindable(null),
		value = $bindable(),
		promptText = '',
		dismissedRatio = $bindable(null),
		disabled = false,
	}: Props = $props();

	let open = $state(false);

	/**
	 * Quiet period before the prompt is re-scanned.
	 *
	 * Not a CPU concern — a regex over a prompt is nothing beside the markdown pump
	 * this route already runs per frame. It buys visual stability, but only in a
	 * narrower case than it first appears: because detection matches OFFERED ratios
	 * exactly, every partial nobody advertises is already ignored, and typing
	 * "9:16" past "9:1" is silent unless "9:1" is itself on the menu. The flicker
	 * is real when one advertised ratio is a text prefix of another, which is a
	 * property of whatever workflow someone wrote rather than of this code — so it
	 * is throttled unconditionally instead of audited per list.
	 */
	const DETECT_DEBOUNCE_MS = 300;

	// Seeded from the prop rather than '' so a mount starts level with the text
	// already in the box — a restored draft, or the remount after a model switch.
	// Starting empty would open a DETECT_DEBOUNCE_MS window in which `detected` is
	// null for a prompt that plainly names a ratio, and the release below reads
	// exactly that signal: it would fire inside the window and drop a dismissal the
	// parent is holding, handing the reverted-pick bug back. Both are props, equal
	// on server and client, so this costs no hydration mismatch.
	// svelte-ignore state_referenced_locally
	let debouncedPrompt = $state(promptText);
	$effect(() => {
		const next = promptText;
		const timer = setTimeout(() => {
			debouncedPrompt = next;
		}, DETECT_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	});

	const detected = $derived(detectRatioInPrompt(debouncedPrompt, options));

	/**
	 * Release the dismissal once the detection it answered stops standing.
	 *
	 * An override answers the ratio being claimed AT THAT MOMENT, not that ratio
	 * for good. Without this the chat page — where the composer survives a send —
	 * would let one override silence 16:9 for the rest of the conversation: the
	 * next prompt naming it would be ignored, with no indicator, and the turn would
	 * go out at the remembered preference while the prose said otherwise.
	 *
	 * Keying the release to "no detection stands" rather than to the send covers
	 * the same ground without the composer having to tell us a turn ended, and it
	 * also catches clearing the box by hand and retyping, which no send-time reset
	 * would see.
	 */
	$effect(() => {
		if (detected === null) dismissedRatio = null;
	});

	const liveDetection = $derived(
		detected !== null && detected !== dismissedRatio ? detected : null,
	);

	/**
	 * The user's last deliberate pick. Loaded in `onMount` rather than at init
	 * depth: init also runs during SSR, where `localStorage` doesn't exist, and
	 * a value appearing only on the client would be a hydration mismatch.
	 */
	let preference = $state<string | null>(null);
	onMount(() => {
		preference = readStickyRatio();
	});

	/**
	 * Resolve the preference against what's actually on offer, so the control
	 * shows what the user will GET rather than what it happens to be holding.
	 * Switching to a model with a different menu must not leave a value
	 * highlighted that the list no longer contains.
	 *
	 * No preference — or one that resolves to nothing — lands on Default (null)
	 * rather than being forced onto the first option. Null is a real selection
	 * here, so there is no blank state to defend against.
	 *
	 * Precedence, strongest first: the one-shot seed (reproducing a specific
	 * image's framing is the most specific intent there is), then a ratio named in
	 * the prompt, then the remembered preference. A prompt beats the preference
	 * because it is about THIS image and the preference is only about the ones
	 * before it; it does not beat an explicit pick, because `pick` dismisses the
	 * detection standing at that moment.
	 */
	$effect(() => {
		const wanted = seed ?? liveDetection ?? preference;
		value = nearestOffered(wanted, options)?.value ?? null;
	});

	/** `null` picks Default — "send nothing, let each model decide". */
	function pick(next: string | null) {
		// Retire the one-shot seed in the PARENT's state, so it can't outlive this
		// component and override the pick after a remount.
		seed = null;
		// Answer whatever the prompt is currently claiming, so a deliberate pick
		// isn't overwritten on the next keystroke. Recorded in the PARENT's state
		// for the same reason the seed is retired there — see the prop.
		dismissedRatio = detected;
		// Written on the PICK, not on send: see writeStickyRatio.
		preference = next;
		if (next === null) clearStickyRatio();
		else writeStickyRatio(next);
		open = false;
	}

	const selected = $derived(options.find((o) => o.value === value) ?? null);
	/** Null value = the Default entry is what's chosen. */
	const isDefault = $derived(value === null);
	/**
	 * Whether what's selected is selected BECAUSE the prompt named it — the
	 * condition for showing the indicator. Compared against `value` rather than
	 * read off `liveDetection` alone so a seed that outranked the detection
	 * doesn't get credited to the prompt.
	 */
	const fromPrompt = $derived(liveDetection !== null && value === liveDetection);

	/**
	 * Box dimensions for a ratio's glyph, inside a fixed square. The wider side
	 * fills the box and the other is scaled down, so the row of options reads as
	 * a set of shapes at a constant scale rather than a set of equal-area boxes.
	 */
	function glyph(ratioValue: string, box: number): { w: number; h: number } {
		const r = parseRatio(ratioValue);
		if (r === null) return { w: box, h: box };
		return r >= 1 ? { w: box, h: box / r } : { w: box * r, h: box };
	}
</script>

{#snippet shape(ratioValue: string, box: number, dashed = false)}
	{@const g = glyph(ratioValue, box)}
	<svg
		width={box}
		height={box}
		viewBox="0 0 {box} {box}"
		aria-hidden="true"
		class="shrink-0 overflow-visible"
	>
		<rect
			x={(box - g.w) / 2}
			y={(box - g.h) / 2}
			width={g.w}
			height={g.h}
			rx="1.5"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-dasharray={dashed ? '2 2' : undefined}
		/>
	</svg>
{/snippet}

<Popover.Root bind:open>
	<Popover.Trigger
		{disabled}
		aria-label={isDefault
			? "Aspect ratio: each model's default"
			: `Aspect ratio: ${selected?.label ?? selected?.value}${
					fromPrompt ? ' (found in your prompt)' : ''
				}`}
		title="Aspect ratio"
		class="group inline-flex shrink-0 items-center gap-1 rounded-md border-0 bg-transparent px-2 py-1 text-xs text-fg-muted transition hover:bg-surface-raised hover:text-fg-secondary disabled:opacity-30"
	>
		<!-- Dashed outline = Default, and it keys off the same `isDefault` the menu
		     row does. Asking `selected === null` instead would be a SECOND question
		     with its own answer: `selected` is also null for a value absent from
		     `options`, so the trigger could read Default while the row did not. -->
		{@render shape(selected?.value ?? defaultValue ?? '1:1', 13, isDefault)}
		<span class="tabular-nums">{selected?.value ?? 'Default'}</span>
		{#if fromPrompt}
			<!-- Says WHY this is selected, for a change the user didn't make by hand.
			     Reusing Sparkles because AvatarMenu already pulls it into this chunk;
			     a second icon would be new bytes on a budgeted route for no gain. -->
			<Sparkles size={10} class="text-accent" />
		{/if}
		<ChevronDown size={12} class="opacity-60" />
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			sideOffset={6}
			align="start"
			avoidCollisions
			collisionPadding={{ top: 60, right: 12, bottom: 12, left: 12 }}
			onOpenAutoFocus={(e) => e.preventDefault()}
			class="surface-glass gs-pop z-overlay w-[min(260px,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-border shadow-lg"
		>
			<div class="px-3 pb-1.5 pt-3 text-xs font-medium uppercase tracking-wide text-fg-muted">
				Aspect ratio
			</div>
			{#if fromPrompt}
				<!-- Named here as well as on the trigger, because the trigger only has room
				     for a glyph and the user's question is "why is this one set?". -->
				<div class="flex items-center gap-1.5 px-3 pb-2 text-[10px] text-accent">
					<Sparkles size={11} class="shrink-0" />
					<span>Found <span class="tabular-nums">{liveDetection}</span> in your prompt</span>
				</div>
			{/if}
			<!--
				Default gets its own full-width row above a divider, because it is not a
				shape — it is the absence of one. Picking it sends no ratio at all, so
				each model (and in a fan-out, each branch) falls back to its own. That
				is otherwise inexpressible: any concrete pick is imposed on every branch.
			-->
			<div class="px-2 pb-1">
				<button
					type="button"
					aria-pressed={isDefault}
					onclick={() => pick(null)}
					class={[
						'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition',
						isDefault
							? 'border-accent bg-accent/10 text-accent'
							: 'border-transparent text-fg-secondary hover:border-border hover:bg-surface-sunken',
					]}
				>
					{@render shape(defaultValue ?? '1:1', 16, true)}
					<span class="min-w-0">
						<span class="block">Default</span>
						<span class="block truncate text-[10px] text-fg-muted">
							{defaultValue ? `The model's own — ${defaultValue}` : "Each model's own"}
						</span>
					</span>
				</button>
			</div>
			<div class="mx-2 mb-1 border-t border-border"></div>
			<div class="grid grid-cols-2 gap-1 p-2 pt-0">
				{#each options as option (option.value)}
					{@const isSelected = option.value === value}
					<button
						type="button"
						aria-pressed={isSelected}
						onclick={() => pick(option.value)}
						class={[
							'flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition',
							isSelected
								? 'border-accent bg-accent/10 text-accent'
								: 'border-transparent text-fg-secondary hover:border-border hover:bg-surface-sunken',
						]}
					>
						{@render shape(option.value, 16)}
						<span class="min-w-0">
							<span class="flex items-center gap-1">
								<span class="tabular-nums">{option.value}</span>
								<!-- Gated on `fromPrompt`, like the trigger badge and the line
							     above, so all three agree. Keyed to `liveDetection` alone it
							     would mark a row the prompt named but a seed outranked —
							     sparkling an unselected row with no line to explain it. -->
								{#if fromPrompt && option.value === liveDetection}
									<Sparkles size={9} class="shrink-0 opacity-70" />
								{/if}
							</span>
							{#if option.label}
								<!-- Decoration only: absent for a ratio whose upstream gave it
								     no name, and never a placeholder in that case. -->
								<span class="block truncate text-[10px] text-fg-muted">{option.label}</span>
							{/if}
						</span>
					</button>
				{/each}
			</div>
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
