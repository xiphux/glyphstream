<script lang="ts">
	import { CircleCheck, CircleAlert, CircleSlash, Loader2 } from '@lucide/svelte';

	interface ServerInfo {
		id: string;
		displayName: string;
		transport: 'stdio' | 'http';
		state: 'connected' | 'idle' | 'failed' | 'reconnecting';
		error: string | null;
		tools: Array<{ name: string; description: string }>;
	}

	let { data } = $props<{ data: { servers: ServerInfo[] } }>();

	function stateLabel(state: ServerInfo['state']): string {
		switch (state) {
			case 'connected':
				return 'Connected';
			case 'idle':
				return 'Idle (reconnects on next call)';
			case 'reconnecting':
				return 'Reconnecting';
			case 'failed':
				return 'Failed';
		}
	}

	function stateClass(state: ServerInfo['state']): string {
		switch (state) {
			case 'connected':
				return 'text-emerald-600 dark:text-emerald-400';
			case 'idle':
				return 'text-fg-muted';
			case 'reconnecting':
				return 'text-amber-600 dark:text-amber-400';
			case 'failed':
				return 'text-rose-600 dark:text-rose-400';
		}
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="shrink-0 px-4 py-3">
		<h1 class="text-lg font-semibold tracking-tight">MCP servers</h1>
		<p class="text-xs text-fg-muted">
			MCP servers configured in <code class="font-mono">config.toml</code> and the tools they
			advertise. Per-tool approval lives at
			<a href="/settings/permissions" class="underline hover:text-fg">Permissions</a>.
		</p>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-4">
		<div class="mx-auto flex max-w-2xl flex-col gap-3">
			{#if data.servers.length === 0}
				<div class="rounded-lg border border-border bg-surface-panel p-6 text-center text-sm text-fg-muted">
					<p>No MCP servers configured.</p>
					<p class="mt-2 text-xs">
						Add <code class="font-mono">[[mcp_servers]]</code> blocks to your
						<code class="font-mono">config.toml</code> to surface external tool servers here.
					</p>
				</div>
			{:else}
				{#each data.servers as server (server.id)}
					<section class="rounded-lg border border-border bg-surface-panel p-4">
						<header class="flex items-start justify-between gap-3">
							<div class="min-w-0">
								<h2 class="truncate text-base font-medium">{server.displayName}</h2>
								<p class="mt-0.5 truncate text-xs text-fg-muted">
									<span class="font-mono">{server.id}</span>
									<span class="mx-1">·</span>
									<span class="uppercase tracking-wide">{server.transport}</span>
								</p>
							</div>
							<div class="flex shrink-0 items-center gap-1.5 text-xs {stateClass(server.state)}">
								{#if server.state === 'connected'}
									<CircleCheck size={14} strokeWidth={2.25} aria-hidden="true" />
								{:else if server.state === 'failed'}
									<CircleAlert size={14} strokeWidth={2.25} aria-hidden="true" />
								{:else if server.state === 'reconnecting'}
									<Loader2 size={14} strokeWidth={2.25} class="animate-spin" aria-hidden="true" />
								{:else}
									<CircleSlash size={14} strokeWidth={2.25} aria-hidden="true" />
								{/if}
								<span>{stateLabel(server.state)}</span>
							</div>
						</header>

						{#if server.error}
							<div class="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
								{server.error}
							</div>
						{/if}

						{#if server.tools.length > 0}
							<div class="mt-3">
								<div class="text-xs font-medium uppercase tracking-wide text-fg-muted">
									Tools ({server.tools.length})
								</div>
								<ul class="mt-2 flex flex-col gap-1.5">
									{#each server.tools as tool (tool.name)}
										<li class="rounded-md border border-border bg-surface-sunken/40 p-2 text-xs">
											<span class="font-mono font-medium">{tool.name}</span>
											{#if tool.description}
												<p class="mt-0.5 text-fg-muted">{tool.description}</p>
											{/if}
										</li>
									{/each}
								</ul>
							</div>
						{:else if server.state !== 'failed'}
							<p class="mt-3 text-xs text-fg-muted">No tools advertised.</p>
						{/if}
					</section>
				{/each}
			{/if}
		</div>
	</div>
</div>
