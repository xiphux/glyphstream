<!--
	Scrollable region with edge-fade affordances and a bindable scroll
	element so parents can imperatively jump to top or bottom.

	The fades replace the discoverability that an always-visible scrollbar
	would give — on macOS Safari (and most touch-driven setups) the OS
	scrollbar is hidden until interaction, leaving a long list looking
	clipped rather than scrollable. Each edge fades only when there's
	content in that direction (top fade only when scrolled down at all,
	bottom fade only when content extends below the viewport), so the
	signal reads as "there's more this way."

	Implementation: a CSS `mask-image` linear-gradient on the scroll
	element. The mask makes the top/bottom edge bands transparent,
	revealing whatever the parent background is. Two CSS variables (set
	via inline `style:` props) control the band heights, which collapse
	to zero at the corresponding scroll extremes so the edges look sharp
	when you can't scroll further that way. Driving the visual via
	transparency rather than absolute-positioned overlays keeps everything
	on one element — no wrapper-sizing dance — which matters because the
	caller may size this with `max-h-*` (content-driven height, clamped),
	`flex-1` (flex-allocated space), or anything else.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** Content rendered inside the scroll container. */
		children: Snippet;
		/**
		 * Tailwind classes applied to the scroll element itself. The size
		 * constraint (`max-h-[30vh]`, `flex-1`, `h-64`, …) goes here, as
		 * do any content-area concerns (padding, gap). Single class slot
		 * keeps callers from having to disambiguate "wrapper vs inner."
		 */
		class?: string;
		/**
		 * Bindable handle to the scroll element. Parents can imperatively
		 * `scrollEl.scrollTo({ top: 0 })` after a list update that pushes
		 * the user's just-added item out of view.
		 */
		scrollEl?: HTMLElement | null;
	}

	let { children, class: className = '', scrollEl = $bindable(null) }: Props = $props();

	// Whether the user can scroll further in each direction. Recomputed
	// on scroll, on content mutation (new favorite added, conversation
	// archived), and on resize (sidebar collapse, window resize).
	// The `- 1` on the bottom test absorbs sub-pixel rounding where
	// scrollTop + clientHeight ends up fractionally short of scrollHeight
	// despite the user being at the actual bottom.
	let canScrollUp = $state(false);
	let canScrollDown = $state(false);

	const FADE_PX = 16;
	const fadeTop = $derived(canScrollUp ? `${FADE_PX}px` : '0px');
	const fadeBottom = $derived(canScrollDown ? `${FADE_PX}px` : '0px');

	function update() {
		const el = scrollEl;
		if (!el) return;
		canScrollUp = el.scrollTop > 0;
		canScrollDown = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
	}

	$effect(() => {
		const el = scrollEl;
		if (!el) return;
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		const mo = new MutationObserver(update);
		mo.observe(el, { childList: true, subtree: true });
		el.addEventListener('scroll', update, { passive: true });
		return () => {
			ro.disconnect();
			mo.disconnect();
			el.removeEventListener('scroll', update);
		};
	});

	// Animated transition on the mask sizes so the fade fades in/out as
	// you start/stop scrolling rather than popping. Same duration as the
	// rest of the sidebar's hover/transition affordances.
	const maskValue = $derived(
		`linear-gradient(to bottom, transparent 0, black ${fadeTop}, black calc(100% - ${fadeBottom}), transparent 100%)`,
	);
</script>

<div
	bind:this={scrollEl}
	class="overflow-y-auto {className}"
	style:mask-image={maskValue}
	style:-webkit-mask-image={maskValue}
>
	{@render children()}
</div>
