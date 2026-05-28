/* @vitest-environment happy-dom */

/**
 * Component test for ToolCallBlock — folded tool-call display.
 *
 * Pure presentation, no bits-ui. Native `<details>` for the disclosure;
 * happy-dom supports the `open` attribute natively. The content inside
 * `<details>` is always in the DOM regardless of open state, so we can
 * assert on body content without expanding.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ToolCallBlock from '$lib/components/ToolCallBlock.svelte';

describe('ToolCallBlock — header', () => {
	it('renders the tool name in the summary', () => {
		render(ToolCallBlock, {
			props: { toolName: 'get_current_time', argumentsJson: '{}', status: 'done' }
		});
		expect(screen.getByText('get_current_time')).toBeInTheDocument();
	});

	it('shows the TOOL label', () => {
		render(ToolCallBlock, {
			props: { toolName: 'get_current_time', argumentsJson: '{}', status: 'done' }
		});
		expect(screen.getByText('Tool')).toBeInTheDocument();
	});
});

describe('ToolCallBlock — status badge', () => {
	it('renders no badge when status is done', () => {
		render(ToolCallBlock, {
			props: { toolName: 'get_current_time', argumentsJson: '{}', status: 'done' }
		});
		expect(screen.queryByText('running')).toBeNull();
		expect(screen.queryByText('error')).toBeNull();
	});

	it('renders the "running" badge while executing', () => {
		render(ToolCallBlock, {
			props: { toolName: 'get_current_time', argumentsJson: '{}', status: 'executing' }
		});
		expect(screen.getByText('running')).toBeInTheDocument();
	});

	it('renders the "error" badge on error', () => {
		render(ToolCallBlock, {
			props: { toolName: 'get_current_time', argumentsJson: '{}', status: 'error' }
		});
		expect(screen.getByText('error')).toBeInTheDocument();
	});
});

describe('ToolCallBlock — open-by-default behavior', () => {
	it('is collapsed when status=done', () => {
		const { container } = render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '{}', status: 'done' }
		});
		const details = container.querySelector('details')!;
		expect(details.open).toBe(false);
	});

	it('is expanded when status=executing', () => {
		const { container } = render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '{}', status: 'executing' }
		});
		const details = container.querySelector('details')!;
		expect(details.open).toBe(true);
	});

	it('is expanded when status=error', () => {
		const { container } = render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '{}', status: 'error' }
		});
		const details = container.querySelector('details')!;
		expect(details.open).toBe(true);
	});
});

describe('ToolCallBlock — arguments rendering', () => {
	it('pretty-prints valid JSON arguments', () => {
		render(ToolCallBlock, {
			props: {
				toolName: 'x',
				argumentsJson: '{"timezone":"America/New_York","verbose":true}',
				status: 'done'
			}
		});
		// JSON.stringify(obj, null, 2) preserves the key order and indents 2 spaces.
		const pre = screen.getByText(/"timezone": "America\/New_York"/);
		expect(pre).toBeInTheDocument();
		expect(pre.textContent).toContain('"verbose": true');
	});

	it('shows the Arguments header when args are present', () => {
		render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '{"foo":1}', status: 'done' }
		});
		expect(screen.getByText('Arguments')).toBeInTheDocument();
	});

	it('falls back to raw string for malformed JSON', () => {
		render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '{not valid json', status: 'done' }
		});
		expect(screen.getByText('{not valid json')).toBeInTheDocument();
	});

	it('omits the Arguments block when args are empty', () => {
		render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '', status: 'done' }
		});
		expect(screen.queryByText('Arguments')).toBeNull();
	});
});

describe('ToolCallBlock — result rendering', () => {
	it('does not render result when undefined (executing)', () => {
		render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '{}', status: 'executing' }
		});
		expect(screen.queryByText('Result')).toBeNull();
		expect(screen.queryByText('Error')).toBeNull();
	});

	it('renders the Result header and pretty-prints success results', () => {
		render(ToolCallBlock, {
			props: {
				toolName: 'x',
				argumentsJson: '{}',
				result: '{"ok":true,"items":[1,2,3]}',
				status: 'done'
			}
		});
		expect(screen.getByText('Result')).toBeInTheDocument();
		const pre = screen.getByText(/"ok": true/);
		expect(pre.textContent).toContain('[\n    1,\n    2,\n    3\n  ]');
	});

	it('renders the Error header when isError is true', () => {
		render(ToolCallBlock, {
			props: {
				toolName: 'x',
				argumentsJson: '{}',
				result: '{"error":"timeout"}',
				isError: true,
				status: 'error'
			}
		});
		expect(screen.getByText('Error')).toBeInTheDocument();
		expect(screen.queryByText('Result')).toBeNull();
	});

	it('applies the red left-border style on error results', () => {
		const { container } = render(ToolCallBlock, {
			props: {
				toolName: 'x',
				argumentsJson: '{}',
				result: '{"error":"timeout"}',
				isError: true,
				status: 'error'
			}
		});
		// Error styling: the result wrapper gets `border-l-2 border-red-*`.
		expect(container.querySelector('.border-red-400, .border-red-500')).toBeInTheDocument();
	});

	it('does not apply error styling on non-error results', () => {
		const { container } = render(ToolCallBlock, {
			props: {
				toolName: 'x',
				argumentsJson: '{}',
				result: '{"ok":true}',
				status: 'done'
			}
		});
		expect(container.querySelector('.border-red-400, .border-red-500')).toBeNull();
	});

	it('renders empty-string results as the empty fallback', () => {
		// result === '' triggers `result !== undefined` so the block renders,
		// but prettyJson('') returns '' — the pre is empty. Behavior worth
		// pinning: an empty string is still treated as "a result exists".
		render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '{}', result: '', status: 'done' }
		});
		expect(screen.getByText('Result')).toBeInTheDocument();
	});
});
