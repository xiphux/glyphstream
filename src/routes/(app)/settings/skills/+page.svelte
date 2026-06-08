<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { Trash2, Upload, FolderUp } from '@lucide/svelte';
	import type { Skill } from '$lib/types/api';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { toast } from '$lib/toast.svelte';

	let { data } = $props<{ data: { skills: Skill[] } }>();

	let pasteText = $state('');
	let busy = $state(false);
	let busyId = $state<string | null>(null);
	let filesInput = $state<HTMLInputElement | null>(null);
	let folderInput = $state<HTMLInputElement | null>(null);

	function formatDate(ms: number): string {
		const d = new Date(ms);
		const now = new Date();
		const sameYear = d.getFullYear() === now.getFullYear();
		return d.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: sameYear ? undefined : 'numeric',
		});
	}

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

	async function afterImport(res: Response): Promise<void> {
		if (!res.ok) {
			toast.error(`Import failed: ${await errorMessage(res)}`);
			return;
		}
		const body = await res.json();
		toast.success(`Imported skill "${body.skill?.name ?? ''}".`);
		await invalidate('settings:skills');
	}

	async function importPaste() {
		if (busy || pasteText.trim().length === 0) return;
		busy = true;
		try {
			const res = await fetch('/api/user/skills', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: pasteText }),
			});
			await afterImport(res);
			if (res.ok) pasteText = '';
		} catch (e) {
			toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busy = false;
		}
	}

	async function uploadFiles(list: FileList | null) {
		if (busy || !list || list.length === 0) return;
		busy = true;
		try {
			const fd = new FormData();
			for (const f of Array.from(list)) {
				// Send the bundle-relative path as the multipart filename so the
				// server can reconstruct subdirectories (a folder upload populates
				// webkitRelativePath; a flat multi-select falls back to the name).
				const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
				fd.append('file', f, rel);
			}
			const res = await fetch('/api/user/skills', { method: 'POST', body: fd });
			await afterImport(res);
		} catch (e) {
			toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busy = false;
			if (filesInput) filesInput.value = '';
			if (folderInput) folderInput.value = '';
		}
	}

	async function toggleEnabled(s: Skill) {
		if (busyId) return;
		busyId = s.id;
		try {
			const res = await fetch(`/api/user/skills/${encodeURIComponent(s.id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled: !s.enabled }),
			});
			if (!res.ok) throw new Error(await errorMessage(res));
			await invalidate('settings:skills');
		} catch (e) {
			toast.error(`Couldn't update: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busyId = null;
		}
	}

	async function requestDelete(s: Skill) {
		if (busyId) return;
		const ok = await confirmDialog.ask({
			title: `Delete "${s.name}"?`,
			message: 'This removes the skill and its bundled files. This cannot be undone.',
			confirmLabel: 'Delete',
		});
		if (!ok) return;
		busyId = s.id;
		try {
			const res = await fetch(`/api/user/skills/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
			if (!res.ok && res.status !== 404) throw new Error(await errorMessage(res));
			await invalidate('settings:skills');
		} catch (e) {
			toast.error(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busyId = null;
		}
	}

	/** Set the non-standard `webkitdirectory` attribute (folder picker). */
	function directoryPicker(node: HTMLInputElement) {
		node.setAttribute('webkitdirectory', '');
		node.setAttribute('directory', '');
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="shrink-0 px-4 py-3">
		<h1 class="text-lg font-semibold tracking-tight">Skills</h1>
		<p class="text-xs text-fg-muted">
			Reusable capability bundles (a <code>SKILL.md</code> plus optional bundled files). The assistant
			sees a catalog of your enabled skills and loads a skill's full instructions on demand when a task
			matches. Gated per-conversation by the “Agent skills” toggle.
		</p>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-4">
		<div class="mx-auto flex max-w-2xl flex-col gap-4">
			<!-- Import -->
			<section class="rounded-lg border border-border bg-surface-panel p-4">
				<h2 class="mb-2 text-sm font-medium">Import a skill</h2>
				<textarea
					bind:value={pasteText}
					placeholder={'Paste a SKILL.md here…\n\n---\nname: my-skill\ndescription: When to use this skill.\n---\n\nInstructions…'}
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
						Import pasted SKILL.md
					</button>
					<span class="text-xs text-fg-muted">or</span>
					<button
						type="button"
						disabled={busy}
						onclick={() => filesInput?.click()}
						class="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-surface-sunken disabled:opacity-50"
					>
						<Upload size={14} strokeWidth={2.25} /> Choose files
					</button>
					<button
						type="button"
						disabled={busy}
						onclick={() => folderInput?.click()}
						class="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-surface-sunken disabled:opacity-50"
					>
						<FolderUp size={14} strokeWidth={2.25} /> Choose folder
					</button>
					<input
						bind:this={filesInput}
						type="file"
						multiple
						class="hidden"
						onchange={(e) => uploadFiles((e.currentTarget as HTMLInputElement).files)}
					/>
					<input
						bind:this={folderInput}
						type="file"
						multiple
						class="hidden"
						use:directoryPicker
						onchange={(e) => uploadFiles((e.currentTarget as HTMLInputElement).files)}
					/>
				</div>
				<p class="mt-2 text-xs text-fg-muted">
					A multi-file bundle must contain a <code>SKILL.md</code> at its root. Scripts are stored but
					never executed.
				</p>
			</section>

			<!-- List -->
			<section class="rounded-lg border border-border bg-surface-panel p-4">
				{#if data.skills.length === 0}
					<p class="py-8 text-center text-sm text-fg-muted">
						No skills yet. Import one above to get started.
					</p>
				{:else}
					<ul class="flex flex-col gap-0.5">
						{#each data.skills as s (s.id)}
							<li>
								<div
									class="flex items-start gap-3 rounded-md px-3 py-2.5 text-sm transition hover:bg-surface-sunken/70"
									class:opacity-50={!s.enabled}
								>
									<div class="min-w-0 flex-1">
										<div class="flex items-center gap-2">
											<span class="font-mono text-[13px] font-medium">{s.name}</span>
											{#if !s.enabled}
												<span
													class="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-fg-muted"
													>disabled</span
												>
											{/if}
										</div>
										<p class="mt-0.5 break-words text-xs text-fg-muted">{s.description}</p>
									</div>
									<div class="flex shrink-0 flex-col items-end gap-1.5">
										<span class="text-xs text-fg-muted">{formatDate(s.createdAt)}</span>
										<div class="flex items-center gap-1">
											<button
												type="button"
												disabled={busyId === s.id}
												onclick={() => toggleEnabled(s)}
												title={s.enabled ? 'Disable skill' : 'Enable skill'}
												aria-label={s.enabled ? 'Disable skill' : 'Enable skill'}
												class="rounded border border-border bg-transparent px-2 py-1 text-[11px] text-fg-muted transition hover:bg-surface-sunken disabled:opacity-50"
											>
												{s.enabled ? 'Disable' : 'Enable'}
											</button>
											<button
												type="button"
												disabled={busyId === s.id}
												onclick={() => requestDelete(s)}
												title="Delete skill"
												aria-label="Delete skill"
												class="flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent text-fg-muted transition hover:bg-surface-sunken hover:text-danger disabled:opacity-50"
											>
												<Trash2 size={14} strokeWidth={2.25} />
											</button>
										</div>
									</div>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	</div>
</div>
