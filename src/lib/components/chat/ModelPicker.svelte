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

	/**
	 * Group models by endpointId. When an endpoint exposes models from
	 * multiple distinct `ownedBy` values (the typical bridge case where one
	 * endpoint fronts ComfyUI + Venice + llama-server), prefix each option
	 * label with the owner so otherwise-identical model names stay
	 * distinguishable. When there's only one owner inside an endpoint we
	 * skip the prefix to keep the UI tidy.
	 */
	const groups = $derived.by(() => {
		const by = new Map<string, ModelEntry[]>();
		for (const m of visible) {
			const list = by.get(m.endpointId);
			if (list) list.push(m);
			else by.set(m.endpointId, [m]);
		}
		return [...by.entries()].map(([endpointId, items]) => {
			const distinctOwners = new Set(items.map((m) => m.ownedBy).filter((o): o is string => !!o));
			const showOwner = distinctOwners.size > 1;
			return {
				endpointId,
				items: items
					.map((m) => ({
						entry: m,
						label:
							showOwner && m.ownedBy ? `${m.ownedBy} · ${m.displayName}` : m.displayName
					}))
					.sort((a, b) => a.label.localeCompare(b.label))
			};
		});
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
			{#each g.items as item (item.entry.id)}
				<option value={item.entry.id}>
					{item.label}{item.entry.kindKnown ? '' : ' ·'}
				</option>
			{/each}
		</optgroup>
	{/each}
</select>
