/**
 * Component test for CanvasPane — the view-only side-by-side document pane.
 * Renders the server-provided HTML, the title + version, wires the close
 * button, and (with more than one canvas) a switcher tab strip.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import CanvasPane from '#lib/components/chat/CanvasPane.svelte';
import type { CanvasVersion } from '#lib/types/api.js';

const copyText = vi.hoisted(() => vi.fn(async (_text: string) => true));
vi.mock('#lib/code-copy.js', () => ({ copyText }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('#lib/toast.svelte.js', () => ({ toast: { error: toastError } }));

function doc(overrides: Partial<CanvasVersion> = {}): CanvasVersion {
	return {
		artifactId: 'a1',
		versionId: 'v1',
		title: 'My Doc',
		content: '# Heading\n\nbody',
		contentHtml: '<h1>Heading</h1>\n<p>body</p>',
		versionNumber: 3,
		editSource: 'agent',
		...overrides,
	};
}

/** Default single-canvas props. */
function props(over: Partial<Parameters<typeof render>[1]['props']> = {}) {
	const d = doc();
	return {
		doc: d,
		docs: [d],
		changed: false,
		onClose: () => {},
		onSwitch: () => {},
		onHighlightSettled: () => {},
		...over,
	};
}

describe('CanvasPane', () => {
	it('renders the title, version, and server HTML', () => {
		render(CanvasPane, { props: props() });
		expect(screen.getByRole('heading', { name: 'My Doc' })).toBeInTheDocument();
		expect(screen.getByText('Version 3')).toBeInTheDocument();
		expect(screen.getByText('body')).toBeInTheDocument();
	});

	it('falls back to "Canvas" when the doc has no title', () => {
		const d = doc({ title: null });
		render(CanvasPane, { props: props({ doc: d, docs: [d] }) });
		expect(screen.getByRole('heading', { name: 'Canvas' })).toBeInTheDocument();
	});

	it('shows an empty-state note when there is no content', () => {
		const d = doc({ contentHtml: null, content: '' });
		render(CanvasPane, { props: props({ doc: d, docs: [d] }) });
		expect(screen.getByText(/empty/i)).toBeInTheDocument();
	});

	it('invokes onClose when the close button is clicked', async () => {
		const onClose = vi.fn();
		const { getByLabelText } = render(CanvasPane, { props: props({ onClose }) });
		getByLabelText('Close canvas').click();
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('shows a switcher tab per canvas when there are several, and switches on click', () => {
		const a = doc({ artifactId: 'a1', title: 'Deck' });
		const b = doc({ artifactId: 'a2', title: 'Talking points' });
		const onSwitch = vi.fn();
		render(CanvasPane, { props: props({ doc: a, docs: [a, b], onSwitch }) });

		const tabs = screen.getAllByRole('tab');
		expect(tabs).toHaveLength(2);
		expect(screen.getByRole('tab', { name: 'Deck' })).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByRole('tab', { name: 'Talking points' })).toHaveAttribute(
			'aria-selected',
			'false',
		);

		screen.getByRole('tab', { name: 'Talking points' }).click();
		expect(onSwitch).toHaveBeenCalledWith('a2');
	});

	it('shows no tabs for a single canvas', () => {
		render(CanvasPane, { props: props() });
		expect(screen.queryAllByRole('tab')).toHaveLength(0);
	});

	describe('export', () => {
		afterEach(() => {
			vi.restoreAllMocks();
			copyText.mockClear();
			toastError.mockClear();
		});

		it('copies the raw markdown, not the rendered HTML', async () => {
			render(CanvasPane, { props: props() });
			screen.getByRole('button', { name: 'Copy markdown' }).click();
			expect(copyText).toHaveBeenCalledWith('# Heading\n\nbody');
			await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible());
		});

		it("doesn't carry the copied confirmation to another canvas", async () => {
			const a = doc({ artifactId: 'a1', title: 'Deck' });
			const b = doc({ artifactId: 'a2', title: 'Talking points' });
			const { rerender } = render(CanvasPane, { props: props({ doc: a, docs: [a, b] }) });
			screen.getByRole('button', { name: 'Copy markdown' }).click();
			await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible());

			await rerender({ doc: b });
			expect(screen.getByRole('button', { name: 'Copy markdown' })).toBeVisible();

			await rerender({ doc: a });
			expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible();
		});

		it('says so when the clipboard cannot be written', async () => {
			copyText.mockResolvedValueOnce(false);
			render(CanvasPane, { props: props() });
			screen.getByRole('button', { name: 'Copy markdown' }).click();
			await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
			expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
		});

		it('downloads the raw markdown as a file named after the title', async () => {
			const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:canvas');
			const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
			const d = doc({ title: 'Q3 Plan: Draft #2' });
			render(CanvasPane, { props: props({ doc: d, docs: [d] }) });

			screen.getByRole('button', { name: 'Download markdown' }).click();

			expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('q3-plan-draft-2.md');
			expect((click.mock.contexts[0] as HTMLAnchorElement).href).toBe('blob:canvas');
			expect(await (createObjectURL.mock.calls[0][0] as Blob).text()).toBe('# Heading\n\nbody');
		});

		it('falls back to canvas.md for an untitled canvas', () => {
			vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:canvas');
			const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
			const d = doc({ title: null });
			render(CanvasPane, { props: props({ doc: d, docs: [d] }) });
			screen.getByRole('button', { name: 'Download markdown' }).click();
			expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('canvas.md');
		});

		it('offers both actions alongside the switcher tabs too', () => {
			const a = doc({ artifactId: 'a1' });
			const b = doc({ artifactId: 'a2' });
			render(CanvasPane, { props: props({ doc: a, docs: [a, b] }) });
			expect(screen.getByRole('button', { name: 'Copy markdown' })).toBeEnabled();
			expect(screen.getByRole('button', { name: 'Download markdown' })).toBeEnabled();
		});

		it('disables both for an empty canvas', () => {
			const d = doc({ contentHtml: null, content: '' });
			render(CanvasPane, { props: props({ doc: d, docs: [d] }) });
			expect(screen.getByRole('button', { name: 'Copy markdown' })).toBeDisabled();
			expect(screen.getByRole('button', { name: 'Download markdown' })).toBeDisabled();
		});
	});
});
