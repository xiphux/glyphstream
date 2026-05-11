<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
	import type {
		CreateCustomModelRequest,
		CustomModel,
		CustomModelParameters,
		ModelEntry
	} from '$lib/types/api';

	let { data } = $props<{
		data: { customModels: CustomModel[]; models: ModelEntry[]; modelsError: string | null };
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
	let busy = $state(false);
	let error = $state<string | null>(null);
	let deletingId = $state<string | null>(null);

	function resetForm() {
		editingId = null;
		name = '';
		description = '';
		baseModelComposite = '';
		systemPrompt = '';
		temperatureStr = '';
		topPStr = '';
		maxTokensStr = '';
		error = null;
	}

	function loadIntoForm(m: CustomModel) {
		editingId = m.id;
		name = m.name;
		description = m.description ?? '';
		baseModelComposite = `${m.baseEndpointId}::${m.baseModelId}`;
		systemPrompt = m.systemPrompt ?? '';
		temperatureStr = m.parameters?.temperature !== undefined ? String(m.parameters.temperature) : '';
		topPStr = m.parameters?.top_p !== undefined ? String(m.parameters.top_p) : '';
		maxTokensStr = m.parameters?.max_tokens !== undefined ? String(m.parameters.max_tokens) : '';
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

	async function save(e: Event) {
		e.preventDefault();
		if (busy) return;
		busy = true;
		error = null;
		try {
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
				parameters: buildParameters()
			};

			const url = editingId ? `/api/custom-models/${editingId}` : '/api/custom-models';
			const method = editingId ? 'PATCH' : 'POST';
			const res = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const j = await safeJson(res);
				throw new Error(j?.message ?? `Server returned ${res.status}`);
			}
			resetForm();
			await invalidateAll();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function deleteOne(m: CustomModel) {
		if (deletingId) return;
		if (!confirm(`Delete preset "${m.name}"? Existing chats won't be affected.`)) return;
		deletingId = m.id;
		try {
			const res = await fetch(`/api/custom-models/${m.id}`, { method: 'DELETE' });
			if (!res.ok && res.status !== 404) {
				const j = await safeJson(res);
				throw new Error(j?.message ?? `Server returned ${res.status}`);
			}
			if (editingId === m.id) resetForm();
			await invalidateAll();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			deletingId = null;
		}
	}

	async function safeJson(res: Response): Promise<{ message?: string } | null> {
		try {
			return await res.json();
		} catch {
			return null;
		}
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="flex shrink-0 items-center justify-between px-4 py-3">
		<div>
			<h1 class="text-lg font-semibold tracking-tight">Custom models</h1>
			<p class="text-xs text-neutral-500">
				Reusable presets — pick a base model, lock in a system prompt, optionally tune sampling.
			</p>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-4">
		<div class="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1fr_1fr]">
			<!-- List -->
			<section>
				<h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
					Your presets ({data.customModels.length})
				</h2>
				{#if data.customModels.length === 0}
					<p class="rounded-md border border-dashed border-neutral-300 px-3 py-4 text-sm text-neutral-500 dark:border-neutral-700">
						None yet — create one on the right.
					</p>
				{:else}
					<ul class="space-y-2">
						{#each data.customModels as m (m.id)}
							{@const active = editingId === m.id}
							<li
								class="group rounded-lg border p-3 transition {active
									? 'border-neutral-900 bg-neutral-50 dark:border-neutral-100 dark:bg-neutral-900'
									: 'border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600'}"
							>
								<div class="flex items-start justify-between gap-2">
									<button
										type="button"
										onclick={() => loadIntoForm(m)}
										class="flex-1 text-left"
									>
										<div class="text-sm font-medium">{m.name}</div>
										{#if m.description}
											<div class="mt-0.5 text-xs text-neutral-500 line-clamp-2">{m.description}</div>
										{/if}
										<div class="mt-1 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-wide text-neutral-500">
											<span class="rounded bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-800">
												{m.baseEndpointId}::{m.baseModelId}
											</span>
											{#if m.parameters?.temperature !== undefined}
												<span class="rounded bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-800">
													temp {m.parameters.temperature}
												</span>
											{/if}
											{#if m.parameters?.top_p !== undefined}
												<span class="rounded bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-800">
													top_p {m.parameters.top_p}
												</span>
											{/if}
											{#if m.parameters?.max_tokens !== undefined}
												<span class="rounded bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-800">
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
										class="rounded p-1 text-xs text-neutral-500 opacity-0 transition group-hover:opacity-100 hover:bg-neutral-200 hover:text-red-700 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-red-400"
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
					<h2 class="text-xs font-semibold uppercase tracking-wide text-neutral-500">
						{editingId ? 'Edit preset' : 'New preset'}
					</h2>
					{#if editingId}
						<button
							type="button"
							onclick={resetForm}
							class="text-xs text-neutral-500 underline hover:text-neutral-700 dark:hover:text-neutral-300"
						>
							Clear (new)
						</button>
					{/if}
				</div>

				{#if data.modelsError}
					<div class="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
						Model list unavailable: {data.modelsError}
					</div>
				{/if}

				<form onsubmit={save} class="space-y-3 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
					<div>
						<label class="mb-1 block text-xs font-medium" for="name">Name</label>
						<input
							id="name"
							bind:value={name}
							required
							maxlength={200}
							placeholder="e.g. Coding Assistant"
							disabled={busy}
							class="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-base shadow-sm focus:border-neutral-400 focus:outline-none disabled:opacity-50 sm:text-sm dark:border-neutral-700 dark:bg-neutral-900"
						/>
					</div>

					<div>
						<label class="mb-1 block text-xs font-medium" for="description">
							Description <span class="font-normal text-neutral-500">(optional)</span>
						</label>
						<input
							id="description"
							bind:value={description}
							placeholder="What's this preset for?"
							disabled={busy}
							class="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-base shadow-sm focus:border-neutral-400 focus:outline-none disabled:opacity-50 sm:text-sm dark:border-neutral-700 dark:bg-neutral-900"
						/>
					</div>

					<div>
						<label class="mb-1 block text-xs font-medium" for="base-model">Base model</label>
						<ModelPicker
							models={data.models}
							bind:value={baseModelComposite}
							disabled={busy}
						/>
					</div>

					<div>
						<label class="mb-1 block text-xs font-medium" for="system-prompt">
							System prompt <span class="font-normal text-neutral-500">(optional)</span>
						</label>
						<textarea
							id="system-prompt"
							bind:value={systemPrompt}
							rows="6"
							disabled={busy}
							placeholder="Always respond in concise bullet points…"
							class="w-full resize-y rounded-md border border-neutral-200 bg-white px-3 py-2 font-mono text-base shadow-sm focus:border-neutral-400 focus:outline-none disabled:opacity-50 sm:text-xs dark:border-neutral-700 dark:bg-neutral-900"
						></textarea>
					</div>

					<details class="rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800">
						<summary class="cursor-pointer text-xs font-medium text-neutral-700 dark:text-neutral-300">
							Sampling parameters (optional)
						</summary>
						<div class="mt-3 grid grid-cols-3 gap-2">
							<div>
								<label class="mb-1 block text-[10px] uppercase tracking-wide text-neutral-500" for="temp">
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
									class="w-full rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs shadow-sm focus:border-neutral-400 focus:outline-none disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
								/>
							</div>
							<div>
								<label class="mb-1 block text-[10px] uppercase tracking-wide text-neutral-500" for="topp">
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
									class="w-full rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs shadow-sm focus:border-neutral-400 focus:outline-none disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
								/>
							</div>
							<div>
								<label class="mb-1 block text-[10px] uppercase tracking-wide text-neutral-500" for="maxtok">
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
									class="w-full rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs shadow-sm focus:border-neutral-400 focus:outline-none disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
								/>
							</div>
						</div>
					</details>

					{#if error}
						<div class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
							{error}
						</div>
					{/if}

					<div class="flex justify-end gap-2">
						{#if editingId}
							<button
								type="button"
								onclick={resetForm}
								disabled={busy}
								class="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
							>
								Cancel
							</button>
						{/if}
						<button
							type="submit"
							disabled={busy || !name.trim() || !baseModelComposite}
							class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
						>
							{busy ? 'Saving…' : editingId ? 'Save changes' : 'Create preset'}
						</button>
					</div>
				</form>
			</section>
		</div>
	</div>
</div>
