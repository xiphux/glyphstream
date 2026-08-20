<script lang="ts">
	import SettingsPage from '$lib/components/settings/SettingsPage.svelte';
	import { invalidateAll } from '$app/navigation';
	import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
	import { ImagePlus } from '@lucide/svelte';
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
	// Avatar edits are staged, not applied on pick: everything else in this form
	// commits on Save, and a portrait that silently persisted the moment it was
	// chosen — surviving "Clear (new)" — would be the odd one out.
	// `avatarMediaId` is what's saved on the row; `avatarFile` is a pending
	// upload; `avatarCleared` is a pending removal. The last two are mutually
	// exclusive by construction (each setter clears the other).
	let avatarMediaId = $state<string | null>(null);
	let avatarFile = $state<File | null>(null);
	let avatarObjectUrl = $state<string | null>(null);
	let avatarCleared = $state(false);
	let busy = $state(false);
	let avatarInput = $state<HTMLInputElement | null>(null);
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
		setAvatarFile(null);
		avatarMediaId = null;
		avatarCleared = false;
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
		setAvatarFile(null);
		avatarMediaId = m.avatarMediaId;
		avatarCleared = false;
		error = null;
	}

	/** Swap the pending avatar file, revoking the previous preview's object URL.
	 *  Done here rather than in an $effect because it's a resource whose
	 *  lifetime is exactly this assignment — an effect would only add a second
	 *  place for the revoke to be missed. */
	function setAvatarFile(file: File | null): void {
		if (avatarObjectUrl) URL.revokeObjectURL(avatarObjectUrl);
		avatarObjectUrl = file ? URL.createObjectURL(file) : null;
		avatarFile = file;
	}

	function onAvatarPicked(e: Event): void {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0] ?? null;
		// Reset the input so re-picking the SAME file after a failed save still
		// fires a change event.
		input.value = '';
		if (!file) return;
		if (!file.type.startsWith('image/')) {
			error = 'An avatar must be an image';
			return;
		}
		error = null;
		avatarCleared = false;
		setAvatarFile(file);
	}

	function clearAvatar(): void {
		setAvatarFile(null);
		// Only a saved avatar needs a removal staged; discarding an unsaved pick
		// just leaves whatever was already on the row.
		avatarCleared = avatarMediaId !== null;
	}

	/** The image to show in the form right now: a pending pick wins, then the
	 *  saved avatar unless removal is staged. */
	const avatarPreviewSrc = $derived(
		avatarObjectUrl ??
			(avatarMediaId && !avatarCleared ? `/api/media/${avatarMediaId}/thumbnail` : null),
	);

	/**
	 * Apply any staged avatar change to `id`. Runs AFTER the preset itself is
	 * saved, because both paths need an id to attach to — including create,
	 * where the id doesn't exist until the POST returns.
	 *
	 * Upload first, then link: /api/uploads owns the size/content-type rules, so
	 * this doesn't restate them, and an upload abandoned between the two calls
	 * is reaped by the purger's grace period rather than leaking.
	 */
	async function saveAvatar(id: string): Promise<void> {
		if (avatarFile) {
			const form = new FormData();
			form.append('file', avatarFile);
			const up = await fetch('/api/uploads', { method: 'POST', body: form });
			if (!up.ok) throw new Error(await errorMessageFromResponse(up));
			const { id: mediaId } = (await up.json()) as { id: string };
			const res = await fetch(`/api/custom-models/${id}/avatar`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mediaId }),
			});
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
		} else if (avatarCleared) {
			const res = await fetch(`/api/custom-models/${id}/avatar`, { method: 'DELETE' });
			if (!res.ok && res.status !== 404) throw new Error(await errorMessageFromResponse(res));
		}
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
				// The avatar rides a separate endpoint and needs the preset's id, so
				// it lands after this. On edit we already hold that id; only create
				// has to read it back off the response, where it first exists. A
				// failure here leaves the preset saved and the avatar not — the form
				// is left intact so the user can retry rather than losing the pick.
				const savedId =
					editingId ?? ((await res.json()) as { customModel: CustomModel }).customModel.id;
				try {
					await saveAvatar(savedId);
				} catch (e) {
					// The preset itself is already saved. Flip the form into edit mode
					// before rethrowing so a retry PATCHes that row instead of POSTing a
					// second one — nothing enforces name uniqueness (see the index note
					// on `custom_models` in schema.ts), and with `invalidateAll` skipped
					// below the list doesn't show the first one either, so a duplicate
					// looks like the retry working.
					editingId = savedId;
					throw e;
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

<SettingsPage title="Custom models">
	{#snippet description()}
		Reusable presets — pick a base model, lock in a system prompt, optionally tune sampling.
	{/snippet}

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
								<button
									type="button"
									onclick={() => loadIntoForm(m)}
									class="flex flex-1 gap-2.5 text-left"
								>
									{#if m.avatarMediaId}
										<img
											src="/api/media/{m.avatarMediaId}/thumbnail"
											alt=""
											loading="lazy"
											class="mt-0.5 size-8 shrink-0 rounded-full object-cover ring-1 ring-black/10 dark:ring-white/15"
										/>
									{/if}
									<span class="min-w-0 flex-1">
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
									</span>
								</button>
								<button
									type="button"
									onclick={() => deleteOne(m)}
									disabled={deletingId === m.id}
									title="Delete preset"
									aria-label="Delete preset {m.name}"
									class="rounded p-1 text-xs text-fg-muted transition can-hover:opacity-0 group-hover:opacity-100 hover:bg-surface-sunken hover:text-danger focus-visible:opacity-100 disabled:opacity-50"
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

			<form onsubmit={save} class="panel-card space-y-3 p-4">
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
					<span class="mb-1 block text-xs font-medium">
						Avatar <span class="font-normal text-fg-muted">(optional)</span>
					</span>
					<div class="flex items-center gap-3">
						{#if avatarPreviewSrc}
							<img
								src={avatarPreviewSrc}
								alt="Avatar preview"
								class="size-12 shrink-0 rounded-full object-cover ring-1 ring-black/10 dark:ring-white/15"
							/>
						{:else}
							<div
								class="flex size-12 shrink-0 items-center justify-center rounded-full border border-dashed border-border-strong text-fg-muted"
							>
								<ImagePlus size={16} strokeWidth={2} />
							</div>
						{/if}
						<div class="flex flex-wrap items-center gap-2">
							<button
								type="button"
								disabled={busy}
								onclick={() => avatarInput?.click()}
								class="rounded-md border border-border px-3 py-1.5 text-xs transition hover:bg-surface-sunken disabled:opacity-50"
							>
								{avatarPreviewSrc ? 'Replace' : 'Choose image'}
							</button>
							{#if avatarPreviewSrc}
								<button
									type="button"
									disabled={busy}
									onclick={clearAvatar}
									class="rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition hover:bg-surface-sunken hover:text-danger disabled:opacity-50"
								>
									Remove
								</button>
							{/if}
							{#if avatarFile || avatarCleared}
								<span class="text-[11px] text-fg-muted">Applied when you save</span>
							{/if}
						</div>
					</div>
					<input
						bind:this={avatarInput}
						type="file"
						accept="image/*"
						class="hidden"
						onchange={onAvatarPicked}
					/>
					<p class="mt-1.5 text-[11px] text-fg-muted">
						Shown beside this preset's name above each of its replies.
					</p>
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
							preset's purpose makes one of the features irrelevant — e.g. a code-review preset that
							shouldn't pull in personal context.
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
</SettingsPage>
