<script lang="ts">
	/**
	 * Mounts the real chat page (`(app)/chat/[id]/+page.svelte`) with the model
	 * catalogue it reads out of context, and keeps ONE instance alive while
	 * `data` is swapped — which is what SvelteKit does on a /chat/A -> /chat/B
	 * navigation (same route node, new `data`).
	 */
	import { ModelCatalogue, setModelCatalogue } from '#lib/model-catalogue.svelte.js';
	import type { ModelEntry } from '#lib/types/api.js';
	import ChatPage from '../../../src/routes/(app)/chat/[id]/+page.svelte';

	let { data }: { data: { models: ModelEntry[] } & Record<string, unknown> } = $props();

	setModelCatalogue(new ModelCatalogue(() => data.models));
</script>

<ChatPage data={data as never} />
