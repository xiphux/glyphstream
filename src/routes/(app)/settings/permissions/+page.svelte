<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Undo2 } from '@lucide/svelte';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';

	interface Group {
		id: string;
		displayName: string;
		tools: string[];
	}

	let { data } = $props<{ data: { groups: Group[] } }>();

	let busyTool = $state<string | null>(null);

	function displayName(tool: string): string {
		// mcp__<server>__<tool> → drop the prefix for readability
		if (!tool.startsWith('mcp__')) return tool;
		const rest = tool.slice('mcp__'.length);
		const idx = rest.indexOf('__');
		return idx > 0 ? rest.slice(idx + 2) : tool;
	}

	async function revoke(tool: string): Promise<void> {
		if (busyTool) return;
		const ok = await confirmDialog.ask({
			title: 'Revoke "always allow"?',
			message: `${displayName(tool)} will start asking for approval again the next time the model calls it.`,
			confirmLabel: 'Revoke'
		});
		if (!ok) return;
		busyTool = tool;
		try {
			const res = await fetch(`/api/user/trusted-tools/${encodeURIComponent(tool)}`, {
				method: 'DELETE'
			});
			if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
			await invalidateAll();
		} catch (e) {
			toast.error(`Couldn't revoke: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busyTool = null;
		}
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="shrink-0 px-4 py-3">
		<h1 class="text-lg font-semibold tracking-tight">Permissions</h1>
		<p class="text-xs text-fg-muted">
			Tools you've granted "always allow" so the assistant skips the approval prompt
			on subsequent calls. Revoke any to return that tool to "ask every time".
		</p>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-4">
		<div class="mx-auto flex max-w-2xl flex-col gap-4">
			{#if data.groups.length === 0}
				<div class="rounded-lg border border-border bg-surface-panel p-6 text-center text-sm text-fg-muted">
					<p>No "always allow" grants yet.</p>
					<p class="mt-2 text-xs">
						When the assistant calls an MCP tool, you can pick "Allow always" in the
						approval prompt to skip the question on future calls.
					</p>
				</div>
			{:else}
				{#each data.groups as group (group.id)}
					<section class="rounded-lg border border-border bg-surface-panel p-4">
						<h2 class="text-sm font-semibold">{group.displayName}</h2>
						<ul class="mt-2 flex flex-col gap-1.5">
							{#each group.tools as tool (tool)}
								<li class="group flex items-center justify-between gap-3 rounded-md py-2 pl-3 pr-2 text-sm transition hover:bg-surface-sunken/70">
									<span class="min-w-0 truncate font-mono text-xs">{displayName(tool)}</span>
									<button
										type="button"
										disabled={busyTool === tool}
										onclick={() => void revoke(tool)}
										title="Revoke 'always allow'"
										aria-label="Revoke {tool}"
										class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface-panel px-2 py-1 text-xs text-fg-muted opacity-0 transition hover:bg-surface-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 group-hover:opacity-100"
									>
										<Undo2 size={12} strokeWidth={2.25} />
										Revoke
									</button>
								</li>
							{/each}
						</ul>
					</section>
				{/each}
			{/if}
		</div>
	</div>
</div>
