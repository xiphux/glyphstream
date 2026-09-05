<!--
	Portal + Content for the (app) layout's bottom-of-sidebar account menu.

	Split into its own file so the layout can dynamically import it the
	first time the user opens the dropdown. The Trigger stays inline in
	the layout — it has to be there for bits-ui's open/close + focus
	mechanics — but the menu items and their lucide icons only get
	pulled in when this menu actually opens.

	`goto` is passed in rather than imported from `$app/navigation`, so the
	layout owns *navigation* and this stays a thin presentational shell around
	DropdownMenu primitives. Note that is no longer a claim of zero routing
	dependency: the destinations are resolved here via `$app/paths`, which
	type-checks them against the generated route table. That's a deliberate
	trade — a renamed route fails the build instead of 404ing — and it is safe
	here because nothing under tests/ imports this component. Contrast
	`conversation-ui-actions.svelte.ts`, which keeps its injected `goto` free of
	`$app/paths` precisely because a node-env test imports it.
-->
<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import { resolve } from '$app/paths';
	import {
		Brain,
		KeyRound,
		LogOut,
		Plug,
		Server,
		Settings,
		ShieldCheck,
		Sparkles,
		TextQuote,
		Users,
	} from '@lucide/svelte';

	let { goto, isAdmin = false }: { goto: (path: string) => unknown; isAdmin?: boolean } = $props();
</script>

<DropdownMenu.Portal>
	<DropdownMenu.Content
		sideOffset={6}
		align="start"
		side="top"
		class="z-overlay min-w-[180px] overflow-hidden rounded-md border border-border surface-glass gs-pop py-1 shadow-lg"
	>
		<DropdownMenu.Item
			onSelect={() => goto(resolve('/settings/preferences'))}
			class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
		>
			<Settings size={14} strokeWidth={2.25} />
			<span>Preferences</span>
		</DropdownMenu.Item>
		<DropdownMenu.Item
			onSelect={() => goto(resolve('/settings/memories'))}
			class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
		>
			<Brain size={14} strokeWidth={2.25} />
			<span>Memories</span>
		</DropdownMenu.Item>
		<DropdownMenu.Item
			onSelect={() => goto(resolve('/settings/skills'))}
			class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
		>
			<Sparkles size={14} strokeWidth={2.25} />
			<span>Skills</span>
		</DropdownMenu.Item>
		<DropdownMenu.Item
			onSelect={() => goto(resolve('/settings/snippets'))}
			class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
		>
			<TextQuote size={14} strokeWidth={2.25} />
			<span>Prompt snippets</span>
		</DropdownMenu.Item>
		<DropdownMenu.Item
			onSelect={() => goto(resolve('/settings/mcp'))}
			class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
		>
			<Plug size={14} strokeWidth={2.25} />
			<span>MCP servers</span>
		</DropdownMenu.Item>
		<DropdownMenu.Item
			onSelect={() => goto(resolve('/settings/permissions'))}
			class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
		>
			<ShieldCheck size={14} strokeWidth={2.25} />
			<span>Permissions</span>
		</DropdownMenu.Item>
		<DropdownMenu.Item
			onSelect={() => goto(resolve('/settings/security'))}
			class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
		>
			<KeyRound size={14} strokeWidth={2.25} />
			<span>Security</span>
		</DropdownMenu.Item>
		{#if isAdmin}
			<!-- Users and Endpoints are SIBLING operator surfaces, not one "Admin"
			     page with the other hanging off it. The separator + heading is what
			     says they're install-wide rather than more personal settings —
			     everything above this line only affects the signed-in user. -->
			<DropdownMenu.Separator class="my-1 h-px bg-border" />
			<DropdownMenu.Group>
				<DropdownMenu.GroupHeading
					class="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted"
				>
					Administration
				</DropdownMenu.GroupHeading>
				<DropdownMenu.Item
					onSelect={() => goto(resolve('/settings/users'))}
					class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
				>
					<Users size={14} strokeWidth={2.25} />
					<span>Users</span>
				</DropdownMenu.Item>
				<DropdownMenu.Item
					onSelect={() => goto(resolve('/settings/endpoints'))}
					class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
				>
					<Server size={14} strokeWidth={2.25} />
					<span>Endpoints</span>
				</DropdownMenu.Item>
			</DropdownMenu.Group>
			<DropdownMenu.Separator class="my-1 h-px bg-border" />
		{/if}
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
