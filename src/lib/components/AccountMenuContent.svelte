<!--
	Portal + Content for the (app) layout's bottom-of-sidebar account menu.

	Split into its own file so the layout can dynamically import it the
	first time the user opens the dropdown. The Trigger stays inline in
	the layout — it has to be there for bits-ui's open/close + focus
	mechanics — but the menu items and their lucide icons only get
	pulled in when this menu actually opens.

	`goto` is passed in (rather than imported) so this component has no
	dependency on the routing surface; it's a thin presentational shell
	around DropdownMenu primitives.
-->
<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import { Brain, KeyRound, LogOut, Plug, Settings, ShieldCheck } from '@lucide/svelte';

	let { goto }: { goto: (path: string) => unknown } = $props();
</script>

<DropdownMenu.Portal>
	<DropdownMenu.Content
		sideOffset={6}
		align="start"
		side="top"
		class="z-50 min-w-[180px] overflow-hidden rounded-md border border-border surface-glass gs-pop py-1 shadow-lg"
	>
		<DropdownMenu.Item
			onSelect={() => goto('/settings/preferences')}
			class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
		>
			<Settings size={14} strokeWidth={2.25} />
			<span>Preferences</span>
		</DropdownMenu.Item>
		<DropdownMenu.Item
			onSelect={() => goto('/settings/memories')}
			class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
		>
			<Brain size={14} strokeWidth={2.25} />
			<span>Memories</span>
		</DropdownMenu.Item>
		<DropdownMenu.Item
			onSelect={() => goto('/settings/mcp')}
			class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
		>
			<Plug size={14} strokeWidth={2.25} />
			<span>MCP servers</span>
		</DropdownMenu.Item>
		<DropdownMenu.Item
			onSelect={() => goto('/settings/permissions')}
			class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
		>
			<ShieldCheck size={14} strokeWidth={2.25} />
			<span>Permissions</span>
		</DropdownMenu.Item>
		<DropdownMenu.Item
			onSelect={() => goto('/settings/security')}
			class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
		>
			<KeyRound size={14} strokeWidth={2.25} />
			<span>Security</span>
		</DropdownMenu.Item>
		<DropdownMenu.Item
			onSelect={() => {
				// Form-submit semantics for logout: POST to the
				// session-clearing endpoint and follow its redirect.
				// Building a hidden form lets us reuse the existing
				// /api/auth/logout handler unchanged.
				const f = document.createElement('form');
				f.method = 'POST';
				f.action = '/api/auth/logout';
				document.body.appendChild(f);
				f.submit();
			}}
			class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
		>
			<LogOut size={14} strokeWidth={2.25} />
			<span>Sign out</span>
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Portal>
