<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { Switch } from 'bits-ui';
	import { CircleCheck, CircleAlert, CircleSlash, Loader2, KeyRound } from '@lucide/svelte';
	import { toast } from '$lib/toast.svelte';
	import { errorMessageFromResponse } from '$lib/fetch-error';

	interface ToolRow {
		name: string;
		registeredName: string;
		description: string;
		trusted: boolean;
	}

	interface ServerInfo {
		id: string;
		displayName: string;
		transport: 'stdio' | 'http';
		auth: 'global' | 'per_user';
		perUser: boolean;
		configured: boolean;
		state: 'connected' | 'idle' | 'failed' | 'reconnecting' | 'needs-credential';
		error: string | null;
		tools: ToolRow[];
	}

	let { data } = $props<{ data: { servers: ServerInfo[] } }>();

	let busyName = $state<string | null>(null);
	let retryingId = $state<string | null>(null);
	// Per-server token input + in-flight flag for the per-user credential form.
	let tokenInput = $state<Record<string, string>>({});
	let credBusyId = $state<string | null>(null);

	async function saveCredential(server: ServerInfo): Promise<void> {
		if (credBusyId) return;
		const token = (tokenInput[server.id] ?? '').trim();
		if (!token) {
			toast.error('Enter a token first.');
			return;
		}
		credBusyId = server.id;
		try {
			const res = await fetch(`/api/mcp/servers/${encodeURIComponent(server.id)}/credential`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token }),
			});
			if (!res.ok) {
				toast.error(await errorMessageFromResponse(res));
				return;
			}
			const body = (await res.json()) as { state: string; error: string | null };
			if (body.state === 'connected') toast.success(`Connected to ${server.displayName}`);
			else toast.error(`Saved, but couldn't connect: ${body.error ?? 'unknown error'}`);
			tokenInput[server.id] = '';
			// Refresh this page's server states AND the (app) layout's composer
			// capability list, so the now-configured server appears as a toggle.
			await Promise.all([invalidate('settings:mcp'), invalidate('app:mcp-credentials')]);
		} finally {
			credBusyId = null;
		}
	}

	async function removeCredential(server: ServerInfo): Promise<void> {
		if (credBusyId) return;
		credBusyId = server.id;
		try {
			const res = await fetch(`/api/mcp/servers/${encodeURIComponent(server.id)}/credential`, {
				method: 'DELETE',
			});
			if (!res.ok) {
				toast.error(await errorMessageFromResponse(res));
				return;
			}
			// Removing the credential drops the server from the composer's
			// capability list too — refresh both.
			await Promise.all([invalidate('settings:mcp'), invalidate('app:mcp-credentials')]);
		} finally {
			credBusyId = null;
		}
	}

	async function retryServer(server: ServerInfo): Promise<void> {
		if (retryingId) return;
		retryingId = server.id;
		try {
			const res = await fetch(`/api/mcp/servers/${encodeURIComponent(server.id)}/reconnect`, {
				method: 'POST',
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { state: 'connected' | 'failed'; error: string | null };
			if (body.state === 'connected') {
				toast.success(`Reconnected to ${server.displayName}`);
			} else {
				toast.error(`Still failing: ${body.error ?? 'unknown error'}`);
			}
			await invalidate('settings:mcp');
		} catch (e) {
			toast.error(`Retry failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			retryingId = null;
		}
	}

	async function toggleTrust(tool: ToolRow): Promise<void> {
		if (busyName) return;
		busyName = tool.registeredName;
		const method = tool.trusted ? 'DELETE' : 'PUT';
		try {
			const res = await fetch(
				`/api/user/trusted-tools/${encodeURIComponent(tool.registeredName)}`,
				{ method },
			);
			if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
			await invalidate('settings:mcp');
		} catch (e) {
			toast.error(
				`Couldn't ${tool.trusted ? 'revoke' : 'grant'}: ${e instanceof Error ? e.message : String(e)}`,
			);
		} finally {
			busyName = null;
		}
	}

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
			case 'needs-credential':
				return 'Not connected';
		}
	}

	function stateClass(state: ServerInfo['state']): string {
		switch (state) {
			case 'connected':
				return 'text-success';
			case 'idle':
				return 'text-fg-muted';
			case 'reconnecting':
				return 'text-warning';
			case 'failed':
				return 'text-danger';
			case 'needs-credential':
				return 'text-fg-muted';
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
				<div
					class="rounded-lg border border-border bg-surface-panel p-6 text-center text-sm text-fg-muted"
				>
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

						{#if server.perUser}
							<div class="mt-3 rounded-md border border-border bg-surface-sunken/40 p-3">
								<div class="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
									<KeyRound size={13} strokeWidth={2.25} aria-hidden="true" />
									<span>Your credential</span>
								</div>
								<p class="mt-1 text-xs text-fg-muted">
									This server authenticates per user — connect it with your own token (e.g. your
									account's API key). Stored encrypted; visible only to you.
								</p>
								<div class="mt-2 flex flex-wrap items-center gap-2">
									<input
										type="password"
										autocomplete="off"
										bind:value={tokenInput[server.id]}
										placeholder={server.configured
											? 'Enter a new token to replace'
											: 'Paste your token'}
										class="min-w-0 flex-1 rounded border border-border bg-surface-panel px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-fg"
									/>
									<button
										type="button"
										onclick={() => void saveCredential(server)}
										disabled={credBusyId === server.id}
										class="shrink-0 rounded-lg bg-surface-inverse px-3 py-1.5 text-xs font-medium text-fg-inverse transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
									>
										{credBusyId === server.id
											? 'Saving…'
											: server.configured
												? 'Replace'
												: 'Connect'}
									</button>
									{#if server.configured}
										<button
											type="button"
											onclick={() => void removeCredential(server)}
											disabled={credBusyId === server.id}
											class="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50"
										>
											Remove
										</button>
									{/if}
								</div>
							</div>
						{/if}

						{#if server.error}
							<div
								class="mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs alert-danger"
							>
								<div class="min-w-0 flex-1 break-words">{server.error}</div>
								{#if server.state === 'failed'}
									<button
										type="button"
										onclick={() => void retryServer(server)}
										disabled={retryingId === server.id}
										class="shrink-0 rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger transition hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-50"
									>
										{retryingId === server.id ? 'Retrying…' : 'Retry'}
									</button>
								{/if}
							</div>
						{/if}

						{#if server.tools.length > 0}
							<div class="mt-3">
								<div class="text-xs font-medium uppercase tracking-wide text-fg-muted">
									Tools ({server.tools.length})
								</div>
								<ul class="mt-2 flex flex-col gap-1.5">
									{#each server.tools as tool (tool.name)}
										<li
											class="flex items-start gap-3 rounded-md border border-border bg-surface-sunken/40 p-2 text-xs"
										>
											<div class="min-w-0 flex-1">
												<span class="font-mono font-medium">{tool.name}</span>
												{#if tool.description}
													<p class="mt-0.5 text-fg-muted">{tool.description}</p>
												{/if}
											</div>
											<label class="flex shrink-0 cursor-pointer items-center gap-1.5 pt-0.5">
												<Switch.Root
													checked={tool.trusted}
													onCheckedChange={() => void toggleTrust(tool)}
													disabled={busyName === tool.registeredName}
													aria-label="Always allow {tool.name}"
													title={tool.trusted
														? 'Currently always allowed. Toggle off to require approval again.'
														: 'Toggle on to pre-grant "always allow" without waiting for the first call.'}
													class="relative mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full transition data-[state=checked]:bg-surface-inverse data-[state=unchecked]:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-panel disabled:cursor-not-allowed disabled:opacity-50"
												>
													<Switch.Thumb
														class="block h-3 w-3 translate-x-0.5 rounded-full bg-surface-panel shadow-sm transition data-[state=checked]:translate-x-[0.875rem]"
													/>
												</Switch.Root>
												<span class="text-[10px] uppercase tracking-wide text-fg-muted">
													Always allow
												</span>
											</label>
										</li>
									{/each}
								</ul>
							</div>
						{:else if server.state !== 'failed' && server.state !== 'needs-credential'}
							<p class="mt-3 text-xs text-fg-muted">No tools advertised.</p>
						{/if}
					</section>
				{/each}
			{/if}
		</div>
	</div>
</div>
