<script lang="ts">
	/**
	 * Mounts the new-chat page (`(app)/+page.svelte`) with the model catalogue
	 * its composer reads out of context. The real provider is the `(app)`
	 * layout — context flows down, so a test that renders the page on its own
	 * gets `undefined` back from `getModelCatalogue()` and crashes on first use.
	 */
	import { ModelCatalogue, setModelCatalogue } from '$lib/model-catalogue.svelte';
	import type { ModelEntry } from '$lib/types/api';
	import NewChatPage from '../../../src/routes/(app)/+page.svelte';

	let { data }: { data: { models: ModelEntry[] } & Record<string, unknown> } = $props();

	setModelCatalogue(new ModelCatalogue(() => data.models));
</script>

<NewChatPage data={data as never} />
