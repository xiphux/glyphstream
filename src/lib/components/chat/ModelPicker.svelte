<script lang="ts">
	import type { CustomModel, ModelEntry, ModelKind } from '$lib/types/api';

	interface Props {
		models: ModelEntry[];
		/**
		 * Optional saved presets. Rendered as a "Your presets" optgroup at the
		 * top so the user can pick a preset and a base model from the same
		 * dropdown. Each preset's selected value is `custom::{customModelId}`
		 * so the consumer can branch on the prefix.
		 */
		customModels?: CustomModel[];
		filterKinds?: readonly ModelKind[];
		value?: string;
		onChange?: (id: string) => void;
		disabled?: boolean;
		/**
		 * "Inline" variant — renders as a borderless, compact dropdown that
		 * blends into a parent composer box (used by the new-chat page and
		 * the chat-page composer). Default is the bordered form-input variant.
		 */
		inline?: boolean;
	}
	let {
		models,
		customModels = [],
		filterKinds,
		value = $bindable(''),
		onChange,
		disabled = false,
		inline = false
	}: Props = $props();

	// Visual marker per kind. Chat is the default; we don't decorate it so
	// the picker stays quiet for the common case. Same convention as the
	// Open WebUI pipe used 📹 for video.
	function kindEmoji(kind: ModelKind): string {
		switch (kind) {
			case 'image':
				return ' 📷';
			case 'video':
				return ' 📹';
			case 'embedding':
				return ' 🔢';
			default:
				return '';
		}
	}

	const visible = $derived.by(() => {
		if (!filterKinds) return models;
		const set = new Set(filterKinds);
		return models.filter((m) => set.has(m.kind));
	});

	/**
	 * Filter custom models against the same kind filter, by looking up the
	 * preset's base model in `models` and using its kind. Presets whose base
	 * model isn't in the visible set (wrong kind, or endpoint removed from
	 * config) are hidden so the user can't pick something that won't dispatch.
	 */
	const visibleCustom = $derived.by(() => {
		if (customModels.length === 0) return [];
		const baseById = new Map(models.map((m) => [m.id, m] as const));
		return customModels
			.map((cm) => ({
				cm,
				base: baseById.get(`${cm.baseEndpointId}::${cm.baseModelId}`)
			}))
			.filter(({ base }) => {
				if (!base) return false;
				if (!filterKinds) return true;
				return (filterKinds as readonly ModelKind[]).includes(base.kind);
			});
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
					.map((m) => {
						const base =
							showOwner && m.ownedBy ? `${m.ownedBy} · ${m.displayName}` : m.displayName;
						return {
							entry: m,
							label: `${base}${kindEmoji(m.kind)}`
						};
					})
					.sort((a, b) => a.label.localeCompare(b.label))
			};
		});
	});
</script>

<select
	bind:value
	{disabled}
	onchange={() => onChange?.(value)}
	class={inline
		? 'cursor-pointer truncate rounded-md border-0 bg-transparent px-2 py-1 text-xs text-neutral-600 transition hover:bg-neutral-100 focus:outline-none disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800'
		: 'w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm shadow-sm transition focus:border-neutral-400 focus:outline-none disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900'}
>
	<option value="" disabled>Choose a model…</option>
	{#if visibleCustom.length > 0}
		<optgroup label="Your presets">
			{#each visibleCustom as { cm, base } (cm.id)}
				<option value="custom::{cm.id}">
					⚙ {cm.name}{base ? ` · ${base.displayName}${kindEmoji(base.kind)}` : ''}
				</option>
			{/each}
		</optgroup>
	{/if}
	{#each groups as g (g.endpointId)}
		<optgroup label={g.endpointId}>
			{#each g.items as item (item.entry.id)}
				<option value={item.entry.id}>
					{item.label}
				</option>
			{/each}
		</optgroup>
	{/each}
</select>
