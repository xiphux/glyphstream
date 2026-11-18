/**
 * A streaming reply's finished top-level blocks keep their DOM nodes from one
 * frame to the next. The chat page's rAF pump renders the growing text to HTML
 * and cuts it into top-level parts; RenderBlocks writes each part through its
 * own `{@html}`, which Svelte leaves alone when the string is unchanged. Written
 * as one string, every highlighted code block was torn down and re-parsed on
 * every frame until the reply ended.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import RenderBlocks from '#lib/components/chat/RenderBlocks.svelte';
import {
	appendText,
	inFlightToBlocks,
	type InFlightSegment,
	type InFlightTextSegment,
} from '#lib/chat-render.js';
import { splitTopLevelHtml, withoutCheckInMarkers } from '#lib/texting.js';

const CLOSED_FENCE =
	'<p>Intro.</p>\n<pre class="shiki"><code><span class="line"><span>def f():</span></span>\n</code></pre>\n<hr>\n';

/** A text segment as the pump leaves it after rendering `html`. */
function pumped(html: string, text = 'x'): InFlightTextSegment {
	return {
		kind: 'text',
		text,
		html,
		htmlParts: splitTopLevelHtml(html, true),
		htmlFromText: text,
	};
}

function mount(segments: InFlightSegment[]) {
	return render(RenderBlocks, {
		props: { blocks: inFlightToBlocks(segments), onImageClick: () => {}, codeCopy: false },
	});
}

describe('streaming render keeps finished blocks mounted', () => {
	it('keeps a closed code block and its neighbours while later text grows', async () => {
		const view = mount([pumped(CLOSED_FENCE + '<p>Next</p>\n')]);
		const pre = view.container.querySelector('pre');
		const intro = view.container.querySelector('p');
		const hr = view.container.querySelector('hr');
		expect(pre).not.toBeNull();

		await view.rerender({
			blocks: inFlightToBlocks([pumped(CLOSED_FENCE + '<p>Next paragraph grows</p>\n')]),
		});

		expect(view.container.textContent).toContain('Next paragraph grows');
		expect(view.container.querySelector('pre')).toBe(pre);
		expect(view.container.querySelector('p')).toBe(intro);
		expect(view.container.querySelector('hr')).toBe(hr);
		expect(pre!.isConnected).toBe(true);
	});

	it('keeps them across a chunk that arrives between frames', async () => {
		const first = [pumped(CLOSED_FENCE + '<p>Next</p>\n', 'md')];
		const view = mount(first);
		const pre = view.container.querySelector('pre');

		// The chunk lands before the pump has rendered it: appendText carries the
		// last render's parts forward, or that render is written as one string.
		await view.rerender({ blocks: inFlightToBlocks(appendText(first, ' more')) });
		await view.rerender({
			blocks: inFlightToBlocks([pumped(CLOSED_FENCE + '<p>Next more</p>\n', 'md more')]),
		});

		expect(view.container.textContent).toContain('Next more');
		expect(view.container.querySelector('pre')).toBe(pre);
	});

	it('lays the parts out as the same elements a single string would', () => {
		const html = CLOSED_FENCE + '<ul>\n<li>a</li>\n</ul>\n<p>tail</p>\n';
		const parted = mount([pumped(html)]).container.querySelector('.gs-prose')!;
		const whole = render(RenderBlocks, {
			props: { blocks: [{ type: 'html', html }], onImageClick: () => {}, codeCopy: false },
		}).container.querySelector('.gs-prose')!;

		const outer = (el: Element) => [...el.children].map((c) => c.outerHTML);
		expect(outer(parted)).toEqual(outer(whole));
	});

	it('keeps the parts in step when check-in markers are filtered out', () => {
		const [block] = withoutCheckInMarkers(
			inFlightToBlocks([pumped('<p>Hi.</p>\n<p>[later 2h: ping]</p>\n<p>Bye.</p>\n')]),
		);
		expect(block).toMatchObject({ type: 'html', parts: ['<p>Hi.</p>', '<p>Bye.</p>'] });
	});
});
