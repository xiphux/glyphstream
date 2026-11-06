<!--
	Where a character chat changes scene (`#lib/scenes.ts`): a line across the
	thread naming the scene it moves into, like the "checked in" divider. Drawn
	wherever a marker is — above a user message the composer's switch put one
	on, or mid-reply where the model wrote one.
-->
<script lang="ts">
	import type { Scene } from '#lib/types/api.js';

	let { scene }: { scene: Scene } = $props();
</script>

<div
	role="separator"
	class="my-1 flex w-full items-center gap-3 text-[11px] font-medium tracking-wide text-fg-muted"
>
	<span class="h-px flex-1 bg-border" aria-hidden="true"></span>
	<span>{scene === 'in_person' ? 'In person' : 'Texting'}</span>
	<span class="h-px flex-1 bg-border" aria-hidden="true"></span>
</div>
