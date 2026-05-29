<script lang="ts">
	let { data } = $props();
</script>

<div class="flex min-h-screen items-center justify-center p-6">
	<div class="w-full max-w-sm">
		<div
			class="rounded-2xl border border-border bg-surface-panel p-8 shadow-sm"
		>
			<h1 class="text-2xl font-semibold tracking-tight">GlyphStream</h1>
			<p class="mt-1 text-sm text-fg-muted">
				Sign in to continue. Access is limited to allowlisted GitHub accounts.
			</p>

			{#if data.errorMessage}
				<div
					class="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
				>
					{data.errorMessage}
				</div>
			{/if}

			<a
				href="/api/auth/github/login"
				class="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-surface-inverse px-4 py-2.5 text-sm font-medium text-fg-inverse transition hover:opacity-90"
			>
				<svg viewBox="0 0 24 24" class="h-4 w-4" aria-hidden="true" fill="currentColor">
					<path
						d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.27-.01-1.18-.02-2.14-3.2.7-3.88-1.36-3.88-1.36-.52-1.34-1.27-1.7-1.27-1.7-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.18a10.93 10.93 0 0 1 5.74 0c2.2-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.05.78 2.13 0 1.54-.01 2.79-.01 3.16 0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z"
					/>
				</svg>
				Sign in with GitHub
			</a>
		</div>

		<p class="mt-4 text-center text-xs text-fg-muted">
			Self-hosted. Closed registration.
		</p>
	</div>
</div>
