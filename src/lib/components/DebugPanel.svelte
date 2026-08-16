<!--
	"Stats for nerds" for GlyphStream — the numbers behind the current page
	load. Reached by double-activating the version number in the sidebar
	header; nothing links to it and nothing hints at it, which is the point.
	It exists for the load you can't attach a debugger to (an iOS home-screen
	cold launch) and should never appear during normal use.

	A dialog rather than a popover: three sections today with room for more
	(this is meant to be the home for future debug readouts), and the trigger
	lives in a sidebar that is a narrow drawer on the phone where this actually
	gets used — a bubble anchored there would be the cramped option on exactly
	the device it's for.

	Read fresh on each open, in an $effect so it never runs during SSR (there is
	no `performance` navigation entry on the server, and the panel is
	per-device by nature).
-->
<script lang="ts">
	import { buildDebugSections, readDebugSources, type DebugSection } from '$lib/debug-info';
	import { toast } from '$lib/toast.svelte';
	import BaseDialog from './BaseDialog.svelte';

	let { open, onClose }: { open: boolean; onClose: () => void } = $props();

	let sections = $state<DebugSection[]>([]);

	$effect(() => {
		if (open) sections = buildDebugSections(readDebugSources(__APP_VERSION__));
	});

	/** Plain text, for pasting into an issue. */
	function asText(): string {
		return sections
			.map(
				(s) =>
					`${s.title}\n` +
					s.rows.map((r) => `  ${r.label}: ${r.value}${r.note ? ` (${r.note})` : ''}`).join('\n'),
			)
			.join('\n\n');
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(asText());
			toast.success('Debug info copied');
		} catch {
			toast.error('Could not copy');
		}
	}
</script>

<BaseDialog {open} onCancel={onClose} role="dialog" titleId="debug-panel-title" title="Debug info">
	<div class="mt-3 space-y-3">
		{#each sections as section (section.title)}
			<section>
				<h3 class="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
					{section.title}
				</h3>
				<dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs tabular-nums">
					{#each section.rows as row (row.label)}
						<dt class="text-fg-muted">{row.label}</dt>
						<dd class="text-right font-medium text-fg">
							{row.value}
							{#if row.note}
								<span class="ml-1 font-normal text-fg-subtle">{row.note}</span>
							{/if}
						</dd>
					{/each}
				</dl>
			</section>
		{/each}
	</div>

	<p class="mt-3 text-[11px] leading-snug text-fg-muted">
		Timings describe the load that started this session — client-side navigation doesn't replace the
		document, so these survive until the next full reload.
	</p>

	<div class="mt-4 flex justify-end gap-2">
		<button
			type="button"
			onclick={copy}
			class="rounded-md border border-border px-3 py-1.5 text-xs transition hover:bg-surface-sunken"
		>
			Copy
		</button>
		<button
			type="button"
			onclick={onClose}
			class="rounded-md bg-surface-inverse px-3 py-1.5 text-xs font-medium text-fg-inverse transition hover:opacity-90"
		>
			Close
		</button>
	</div>
</BaseDialog>
