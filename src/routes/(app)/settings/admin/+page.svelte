<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { Copy, Trash2, UserPlus } from '@lucide/svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { toast } from '$lib/toast.svelte';
	import { errorMessageFromResponse } from '$lib/fetch-error';

	type UserRole = 'admin' | 'user';
	interface UserRow {
		id: string;
		displayName: string | null;
		email: string | null;
		role: UserRole;
		disabledAt: number | null;
		createdAt: number;
		lastLoginAt: number | null;
	}
	interface InviteRow {
		id: string;
		role: UserRole;
		createdByUserId: string;
		createdAt: number;
		expiresAt: number;
		usedAt: number | null;
		usedByUserId: string | null;
	}

	let { data } = $props<{ data: { me: string; users: UserRow[]; invites: InviteRow[] } }>();

	let newInviteRole = $state<UserRole>('user');
	let creating = $state(false);
	let busyUserId = $state<string | null>(null);
	let busyInviteId = $state<string | null>(null);
	// The freshly-minted join URL — shown once, since the token is never
	// retrievable again.
	let freshInviteUrl = $state<string | null>(null);

	function formatDate(ms: number | null): string {
		if (ms === null) return 'never';
		return new Date(ms).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		});
	}

	// Used invites are filtered out server-side (a redeemed invite is inert and
	// its user shows in the Users list), so only outstanding ones reach here.
	function inviteStatus(inv: InviteRow): 'expired' | 'active' {
		return inv.expiresAt <= Date.now() ? 'expired' : 'active';
	}

	async function createInvite() {
		if (creating) return;
		creating = true;
		freshInviteUrl = null;
		try {
			const res = await fetch('/api/admin/invites', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ role: newInviteRole }),
			});
			if (!res.ok) {
				toast.error(await errorMessageFromResponse(res));
				return;
			}
			const { token } = (await res.json()) as { token: string };
			freshInviteUrl = `${location.origin}/join/${token}`;
			await invalidate('settings:admin');
		} finally {
			creating = false;
		}
	}

	async function copyInviteUrl() {
		if (!freshInviteUrl) return;
		try {
			await navigator.clipboard.writeText(freshInviteUrl);
			toast.success('Invite link copied');
		} catch {
			toast.error('Could not copy — select and copy the link manually');
		}
	}

	async function revokeInvite(inv: InviteRow) {
		if (busyInviteId) return;
		const ok = await confirmDialog.ask({
			title: 'Revoke this invite?',
			message: 'The link will stop working immediately.',
			confirmLabel: 'Revoke',
		});
		if (!ok) return;
		busyInviteId = inv.id;
		try {
			const res = await fetch(`/api/admin/invites/${encodeURIComponent(inv.id)}`, {
				method: 'DELETE',
			});
			if (!res.ok && res.status !== 404) {
				toast.error(await errorMessageFromResponse(res));
				return;
			}
			await invalidate('settings:admin');
		} finally {
			busyInviteId = null;
		}
	}

	async function toggleDisabled(u: UserRow) {
		if (busyUserId) return;
		const disabling = u.disabledAt === null;
		busyUserId = u.id;
		try {
			const res = await fetch(`/api/admin/users/${encodeURIComponent(u.id)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ disabled: disabling }),
			});
			if (!res.ok) {
				toast.error(await errorMessageFromResponse(res));
				return;
			}
			await invalidate('settings:admin');
		} finally {
			busyUserId = null;
		}
	}

	async function deleteUser(u: UserRow) {
		if (busyUserId) return;
		const ok = await confirmDialog.ask({
			title: `Delete ${u.displayName ?? u.email ?? 'this user'}?`,
			message:
				'This permanently removes the account and all of its conversations, media, and settings. This cannot be undone.',
			confirmLabel: 'Delete',
		});
		if (!ok) return;
		busyUserId = u.id;
		try {
			const res = await fetch(`/api/admin/users/${encodeURIComponent(u.id)}`, {
				method: 'DELETE',
			});
			if (!res.ok) {
				toast.error(await errorMessageFromResponse(res));
				return;
			}
			await invalidate('settings:admin');
		} finally {
			busyUserId = null;
		}
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="shrink-0 px-4 py-3">
		<h1 class="text-lg font-semibold tracking-tight">Administration</h1>
		<p class="text-xs text-fg-muted">
			Invite new users and manage existing accounts. Disabling an account ends its sessions
			immediately and blocks new sign-ins; deleting removes the account and all of its data.
		</p>
	</header>

	<div class="min-h-0 flex-1 space-y-8 overflow-y-auto px-4 pb-8">
		<!-- Invite creation -->
		<section>
			<h2 class="mb-2 text-sm font-semibold">Invite a user</h2>
			<div class="flex flex-wrap items-end gap-3">
				<div class="flex flex-col gap-1">
					<label class="text-xs font-medium text-fg-muted" for="invite-role">Role</label>
					<select
						id="invite-role"
						bind:value={newInviteRole}
						class="rounded border border-border bg-surface-panel px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-fg"
					>
						<option value="user">User</option>
						<option value="admin">Admin</option>
					</select>
				</div>
				<button
					type="button"
					onclick={createInvite}
					disabled={creating}
					class="inline-flex items-center gap-2 rounded-lg bg-surface-inverse px-4 py-2 text-sm font-medium text-fg-inverse transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
				>
					<UserPlus size={15} strokeWidth={2.25} />
					{creating ? 'Creating…' : 'Create invite'}
				</button>
			</div>

			{#if freshInviteUrl}
				<div class="mt-3 rounded-lg border border-border bg-surface-raised p-3">
					<p class="text-xs text-fg-muted">
						Share this link with the invitee. It's shown only once — copy it now.
					</p>
					<div class="mt-2 flex items-center gap-2">
						<input
							readonly
							value={freshInviteUrl}
							class="min-w-0 flex-1 rounded border border-border bg-surface-panel px-2 py-1.5 font-mono text-xs"
						/>
						<button
							type="button"
							onclick={copyInviteUrl}
							class="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-surface-sunken"
						>
							<Copy size={14} strokeWidth={2.25} />
							Copy
						</button>
					</div>
				</div>
			{/if}
		</section>

		<!-- Pending / past invites -->
		<section>
			<h2 class="mb-2 text-sm font-semibold">Pending invites</h2>
			{#if data.invites.length === 0}
				<p class="text-xs text-fg-muted">No pending invites.</p>
			{:else}
				<ul class="divide-y divide-border rounded-lg border border-border">
					{#each data.invites as inv (inv.id)}
						{@const status = inviteStatus(inv)}
						<li class="flex items-center justify-between gap-3 px-3 py-2 text-sm">
							<div class="min-w-0">
								<span class="font-medium capitalize">{inv.role}</span>
								<span class="text-fg-muted">
									· {status === 'active'
										? `expires ${formatDate(inv.expiresAt)}`
										: `expired ${formatDate(inv.expiresAt)}`}
								</span>
							</div>
							<div class="flex items-center gap-3">
								<span
									class="rounded px-1.5 py-0.5 text-[11px] font-medium {status === 'active'
										? 'bg-surface-sunken text-fg'
										: 'text-fg-muted'}"
								>
									{status}
								</span>
								<button
									type="button"
									onclick={() => revokeInvite(inv)}
									disabled={busyInviteId === inv.id}
									class="text-fg-muted transition hover:text-danger disabled:opacity-50"
									aria-label="Revoke invite"
								>
									<Trash2 size={15} strokeWidth={2.25} />
								</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- Users -->
		<section>
			<h2 class="mb-2 text-sm font-semibold">Users</h2>
			<ul class="divide-y divide-border rounded-lg border border-border">
				{#each data.users as u (u.id)}
					<li class="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
						<div class="min-w-0">
							<div class="flex items-center gap-2">
								<span class="truncate font-medium">
									{u.displayName ?? u.email ?? u.id}
								</span>
								<span
									class="rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] font-medium capitalize"
								>
									{u.role}
								</span>
								{#if u.id === data.me}
									<span class="text-[11px] text-fg-muted">(you)</span>
								{/if}
								{#if u.disabledAt !== null}
									<span class="rounded px-1.5 py-0.5 text-[11px] font-medium text-danger">
										disabled
									</span>
								{/if}
							</div>
							<div class="text-xs text-fg-muted">
								{u.email ?? 'no email'} · last login {formatDate(u.lastLoginAt)}
							</div>
						</div>
						{#if u.id !== data.me}
							<div class="flex shrink-0 items-center gap-2">
								<button
									type="button"
									onclick={() => toggleDisabled(u)}
									disabled={busyUserId === u.id}
									class="rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition hover:bg-surface-sunken disabled:opacity-50"
								>
									{u.disabledAt === null ? 'Disable' : 'Enable'}
								</button>
								<button
									type="button"
									onclick={() => deleteUser(u)}
									disabled={busyUserId === u.id}
									class="text-fg-muted transition hover:text-danger disabled:opacity-50"
									aria-label="Delete user"
								>
									<Trash2 size={15} strokeWidth={2.25} />
								</button>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	</div>
</div>
