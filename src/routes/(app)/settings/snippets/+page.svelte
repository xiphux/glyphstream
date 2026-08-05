<script lang="ts">
	import SettingsPage from '$lib/components/settings/SettingsPage.svelte';
	import { invalidateAll } from '$app/navigation';
	import { Trash2, Upload, Download, Pencil, Plus, X } from '@lucide/svelte';
	import { SNIPPET_KINDS, type PromptSnippet, type SnippetKind } from '$lib/types/api';
	import { SNIPPET_TRIGGER, snippetAppliesToKind } from '$lib/prompt-snippet-trigger';
	import { invalidateSnippets } from '$lib/prompt-snippets.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { toast } from '$lib/toast.svelte';

	let { data } = $props<{ data: { promptSnippets: PromptSnippet[] } }>();

	let busy = $state(false);
	let busyId = $state<string | null>(null);
	let filter = $state('');
	/** Modality quick-filter; null is "all". */
	let kindFilter = $state<SnippetKind | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	let pasteText = $state('');
	let overwrite = $state(false);

	// Editor state. `editing` is null when the form is closed, '' when creating
	// a new snippet, or the id of the snippet being edited.
	let editing = $state<string | null>(null);
	let formName = $state('');
	let formBody = $state('');
	let formKinds = $state<SnippetKind[]>([]);
	let formTags = $state('');

	const filtered = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		return data.promptSnippets.filter((s: PromptSnippet) => {
			if (!snippetAppliesToKind(s, kindFilter)) return false;
			if (!q) return true;
			return (
				s.name.toLowerCase().includes(q) ||
				s.tags.some((t) => t.toLowerCase().includes(q)) ||
				s.body.toLowerCase().includes(q)
			);
		});
	});

	/**
	 * Counts for the modality chips, computed once per data change rather than
	 * per chip render.
	 *
	 * These deliberately do NOT partition the library: a snippet declaring both
	 * `image` and `video` is counted under each, and a generic one (no kinds)
	 * under all of them — because the question the chip answers is "what would
	 * I be offered on this kind of model?", not "which bucket does this live
	 * in". So the per-kind counts can exceed the total, which is correct.
	 */
	const kindCounts = $derived.by(() => {
		const counts = new Map<SnippetKind, number>(SNIPPET_KINDS.map((k) => [k, 0]));
		for (const s of data.promptSnippets as PromptSnippet[]) {
			for (const k of SNIPPET_KINDS) {
				if (snippetAppliesToKind(s, k)) counts.set(k, counts.get(k)! + 1);
			}
		}
		return counts;
	});

	/** Pull SvelteKit's `{ message }` error body, falling back to the status. */
	async function errorMessage(res: Response): Promise<string> {
		try {
			const body = await res.json();
			if (body && typeof body.message === 'string') return body.message;
		} catch {
			/* non-JSON body */
		}
		return `HTTP ${res.status}`;
	}

	/** Reload the page data AND drop the composer's client-side cache, so an
	 *  edit here is reflected in the autocomplete without a full reload. */
	async function refresh() {
		invalidateSnippets();
		await invalidateAll();
	}

	function openCreate() {
		editing = '';
		formName = '';
		formBody = '';
		formKinds = [];
		formTags = '';
	}

	function openEdit(s: PromptSnippet) {
		editing = s.id;
		formName = s.name;
		formBody = s.body;
		formKinds = [...s.kinds];
		formTags = s.tags.join(', ');
	}

	function toggleKind(k: SnippetKind) {
		formKinds = formKinds.includes(k) ? formKinds.filter((x) => x !== k) : [...formKinds, k];
	}

	async function save() {
		if (busy || !formName.trim() || !formBody.trim()) return;
		busy = true;
		const payload = {
			name: formName.trim(),
			body: formBody.trim(),
			kinds: formKinds,
			tags: formTags
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean),
		};
		try {
			const res = editing
				? await fetch(`/api/user/prompt-snippets/${encodeURIComponent(editing)}`, {
						method: 'PATCH',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(payload),
					})
				: await fetch('/api/user/prompt-snippets', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(payload),
					});
			if (!res.ok) throw new Error(await errorMessage(res));
			editing = null;
			await refresh();
		} catch (e) {
			toast.error(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busy = false;
		}
	}

	async function requestDelete(s: PromptSnippet) {
		if (busyId) return;
		const ok = await confirmDialog.ask({
			title: `Delete "${s.name}"?`,
			message: 'This removes the snippet from your library. This cannot be undone.',
			confirmLabel: 'Delete',
		});
		if (!ok) return;
		busyId = s.id;
		try {
			const res = await fetch(`/api/user/prompt-snippets/${encodeURIComponent(s.id)}`, {
				method: 'DELETE',
			});
			if (!res.ok && res.status !== 404) throw new Error(await errorMessage(res));
			await refresh();
		} catch (e) {
			toast.error(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busyId = null;
		}
	}

	/** Report what the import actually did — counts and reasons, not a bare
	 *  "done", since a 100-entry import that silently skipped 40 would
	 *  otherwise look like a success.
	 *
	 *  Returns whether anything actually landed, which is what the paste box
	 *  keys its clear-on-success off. A rejected import can still answer 200
	 *  (the "nothing parsed, but here's why" case), so clearing on `res.ok`
	 *  would delete the very text the user needs to correct and retry. */
	async function afterImport(res: Response): Promise<boolean> {
		if (!res.ok) {
			toast.error(`Import failed: ${await errorMessage(res)}`);
			return false;
		}
		const body = (await res.json()) as {
			imported: number;
			updated: number;
			skipped: string[];
			warnings: string[];
		};
		const parts = [`Imported ${body.imported}`];
		if (body.updated > 0) parts.push(`updated ${body.updated}`);
		if (body.skipped.length > 0) parts.push(`skipped ${body.skipped.length}`);
		if (body.warnings.length > 0) parts.push(`${body.warnings.length} warning(s)`);
		const summary = parts.join(', ') + '.';

		// When NOTHING landed, the counts alone are useless — the reasons are the
		// answer. This is the systematically-malformed-library case (e.g. every
		// body written on its heading line), where the same reason repeats and
		// naming it once tells the user exactly what to change.
		const nothingLanded = body.imported === 0 && body.updated === 0;
		const reasons = [...body.skipped, ...body.warnings];
		if (nothingLanded && reasons.length > 0) {
			const shown = reasons.slice(0, 3).join('; ');
			const more = reasons.length > 3 ? ` (+${reasons.length - 3} more)` : '';
			toast.error(`${summary} ${shown}${more}`);
		} else {
			toast.success(summary);
		}
		if (body.skipped.length > 0) console.warn('Skipped snippets:', body.skipped);
		if (body.warnings.length > 0) console.warn('Import warnings:', body.warnings);
		await refresh();
		return !nothingLanded;
	}

	async function importPaste() {
		if (busy || pasteText.trim().length === 0) return;
		busy = true;
		try {
			const res = await fetch('/api/user/prompt-snippets/import', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: pasteText, overwrite }),
			});
			// Clear only when something actually landed. `res.ok` isn't the test:
			// a 200 can still mean "nothing imported, here's what's wrong", and
			// wiping the box there loses the library the user just hand-converted
			// — with no undo, since a programmatic assignment drops the native
			// undo stack.
			if (await afterImport(res)) pasteText = '';
		} catch (e) {
			toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busy = false;
		}
	}

	async function importFile(list: FileList | null) {
		if (busy || !list || list.length === 0) return;
		busy = true;
		try {
			const fd = new FormData();
			fd.append('file', list[0]);
			fd.append('overwrite', String(overwrite));
			const res = await fetch('/api/user/prompt-snippets/import', { method: 'POST', body: fd });
			await afterImport(res);
		} catch (e) {
			toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busy = false;
			if (fileInput) fileInput.value = '';
		}
	}

	const PLACEHOLDER = `## Akira Toriyama Style
kinds: image, video
tags: anime

clean and highly readable linework, appealing
character-focused design language…`;
</script>

<SettingsPage title="Prompt snippets">
	{#snippet description()}
		Reusable pieces of a prompt — a visual style, a tone instruction, a recurring character. Type <code
			>{SNIPPET_TRIGGER}</code
		> in the message box to insert one at the cursor, then keep typing around it. Several can be stacked
		in a single prompt.
	{/snippet}

	<div class="mx-auto flex max-w-2xl flex-col gap-4">
		<!-- Editor -->
		<section class="panel-card p-4">
			<!-- The bottom margin is what separates this header from the editor
			     form, so it only applies when that form is open. With the form
			     closed this row is the section's only child, and an
			     unconditional `mb-2` collapsed into nothing to separate — it
			     just added 8px under a row already sitting in 16px of padding,
			     which read as the header being off-centre in its own box. -->
			<div class="flex items-center justify-between {editing === null ? '' : 'mb-2'}">
				<h2 class="text-sm font-medium">
					{editing === null ? 'Your library' : editing ? 'Edit snippet' : 'New snippet'}
				</h2>
				{#if editing === null}
					<button
						type="button"
						onclick={openCreate}
						class="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition hover:opacity-90"
					>
						<Plus size={14} strokeWidth={2.25} /> New snippet
					</button>
				{:else}
					<button
						type="button"
						onclick={() => (editing = null)}
						aria-label="Close editor"
						class="flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent text-fg-muted transition hover:bg-surface-sunken"
					>
						<X size={14} strokeWidth={2.25} />
					</button>
				{/if}
			</div>

			{#if editing !== null}
				<div class="flex flex-col gap-3">
					<label class="flex flex-col gap-1">
						<span class="text-xs text-fg-muted">Name</span>
						<input
							bind:value={formName}
							maxlength="200"
							placeholder="Akira Toriyama Style"
							class="w-full rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm outline-none focus:border-accent"
						/>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs text-fg-muted">Body</span>
						<textarea
							bind:value={formBody}
							rows="6"
							placeholder="clean and highly readable linework, appealing character-focused design language…"
							class="w-full resize-y rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm outline-none focus:border-accent"
						></textarea>
					</label>
					<div class="flex flex-col gap-1">
						<span class="text-xs text-fg-muted">
							Applies to — leave all unchecked to offer it everywhere
						</span>
						<div class="flex flex-wrap gap-2">
							{#each SNIPPET_KINDS as k (k)}
								<label
									class="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs transition hover:bg-surface-sunken"
								>
									<input
										type="checkbox"
										checked={formKinds.includes(k)}
										onchange={() => toggleKind(k)}
									/>
									{k}
								</label>
							{/each}
						</div>
					</div>
					<label class="flex flex-col gap-1">
						<span class="text-xs text-fg-muted">Tags (comma-separated, searchable)</span>
						<input
							bind:value={formTags}
							placeholder="anime, character"
							class="w-full rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm outline-none focus:border-accent"
						/>
					</label>
					<div>
						<button
							type="button"
							disabled={busy || !formName.trim() || !formBody.trim()}
							onclick={save}
							class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition hover:opacity-90 disabled:opacity-50"
						>
							{editing ? 'Save changes' : 'Create snippet'}
						</button>
					</div>
				</div>
			{/if}
		</section>

		<!-- List -->
		<section class="panel-card p-4">
			{#if data.promptSnippets.length === 0}
				<p class="py-8 text-center text-sm text-fg-muted">
					No snippets yet. Create one above, or import a library below.
				</p>
			{:else}
				<input
					bind:value={filter}
					placeholder="Filter {data.promptSnippets.length} snippets…"
					class="w-full rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm outline-none focus:border-accent"
				/>
				<!-- Modality quick-filter. With a large single-modality library
				     (hundreds of image styles) the text box alone can't answer
				     "what do I actually have for chat?" — the counts here do it
				     at a glance, before any clicking. -->
				<div class="mt-2 mb-3 flex flex-wrap items-center gap-1.5">
					<span class="text-xs text-fg-muted">Applies to</span>
					<button
						type="button"
						aria-pressed={kindFilter === null}
						onclick={() => (kindFilter = null)}
						class="rounded-md border px-2.5 py-1 text-xs transition {kindFilter === null
							? 'border-accent bg-accent text-on-accent'
							: 'border-border text-fg-muted hover:bg-surface-sunken'}"
					>
						All {data.promptSnippets.length}
					</button>
					{#each SNIPPET_KINDS as k (k)}
						<button
							type="button"
							aria-pressed={kindFilter === k}
							onclick={() => (kindFilter = kindFilter === k ? null : k)}
							class="rounded-md border px-2.5 py-1 text-xs transition {kindFilter === k
								? 'border-accent bg-accent text-on-accent'
								: 'border-border text-fg-muted hover:bg-surface-sunken'}"
						>
							{k}
							{kindCounts.get(k) ?? 0}
						</button>
					{/each}
				</div>
				{#if filtered.length === 0}
					<!-- Name the filter that actually emptied the list. "Nothing
					     matches ''" for a kind-only filter would read as a bug. -->
					<p class="py-6 text-center text-sm text-fg-muted">
						{#if filter.trim() && kindFilter}
							No {kindFilter} snippets match “{filter}”.
						{:else if kindFilter}
							No snippets apply to {kindFilter}.
						{:else}
							Nothing matches “{filter}”.
						{/if}
					</p>
				{:else}
					<ul class="flex flex-col gap-0.5">
						{#each filtered as s (s.id)}
							<li>
								<div
									class="flex items-start gap-3 rounded-md px-3 py-2.5 text-sm transition hover:bg-surface-sunken/70"
								>
									<div class="min-w-0 flex-1">
										<div class="flex flex-wrap items-center gap-1.5">
											<span class="font-medium">{s.name}</span>
											{#each s.kinds as k (k)}
												<span
													class="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-fg-muted"
													>{k}</span
												>
											{/each}
											{#if s.kinds.length === 0}
												<!-- No kinds means generic, and that's exactly what the
												     modality chips count it under. Rendering nothing here
												     left it indistinguishable from a row whose chips
												     failed to load. -->
												<span
													class="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-fg-muted italic"
													>everywhere</span
												>
											{/if}
											{#each s.tags as t (t)}
												<span class="text-[10px] text-fg-muted">#{t}</span>
											{/each}
										</div>
										<p class="mt-0.5 line-clamp-2 break-words text-xs text-fg-muted">{s.body}</p>
									</div>
									<div class="flex shrink-0 items-center gap-1">
										<button
											type="button"
											disabled={busyId === s.id}
											onclick={() => openEdit(s)}
											title="Edit snippet"
											aria-label="Edit snippet"
											class="flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent text-fg-muted transition hover:bg-surface-sunken disabled:opacity-50"
										>
											<Pencil size={14} strokeWidth={2.25} />
										</button>
										<button
											type="button"
											disabled={busyId === s.id}
											onclick={() => requestDelete(s)}
											title="Delete snippet"
											aria-label="Delete snippet"
											class="flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent text-fg-muted transition hover:bg-surface-sunken hover:text-danger disabled:opacity-50"
										>
											<Trash2 size={14} strokeWidth={2.25} />
										</button>
									</div>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</section>

		<!-- Import / export -->
		<section class="panel-card p-4">
			<h2 class="mb-2 text-sm font-medium">Import or export a library</h2>
			<p class="mb-2 text-xs text-fg-muted">
				One Markdown file. Each snippet is a <code>## Name</code> heading, optional
				<code>kinds:</code> / <code>tags:</code> lines, a blank line, then the body.
			</p>
			<textarea
				bind:value={pasteText}
				placeholder={PLACEHOLDER}
				rows="6"
				class="w-full resize-y rounded-md border border-border bg-surface-sunken px-3 py-2 font-mono text-xs outline-none focus:border-accent"
			></textarea>
			<div class="mt-2 flex flex-wrap items-center gap-2">
				<button
					type="button"
					disabled={busy || pasteText.trim().length === 0}
					onclick={importPaste}
					class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition hover:opacity-90 disabled:opacity-50"
				>
					Import pasted text
				</button>
				<span class="text-xs text-fg-muted">or</span>
				<button
					type="button"
					disabled={busy}
					onclick={() => fileInput?.click()}
					class="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-surface-sunken disabled:opacity-50"
				>
					<Upload size={14} strokeWidth={2.25} /> Choose a .md file
				</button>
				<input
					bind:this={fileInput}
					type="file"
					accept=".md,text/markdown,text/plain"
					class="hidden"
					onchange={(e) => importFile((e.currentTarget as HTMLInputElement).files)}
				/>
				<a
					href="/api/user/prompt-snippets/export"
					class="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-surface-sunken"
				>
					<Download size={14} strokeWidth={2.25} /> Export
				</a>
				<label class="flex cursor-pointer items-center gap-1.5 text-xs text-fg-muted">
					<input type="checkbox" bind:checked={overwrite} />
					Overwrite snippets with the same name
				</label>
			</div>
		</section>
	</div>
</SettingsPage>
