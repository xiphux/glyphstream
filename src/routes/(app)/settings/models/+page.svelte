<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
	import { errorMessageFromResponse } from '$lib/fetch-error';
	import { confirmDialog } from '$lib/confirm.svelte';
	import {
		featureCategoryAppliesToModelKind,
		type CreateCustomModelRequest,
		type CustomModel,
		type CustomModelParameters,
		type FeatureCategory,
		type FeatureCategoryEntry,
		type ModelEntry,
	} from '$lib/types/api';

	let { data } = $props<{
		data: {
			customModels: CustomModel[];
			models: ModelEntry[];
			modelsError: string | null;
			featureCategories: FeatureCategoryEntry[];
		};
	}>();

	// Form state. `editingId` null = creating a new preset; non-null = editing.
	let editingId = $state<string | null>(null);
	let name = $state('');
	let description = $state('');
	let baseModelComposite = $state('');
	let systemPrompt = $state('');
	let temperatureStr = $state('');
	let topPStr = $state('');
	let maxTokensStr = $state('');
	let defaultDisabledFeatures = $state<FeatureCategory[]>([]);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let deletingId = $state<string | null>(null);

	// Show only the toggles the composer will actually offer for this preset's base
	// model — same rule as FeatureTogglesMenu. No base model picked yet → unknown
	// kind → show everything.
	const baseKind = $derived(
		data.models.find((m: ModelEntry) => m.id === baseModelComposite)?.kind ?? null,
	);
	const visibleFeatureCategories = $derived(
		data.featureCategories.filter((c: FeatureCategoryEntry) =>
			featureCategoryAppliesToModelKind(c.id, baseKind),
		),
	);

	function isFeatureDefaultOn(cat: FeatureCategory): boolean {
		return !defaultDisabledFeatures.includes(cat);
	}

	function setFeatureDefault(cat: FeatureCategory, on: boolean): void {
		if (on) {
			defaultDisabledFeatures = defaultDisabledFeatures.filter((c) => c !== cat);
		} else if (!defaultDisabledFeatures.includes(cat)) {
			defaultDisabledFeatures = [...defaultDisabledFeatures, cat];
		}
	}

	function resetForm() {
		editingId = null;
		name = '';
		description = '';
		baseModelComposite = '';
		systemPrompt = '';
		temperatureStr = '';
		topPStr = '';
		maxTokensStr = '';
		defaultDisabledFeatures = [];
		error = null;
	}

	function loadIntoForm(m: CustomModel) {
		editingId = m.id;
		name = m.name;
		description = m.description ?? '';
		baseModelComposite = `${m.baseEndpointId}::${m.baseModelId}`;
		systemPrompt = m.systemPrompt ?? '';
		temperatureStr =
			m.parameters?.temperature !== undefined ? String(m.parameters.temperature) : '';
		topPStr = m.parameters?.top_p !== undefined ? String(m.parameters.top_p) : '';
		maxTokensStr = m.parameters?.max_tokens !== undefined ? String(m.parameters.max_tokens) : '';
		defaultDisabledFeatures = [...m.defaultDisabledFeatures];
		error = null;
	}

	function buildParameters(): CustomModelParameters | undefined {
		const params: CustomModelParameters = {};
		if (temperatureStr.trim()) {
			const v = Number(temperatureStr);
			if (!Number.isFinite(v) || v < 0 || v > 2) {
				throw new Error('Temperature must be a number between 0 and 2');
			}
			params.temperature = v;
		}
		if (topPStr.trim()) {
			const v = Number(topPStr);
			if (!Number.isFinite(v) || v < 0 || v > 1) {
				throw new Error('Top-p must be a number between 0 and 1');
			}
			params.top_p = v;
		}
		if (maxTokensStr.trim()) {
			const v = Number(maxTokensStr);
			if (!Number.isInteger(v) || v < 1) {
				throw new Error('Max tokens must be a positive integer');
			}
			params.max_tokens = v;
		}
		return Object.keys(params).length > 0 ? params : undefined;
	}

	/**
	 * Run a CRUD action while a busy flag is held, surfacing any thrown
	 * error through the page-level `error` slot. The `setBusy` setter is
	 * a closure so callers can use either a boolean flag (save) or a
	 * string id flag (delete: which row is in flight).
	 */
	async function withBusy(
		setBusy: (busy: boolean) => void,
		action: () => Promise<void>,
	): Promise<void> {
		setBusy(true);
		error = null;
		try {
			await action();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			setBusy(false);
		}
	}

	async function save(e: Event) {
		e.preventDefault();
		if (busy) return;
		await withBusy(
			(b) => (busy = b),
			async () => {
				if (!name.trim()) throw new Error('Name is required');
				if (!baseModelComposite) throw new Error('Pick a base model');
				const sep = baseModelComposite.indexOf('::');
				if (sep < 0) throw new Error('Malformed base model id');
				const baseEndpointId = baseModelComposite.slice(0, sep);
				const baseModelId = baseModelComposite.slice(sep + 2);

				const body: CreateCustomModelRequest = {
					name: name.trim(),
					description: description.trim() || undefined,
					baseEndpointId,
					baseModelId,
					systemPrompt: systemPrompt.trim() || undefined,
					parameters: buildParameters(),
					defaultDisabledFeatures: [...defaultDisabledFeatures],
				};

				const url = editingId ? `/api/custom-models/${editingId}` : '/api/custom-models';
				const method = editingId ? 'PATCH' : 'POST';
				const res = await fetch(url, {
					method,
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				});
				if (!res.ok) {
					throw new Error(await errorMessageFromResponse(res));
				}
				resetForm();
				await invalidateAll();
			},
		);
	}

	async function deleteOne(m: CustomModel) {
		if (deletingId) return;
		const ok = await confirmDialog.ask({
			title: `Delete preset "${m.name}"?`,
			message: "Existing chats won't be affected.",
		});
		if (!ok) return;
		await withBusy(
			(b) => (deletingId = b ? m.id : null),
			async () => {
				const res = await fetch(`/api/custom-models/${m.id}`, { method: 'DELETE' });
				if (!res.ok && res.status !== 404) {
					throw new Error(await errorMessageFromResponse(res));
				}
				if (editingId === m.id) resetForm();
				await invalidateAll();
			},
		);
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="flex shrink-0 items-center justify-between px-4 py-3">
		<div>
			<h1 class="text-lg font-semibold tracking-tight">Custom models</h1>
			<p class="text-xs text-fg-muted">
				Reusable presets — pick a base model, lock in a system prompt, optionally tune sampling.
			</p>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-4">
		<div class="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1fr_1fr]">
			<!-- List -->
			<section>
				<h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-fg-muted">
					Your presets ({data.customModels.length})
				</h2>
				{#if data.customModels.length === 0}
					<p
						class="rounded-md border border-dashed border-border-strong px-3 py-4 text-sm text-fg-muted"
					>
						None yet — create one on the right.
					</p>
				{:else}
					<ul class="space-y-2">
						{#each data.customModels as m (m.id)}
							{@const active = editingId === m.id}
							<li
								class="group rounded-lg border p-3 transition {active
									? 'border-surface-inverse bg-surface'
									: 'border-border hover:border-border-focus'}"
							>
								<div class="flex items-start justify-between gap-2">
									<button type="button" onclick={() => loadIntoForm(m)} class="flex-1 text-left">
										<div class="text-sm font-medium">{m.name}</div>
										{#if m.description}
											<div class="mt-0.5 text-xs text-fg-muted line-clamp-2">{m.description}</div>
										{/if}
										<div
											class="mt-1 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-wide text-fg-muted"
										>
											<span class="rounded bg-surface-sunken px-1.5 py-0.5">
												{m.baseEndpointId}::{m.baseModelId}
											</span>
											{#if m.parameters?.temperature !== undefined}
												<span class="rounded bg-surface-sunken px-1.5 py-0.5">
													temp {m.parameters.temperature}
												</span>
											{/if}
											{#if m.parameters?.top_p !== undefined}
												<span class="rounded bg-surface-sunken px-1.5 py-0.5">
													top_p {m.parameters.top_p}
												</span>
											{/if}
											{#if m.parameters?.max_tokens !== undefined}
												<span class="rounded bg-surface-sunken px-1.5 py-0.5">
													max {m.parameters.max_tokens}
												</span>
											{/if}
										</div>
									</button>
									<button
										type="button"
										onclick={() => deleteOne(m)}
										disabled={deletingId === m.id}
										title="Delete preset"
										aria-label="Delete preset {m.name}"
										class="rounded p-1 text-xs text-fg-muted opacity-0 transition group-hover:opacity-100 hover:bg-surface-sunken hover:text-danger disabled:opacity-50"
									>
										{deletingId === m.id ? '…' : '×'}
									</button>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<!-- Form -->
			<section>
				<div class="mb-3 flex items-center justify-between">
					<h2 class="text-xs font-semibold uppercase tracking-wide text-fg-muted">
						{editingId ? 'Edit preset' : 'New preset'}
					</h2>
					{#if editingId}
						<button
							type="button"
							onclick={resetForm}
							class="text-xs text-fg-muted underline hover:text-fg-secondary"
						>
							Clear (new)
						</button>
					{/if}
				</div>

				{#if data.modelsError}
					<div class="mb-3 rounded-md border px-3 py-2 text-xs alert-warning">
						Model list unavailable: {data.modelsError}
					</div>
				{/if}

				<form
					onsubmit={save}
					class="space-y-3 rounded-lg border border-border bg-surface-panel p-4"
				>
					<div>
						<label class="mb-1 block text-xs font-medium" for="name">Name</label>
						<input
							id="name"
							bind:value={name}
							required
							maxlength={200}
							placeholder="e.g. Coding Assistant"
							disabled={busy}
							class="w-full rounded-md border border-border bg-surface-panel px-3 py-2 text-base shadow-sm focus:border-border-focus focus:outline-none disabled:opacity-50 sm:text-sm"
						/>
					</div>

					<div>
						<label class="mb-1 block text-xs font-medium" for="description">
							Description <span class="font-normal text-fg-muted">(optional)</span>
						</label>
						<input
							id="description"
							bind:value={description}
							placeholder="What's this preset for?"
							disabled={busy}
							class="w-full rounded-md border border-border bg-surface-panel px-3 py-2 text-base shadow-sm focus:border-border-focus focus:outline-none disabled:opacity-50 sm:text-sm"
						/>
					</div>

					<div>
						<label class="mb-1 block text-xs font-medium" for="base-model">Base model</label>
						<ModelPicker models={data.models} bind:value={baseModelComposite} disabled={busy} />
					</div>

					<div>
						<label class="mb-1 block text-xs font-medium" for="system-prompt">
							System prompt <span class="font-normal text-fg-muted">(optional)</span>
						</label>
						<textarea
							id="system-prompt"
							bind:value={systemPrompt}
							rows="6"
							disabled={busy}
							placeholder="Always respond in concise bullet points…"
							class="w-full resize-y rounded-md border border-border bg-surface-panel px-3 py-2 font-mono text-base shadow-sm focus:border-border-focus focus:outline-none disabled:opacity-50 sm:text-xs"
						></textarea>
					</div>

					<details class="rounded-md border border-border px-3 py-2">
						<summary class="cursor-pointer text-xs font-medium text-fg-secondary">
							Sampling parameters (optional)
						</summary>
						<div class="mt-3 grid grid-cols-3 gap-2">
							<div>
								<label
									class="mb-1 block text-[10px] uppercase tracking-wide text-fg-muted"
									for="temp"
								>
									Temperature
								</label>
								<input
									id="temp"
									bind:value={temperatureStr}
									type="number"
									min="0"
									max="2"
									step="0.05"
									placeholder="0.7"
									disabled={busy}
									class="w-full rounded-md border border-border bg-surface-panel px-2 py-1 text-xs shadow-sm focus:border-border-focus focus:outline-none disabled:opacity-50"
								/>
							</div>
							<div>
								<label
									class="mb-1 block text-[10px] uppercase tracking-wide text-fg-muted"
									for="topp"
								>
									Top-p
								</label>
								<input
									id="topp"
									bind:value={topPStr}
									type="number"
									min="0"
									max="1"
									step="0.05"
									placeholder="0.95"
									disabled={busy}
									class="w-full rounded-md border border-border bg-surface-panel px-2 py-1 text-xs shadow-sm focus:border-border-focus focus:outline-none disabled:opacity-50"
								/>
							</div>
							<div>
								<label
									class="mb-1 block text-[10px] uppercase tracking-wide text-fg-muted"
									for="maxtok"
								>
									Max tokens
								</label>
								<input
									id="maxtok"
									bind:value={maxTokensStr}
									type="number"
									min="1"
									step="1"
									placeholder="2048"
									disabled={busy}
									class="w-full rounded-md border border-border bg-surface-panel px-2 py-1 text-xs shadow-sm focus:border-border-focus focus:outline-none disabled:opacity-50"
								/>
							</div>
						</div>
					</details>

					{#if visibleFeatureCategories.length > 0}
						<details class="rounded-md border border-border px-3 py-2">
							<summary class="cursor-pointer text-xs font-medium text-fg-secondary">
								Default feature toggles (optional)
							</summary>
							<p class="mt-2 text-[11px] text-fg-muted">
								Sets the starting state of the per-conversation feature toggles when this preset is
								selected. The user can still flip individual toggles before sending. Useful when a
								preset's purpose makes one of the features irrelevant — e.g. a code-review preset
								that shouldn't pull in personal context.
							</p>
							<div class="mt-3 flex flex-col gap-2">
								{#each visibleFeatureCategories as cat (cat.id)}
									<label class="flex cursor-pointer items-start gap-2 text-xs">
										<input
											type="checkbox"
											checked={isFeatureDefaultOn(cat.id)}
											onchange={(e) => setFeatureDefault(cat.id, e.currentTarget.checked)}
											disabled={busy}
											class="mt-0.5 h-3.5 w-3.5 rounded border-border accent-surface-inverse disabled:opacity-50"
										/>
										<span class="min-w-0">
											<span class="font-medium">{cat.label}</span>
											<span class="ml-1 text-fg-muted">on by default</span>
										</span>
									</label>
								{/each}
							</div>
						</details>
					{/if}

					{#if error}
						<div class="rounded-md border px-3 py-2 text-sm alert-danger">
							{error}
						</div>
					{/if}

					<div class="flex justify-end gap-2">
						{#if editingId}
							<button
								type="button"
								onclick={resetForm}
								disabled={busy}
								class="rounded-md border border-border-strong bg-surface-panel px-4 py-2 text-sm transition hover:bg-surface-raised disabled:opacity-50"
							>
								Cancel
							</button>
						{/if}
						<button
							type="submit"
							disabled={busy || !name.trim() || !baseModelComposite}
							class="rounded-md bg-surface-inverse px-4 py-2 text-sm font-medium text-fg-inverse transition hover:opacity-90 disabled:opacity-50"
						>
							{busy ? 'Saving…' : editingId ? 'Save changes' : 'Create preset'}
						</button>
					</div>
				</form>
			</section>
		</div>
	</div>
</div>
