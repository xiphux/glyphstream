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
		success: 'text-emerald-600 dark:text-emerald-400',
		info: 'text-fg-muted',
		error: 'text-red-600 dark:text-red-400',
	} as const;
</script>

<!--
	Singleton toast surface. Renders the one active toast from the
	`toast` store; replaces in place on each new toast (no stacking by
	design — see store header for rationale).

	Positioning: bottom-center on mobile (full-width with side margins)
	to leave the message readable on narrow screens, bottom-right on
	sm+ so it sits out of the way of primary content. The inline
	`bottom: max(...)` keeps the toast above the iOS safe-area inset
	when running as an installed PWA — same pattern as UpdateBanner.

	role=status + aria-live=polite is the right level for transient
	confirmations: announced to assistive tech but doesn't steal focus.
-->
{#if toast.current}
	{@const t = toast.current}
	{@const Icon = kindIcon[t.kind]}
	<div
		role="status"
		aria-live="polite"
		class="gs-pop fixed left-4 right-4 z-50 flex items-center gap-3 rounded-md border border-border surface-glass px-3 py-2.5 text-sm shadow-lg sm:left-auto sm:right-4 sm:max-w-md"
		style="bottom: max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))"
	>
		<Icon size={16} strokeWidth={2.25} class="shrink-0 {kindIconClass[t.kind]}" />
		<span class="flex-1">{t.message}</span>
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
