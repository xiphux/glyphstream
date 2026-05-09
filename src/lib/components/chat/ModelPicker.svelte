<script lang="ts">
	import type { ModelEntry, ModelKind } from '$lib/types/api';

	interface Props {
		models: ModelEntry[];
		filterKinds?: readonly ModelKind[];
		value?: string;
		onChange?: (id: string) => void;
		disabled?: boolean;
	}
	let { models, filterKinds, value = $bindable(''), onChange, disabled = false }: Props = $props();

	const visible = $derived.by(() => {
		if (!filterKinds) return models;
		const set = new Set(filterKinds);
		return models.filter((m) => set.has(m.kind));
	});

	const groups = $derived.by(() => {
		const by = new Map<string, ModelEntry[]>();
		for (const m of visible) {
			const list = by.get(m.endpointId);
			if (list) list.push(m);
			else by.set(m.endpointId, [m]);
		}
		return [...by.entries()].map(([endpointId, items]) => ({
			endpointId,
			items: items.sort((a, b) => a.displayName.localeCompare(b.displayName))
		}));
	});
</script>

<select
	bind:value
	{disabled}
	onchange={() => onChange?.(value)}
	class="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm shadow-sm transition focus:border-neutral-400 focus:outline-none disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
>
	<option value="" disabled>Choose a model…</option>
	{#each groups as g (g.endpointId)}
		<optgroup label={g.endpointId}>
			{#each g.items as m (m.id)}
				<option value={m.id}>
					{m.displayName}{m.kindKnown ? '' : ' ·'}
				</option>
			{/each}
		</optgroup>
	{/each}
</select>
