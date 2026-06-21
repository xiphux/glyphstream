<script lang="ts">
	// Brand mark for an OAuth provider button. GitHub renders as a
	// monochrome mark (inherits currentColor); Google uses its 4-colour G;
	// anything else (generic OIDC) falls back to a neutral login glyph.
	import { LogIn } from '@lucide/svelte';

	let { provider, size = 16 }: { provider: string; size?: number } = $props();
</script>

{#if provider === 'github'}
	<svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="currentColor">
		<path
			d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.27-.01-1.18-.02-2.14-3.2.7-3.88-1.36-3.88-1.36-.52-1.34-1.27-1.7-1.27-1.7-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.18a10.93 10.93 0 0 1 5.74 0c2.2-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.05.78 2.13 0 1.54-.01 2.79-.01 3.16 0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z"
		/>
	</svg>
{:else if provider === 'google'}
	<svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
		<path
			fill="#4285F4"
			d="M23.52 12.27c0-.82-.07-1.6-.21-2.36H12v4.47h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.73Z"
		/>
		<path
			fill="#34A853"
			d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.88-3c-1.08.72-2.45 1.16-4.06 1.16-3.12 0-5.77-2.11-6.71-4.95H1.29v3.09A12 12 0 0 0 12 24Z"
		/>
		<path fill="#FBBC05" d="M5.29 14.3a7.2 7.2 0 0 1 0-4.6V6.61H1.29a12 12 0 0 0 0 10.78l4-3.09Z" />
		<path
			fill="#EA4335"
			d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.43-3.43A11.96 11.96 0 0 0 12 0 12 12 0 0 0 1.29 6.61l4 3.09C6.23 6.86 8.88 4.75 12 4.75Z"
		/>
	</svg>
{:else}
	<LogIn {size} strokeWidth={2.25} />
{/if}
