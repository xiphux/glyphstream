<!--
	The quiet line under a reply whose check-in is pending (see `check-ins.ts`):
	when it will come, and a way to call it off. What the model meant to say stays
	unshown — it's meant to arrive as a surprise.
-->
<script lang="ts">
	import { Clock } from '@lucide/svelte';
	import type { PendingCheckInNote } from '#lib/check-ins.js';

	let { checkIn }: { checkIn: PendingCheckInNote } = $props();

	const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
	const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
	/** "3:40 PM", or "Tue 3:40 PM" when it isn't today. */
	function fireTime(at: number): string {
		const sameDay = new Date(at).toDateString() === new Date().toDateString();
		return sameDay ? timeFormat.format(at) : `${dayFormat.format(at)} ${timeFormat.format(at)}`;
	}
</script>

<div class="flex items-center gap-1.5 px-1 pt-0.5 text-xs text-fg-muted">
	<Clock class="size-3.5 shrink-0" aria-hidden="true" />
	<span>Will check in around {fireTime(checkIn.fireAt)}</span>
	<span aria-hidden="true">·</span>
	<button
		type="button"
		onclick={() => checkIn.onCancel()}
		class="underline-offset-2 transition hover:text-fg-secondary hover:underline"
	>
		Cancel
	</button>
</div>
