<script lang="ts">
	let { children } = $props<{ children: import('svelte').Snippet }>();
</script>

<!-- The status-bar sampler, and the ONLY place it still exists.

	 Inside (app) the mobile top bar does this job itself (see its comment in
	 (app)/+layout.svelte): it is real chrome, already the right colour, and
	 already the right size. These three routes — login, /join/<token>, setup —
	 have no equivalent row, so without a stand-in the iOS 26/27 status bar
	 falls back to the Liquid Glass blur over whatever the page paints.

	 It is a plain surface-coloured strip, invisible against the page's own
	 surface, sized and positioned to satisfy WebKit's sampler rather than to be
	 seen — app.css carries the gates it has to clear. -->
<div class="status-bar-sampler" aria-hidden="true"></div>

{@render children()}
