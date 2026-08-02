/* @vitest-environment happy-dom */

/**
 * Guards the one thing that made a `run_python` call visibly janky: the code
 * argument being re-highlighted from scratch on every streamed delta.
 *
 * The relay emits one `tool_call_args_delta` per upstream chunk, and unlike the
 * assistant text path this one is not rAF-coalesced, so a derived that runs
 * shiki over `streamingCode.code` re-tokenizes the *entire* accumulated program
 * once per delta — O(tokens x final size), worst at the tail where the source is
 * longest and each highlight alone exceeds a frame. `ToolBlockShell` opens the
 * body by default while `status === 'executing'`, so the lazy-body gate that
 * spares other blocks is open exactly when this is worst.
 *
 * Lives in its own file because the assertion needs `$lib/markdown-live-shiki`
 * mocked at module scope — mocking it partway through ToolCallBlock.test.ts
 * would mean re-importing the component into an already-running Svelte runtime.
 */

import { describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render } from '@testing-library/svelte';

const highlighted: string[] = [];
vi.mock('$lib/markdown-live-shiki.svelte', () => ({
	liveHighlighterReady: { value: true },
	resolveLiveLang: () => 'python',
	highlightLiveCode: (code: string) => {
		highlighted.push(code);
		return `<pre class="shiki">${code}</pre>`;
	},
}));

import ToolCallBlock from '$lib/components/ToolCallBlock.svelte';

async function expandDetails(container: HTMLElement) {
	const details = container.querySelector('details')!;
	details.open = true;
	details.dispatchEvent(new Event('toggle'));
	await tick();
}

describe('CodeArgToolBlock — streaming code highlighting', () => {
	it('never highlights while the arguments are still arriving', async () => {
		highlighted.length = 0;
		const { container, rerender } = render(ToolCallBlock, {
			props: {
				toolName: 'run_python',
				argumentsJson: '{"code":"print(1)"}',
				status: 'executing' as const,
			},
		});
		await expandDetails(container);

		// Simulate the deltas: the accumulated source grows every chunk.
		for (let i = 2; i <= 12; i++) {
			await rerender({
				toolName: 'run_python',
				argumentsJson: `{"code":"${Array.from({ length: i }, (_, n) => `print(${n})`).join('\\n')}"}`,
				status: 'executing' as const,
			});
		}
		await tick();

		expect(highlighted, 'highlighted mid-stream — this is the O(n^2) jank').toEqual([]);
		// The code is still shown, just unhighlighted.
		expect(container.textContent).toContain('print(1)');
	});

	it('highlights once the call settles', async () => {
		highlighted.length = 0;
		const props = {
			toolName: 'run_python',
			argumentsJson: '{"code":"print(1)"}',
			status: 'executing' as const,
		};
		const { container, rerender } = render(ToolCallBlock, { props });
		await expandDetails(container);
		expect(highlighted).toEqual([]);

		await rerender({ ...props, status: 'done' as const, result: 'ok' });
		await expandDetails(container);
		expect(highlighted.length).toBeGreaterThan(0);
		expect(container.querySelector('pre.shiki')).not.toBeNull();
	});
});
