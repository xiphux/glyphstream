<!--
	The emoji the assistant tapped onto a user message — a "tapback", in
	iMessage's word for it.

	Positioned absolutely against the user bubble's BOTTOM-LEFT corner and hung
	a third of the way outside it. The overhang is negative MARGIN, not a
	translate: the pop-in keyframe animates `transform`, and a utility-set
	translate on the same element would either be clobbered mid-animation or
	double up, depending on which of the two forms Tailwind emits. Messenger puts a reaction at the bottom-right, but our user
	bubble is `ml-auto` (right-aligned), so a right-hung badge would press
	against the screen edge on a phone; the left corner hangs into empty gutter
	instead. Bottom rather than top because a reaction reads as the assistant's
	first response to the message, and the reply it precedes is directly below.

	`overflow-hidden` is a backstop, not decoration. The emoji is model-authored
	and validated as ONE GRAPHEME, which is not a bound on visual width: a ZWJ
	chain of pictographs is a single grapheme (UAX #29 GB11), so ~11 emoji fit
	inside the 32-unit length cap, and a stack of combining marks does the same
	vertically. Without the clip that renders as a strip across the neighbouring
	bubbles. The clip keeps a bad value ugly instead of destructive.

	Whether the badge is INTERACTIVE is deliberately settled: it isn't. There is
	no "who reacted" popover to open and nothing to toggle, and a control that's
	hidden until hover would be permanently invisible on touch anyway (Tailwind
	v4 wraps `hover:` in `@media (hover: hover)` — see the note in CLAUDE.md).
	It's a plain span with `role="img"` and an accessible name that carries the
	emoji, so a screen reader announces "Aria reacted with party popper" rather
	than reading a bare character out of context.
-->
<script lang="ts">
	interface Props {
		/** A single emoji grapheme, validated server-side at call time. */
		emoji: string;
		/** Who reacted — the assistant's display name for this conversation, so
		 *  a roleplay preset's tapback is announced under its own name. */
		reactorLabel: string;
	}

	let { emoji, reactorLabel }: Props = $props();
</script>

<span
	class="gs-reaction-pop pointer-events-none absolute bottom-0 left-0 z-10 -mb-2 -ml-2 flex size-6 items-center justify-center overflow-hidden rounded-full bg-surface-raised text-[13px] leading-none shadow-sm ring-1 ring-border-strong select-none"
	role="img"
	aria-label="{reactorLabel} reacted with {emoji}"
>
	{emoji}
</span>
