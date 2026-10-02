<script lang="ts">
	import { AlertCircle, Check, Info, X } from '@lucide/svelte';
	import { toast } from '$lib/toast.svelte';

	// Per-kind affordances. Keeping these in const maps rather than
	// computing inline so the icon + color choices are easy to skim
	// when adding a new kind later.
	const kindIcon = {
		success: Check,
		info: Info,
		error: AlertCircle,
	} as const;

	const kindIconClass = {
		success: 'text-success',
		info: 'text-fg-muted',
		error: 'text-danger',
	} as const;

	// Swipe-up to dismiss, touch only. A mouse already has a precise X; a
	// thumb mid-sentence does not, and flicking the banner away is the gesture
	// every iOS banner has taught. Implicit touch capture keeps pointermove on
	// this element without setPointerCapture — explicit capture would retarget
	// the click away from the Open / Dismiss buttons inside it.
	const SWIPE_DISMISS_PX = 32;
	let swipeStartY: number | null = null;
	let swipeDy = $state(0);

	function onPointerDown(e: PointerEvent) {
		if (e.pointerType === 'mouse') return;
		swipeStartY = e.clientY;
		swipeDy = 0;
	}

	// A toast can leave mid-swipe — its timer fires, or a new one replaces it.
	// The finger's pointerup then lands on whatever was underneath, never on
	// onPointerEnd, so without this the next toast would mount already shifted
	// up, and a plain tap on its Open could read as a dismissing swipe.
	$effect(() => {
		void toast.current?.id;
		swipeStartY = null;
		swipeDy = 0;
	});

	function onPointerMove(e: PointerEvent) {
		if (swipeStartY === null) return;
		// Upward only: the banner leaves the way it came in.
		swipeDy = Math.min(0, e.clientY - swipeStartY);
	}

	function onPointerEnd() {
		if (swipeStartY === null) return;
		const dismiss = swipeDy <= -SWIPE_DISMISS_PX;
		swipeStartY = null;
		swipeDy = 0;
		if (dismiss) toast.dismiss();
	}
</script>

<!--
	Singleton toast surface. Renders the one active toast from the
	`toast` store; replaces in place on each new toast (no stacking by
	design — see store header for rationale).

	Positioning: TOP on every form factor — full-width with side margins on
	mobile, top-right on sm+. Not the bottom: the composer lives there on every
	route that matters, and a toast raised while you type (another thread
	finishing, say) landed on the text box on a phone and on the send button on
	any desktop narrower than ~1950px (sidebar 256 + centred max-w-3xl composer
	vs. a right-anchored max-w-md toast). The inline `top: max(...)` clears the
	iOS status bar / notch when running as an installed PWA.

	role=status + aria-live=polite is the right level for transient
	confirmations: announced to assistive tech but doesn't steal focus.

	z-toast sits above z-overlay: this is the app's global notification layer,
	and a toast raised by something still on screen has to be readable over it.
	Sharing the overlay tier is what once left it behind a bg-black/60
	backdrop-blur, and made DebugPanel's Copy look like a dead button. Only
	z-update outranks it. The full ladder lives in app.css.
-->
{#if toast.current}
	{@const t = toast.current}
	{@const Icon = kindIcon[t.kind]}
	<div
		role="status"
		aria-live="polite"
		class="gs-pop fixed left-4 right-4 z-toast flex touch-none items-center gap-3 rounded-md border border-border surface-glass px-3 py-2.5 text-sm shadow-lg sm:left-auto sm:right-4 sm:max-w-md"
		style="top: max(1rem, calc(env(safe-area-inset-top) + 0.5rem))"
		style:translate={swipeDy ? `0 ${swipeDy}px` : undefined}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerEnd}
		onpointercancel={onPointerEnd}
	>
		<Icon size={16} strokeWidth={2.25} class="shrink-0 {kindIconClass[t.kind]}" />
		<span class="flex-1">
			{t.message}
			{#if t.description}
				<span class="block text-xs text-fg-muted">{t.description}</span>
			{/if}
		</span>
		{#if t.action}
			{@const action = t.action}
			<button
				type="button"
				onclick={async () => {
					// Capture the handler into a plain JS const *before*
					// dismissing. `action` is a Svelte `$derived` under
					// the hood — references to it are reactive reads
					// (`$.get(action)`), not snapshots. The moment we
					// call `toast.dismiss()` the dependency chain
					// (toast.current → t → action) is invalidated, and
					// the next read of `action` would recompute through
					// a now-null `t` and throw. A captured function ref
					// has no relationship to the reactive graph, so it
					// survives the dismiss cleanly.
					const handler = action.handler;
					toast.dismiss();
					await handler();
				}}
				class="rounded-md px-2 py-1 text-xs font-medium underline transition hover:bg-black/5 dark:hover:bg-white/10"
			>
				{action.label}
			</button>
		{/if}
		<button
			type="button"
			onclick={() => toast.dismiss()}
			aria-label="Dismiss"
			title="Dismiss"
			class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted transition hover:bg-black/5 hover:text-fg-secondary dark:hover:bg-white/10"
		>
			<X size={14} strokeWidth={2.25} />
		</button>
	</div>
{/if}
