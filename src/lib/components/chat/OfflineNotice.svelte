<!--
	Offline notice for the composer. Option-1 offline handling: while the
	browser reports no network we BLOCK sending rather than queueing, and the
	composer keeps the user's typed text (a blocked send never clears the box,
	and the draft is persisted to localStorage) — so the message survives a
	brief dead-zone / tunnel drop, or even an iOS PWA kill, and can be sent on
	reconnect. Purely presentational; the parent owns the `offline` decision
	and re-enables Send when connectivity returns.
-->
<script lang="ts">
	import { WifiOff } from '@lucide/svelte';
</script>

<div
	class="flex items-center gap-2 rounded-md border px-3 py-2 text-xs alert-warning"
	role="status"
>
	<WifiOff size={14} strokeWidth={2} class="shrink-0" />
	<span>You're offline — reconnect to send. Your message is kept here.</span>
</div>
