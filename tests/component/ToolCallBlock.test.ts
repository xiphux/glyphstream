/* @vitest-environment happy-dom */

/**
 * Component test for ToolCallBlock — the tool-call display dispatcher
 * (→ SkillToolBlock / CodeArgToolBlock / GenericToolBlock via ToolBlockShell).
 *
 * Pure presentation, no bits-ui. Native `<details>` for the disclosure. NOTE:
 * the body is rendered only while the block is OPEN (`{#if isOpen}` in the
 * shell), so a COLLAPSED (status: 'done') block has NO body content in the DOM —
 * any assertion on body content (args / result / skill body) must first
 * `await expandDetails(container)`. Summary (tool/skill name + badge) and
 * attachments (outside the `<details>`) are present while collapsed.
 */

import { describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, screen } from '@testing-library/svelte';
import ToolCallBlock from '$lib/components/ToolCallBlock.svelte';

/** Expand a tool block's <details> (skill bodies render lazily on expand). */
async function expandDetails(container: HTMLElement) {
	const details = container.querySelector('details')!;
	details.open = true;
	details.dispatchEvent(new Event('toggle'));
	await tick();
}

describe('ToolCallBlock — header', () => {
	it('renders the tool name in the summary', () => {
		render(ToolCallBlock, {
			props: { toolName: 'get_current_time', argumentsJson: '{}', status: 'done' },
		});
		expect(screen.getByText('get_current_time')).toBeInTheDocument();
	});

	it('shows the TOOL label', () => {
		render(ToolCallBlock, {
			props: { toolName: 'get_current_time', argumentsJson: '{}', status: 'done' },
		});
		expect(screen.getByText('Tool')).toBeInTheDocument();
	});
});

describe('ToolCallBlock — status badge', () => {
	it('renders no badge when status is done', () => {
		render(ToolCallBlock, {
			props: { toolName: 'get_current_time', argumentsJson: '{}', status: 'done' },
		});
		expect(screen.queryByText('running')).toBeNull();
		expect(screen.queryByText('error')).toBeNull();
	});

	it('renders the "running" badge while executing', () => {
		render(ToolCallBlock, {
			props: { toolName: 'get_current_time', argumentsJson: '{}', status: 'executing' },
		});
		expect(screen.getByText('running')).toBeInTheDocument();
	});

	it('renders the "error" badge on error', () => {
		render(ToolCallBlock, {
			props: { toolName: 'get_current_time', argumentsJson: '{}', status: 'error' },
		});
		expect(screen.getByText('error')).toBeInTheDocument();
	});
});

describe('ToolCallBlock — open-by-default behavior', () => {
	it('is collapsed when status=done', () => {
		const { container } = render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '{}', status: 'done' },
		});
		const details = container.querySelector('details')!;
		expect(details.open).toBe(false);
	});

	it('is expanded when status=executing', () => {
		const { container } = render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '{}', status: 'executing' },
		});
		const details = container.querySelector('details')!;
		expect(details.open).toBe(true);
	});

	it('is expanded when status=error', () => {
		const { container } = render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '{}', status: 'error' },
		});
		const details = container.querySelector('details')!;
		expect(details.open).toBe(true);
	});
});

describe('ToolCallBlock — arguments rendering', () => {
	it('pretty-prints valid JSON arguments', async () => {
		const { container } = render(ToolCallBlock, {
			props: {
				toolName: 'x',
				argumentsJson: '{"timezone":"America/New_York","verbose":true}',
				status: 'done',
			},
		});
		await expandDetails(container);
		// JSON.stringify(obj, null, 2) preserves the key order and indents 2 spaces.
		const pre = screen.getByText(/"timezone": "America\/New_York"/);
		expect(pre).toBeInTheDocument();
		expect(pre.textContent).toContain('"verbose": true');
	});

	it('shows the Arguments header when args are present', async () => {
		const { container } = render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '{"foo":1}', status: 'done' },
		});
		await expandDetails(container);
		expect(screen.getByText('Arguments')).toBeInTheDocument();
	});

	it('falls back to raw string for malformed JSON', async () => {
		const { container } = render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '{not valid json', status: 'done' },
		});
		await expandDetails(container);
		expect(screen.getByText('{not valid json')).toBeInTheDocument();
	});

	it('omits the Arguments block when args are empty', () => {
		render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '', status: 'done' },
		});
		expect(screen.queryByText('Arguments')).toBeNull();
	});
});

describe('ToolCallBlock — result rendering', () => {
	it('does not render result when undefined (executing)', () => {
		render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '{}', status: 'executing' },
		});
		expect(screen.queryByText('Result')).toBeNull();
		expect(screen.queryByText('Error')).toBeNull();
	});

	it('renders the Result header and pretty-prints success results', async () => {
		const { container } = render(ToolCallBlock, {
			props: {
				toolName: 'x',
				argumentsJson: '{}',
				result: '{"ok":true,"items":[1,2,3]}',
				status: 'done',
			},
		});
		await expandDetails(container);
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
				status: 'error',
			},
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
				status: 'error',
			},
		});
		// Error styling: the result wrapper gets `border-l-2 border-danger`.
		expect(container.querySelector('.border-danger')).toBeInTheDocument();
	});

	it('does not apply error styling on non-error results', () => {
		const { container } = render(ToolCallBlock, {
			props: {
				toolName: 'x',
				argumentsJson: '{}',
				result: '{"ok":true}',
				status: 'done',
			},
		});
		expect(container.querySelector('.border-danger')).toBeNull();
	});

	it('renders empty-string results as the empty fallback', async () => {
		// result === '' triggers `result !== undefined` so the block renders,
		// but prettyJson('') returns '' — the pre is empty. Behavior worth
		// pinning: an empty string is still treated as "a result exists".
		const { container } = render(ToolCallBlock, {
			props: { toolName: 'x', argumentsJson: '{}', result: '', status: 'done' },
		});
		await expandDetails(container);
		expect(screen.getByText('Result')).toBeInTheDocument();
	});
});

describe('ToolCallBlock — skill rendering', () => {
	const activateResult =
		'<skill_content name="review">\n\nReview the code carefully.\n\n<skill_resources>\nFiles:\n- references/api.md\n</skill_resources>\n\n</skill_content>';

	it('renders activate_skill as a Skill chip with the name, not the raw tool envelope', async () => {
		const { container } = render(ToolCallBlock, {
			props: {
				toolName: 'activate_skill',
				argumentsJson: '{"name":"review"}',
				result: activateResult,
				status: 'done',
			},
		});
		expect(screen.getByText('Skill')).toBeInTheDocument();
		expect(screen.getByText('review')).toBeInTheDocument();
		// The generic tool envelope is gone.
		expect(container.textContent).not.toContain('"name"');
		expect(screen.queryByText('Tool')).toBeNull();
		expect(screen.queryByText('Arguments')).toBeNull();
		expect(screen.queryByText('Result')).toBeNull();
		// Instructions render on expand (deferred for perf); plumbing stays hidden.
		await expandDetails(container);
		expect(container.textContent).toContain('Review the code carefully.');
		expect(container.textContent).not.toContain('<skill_content');
	});

	it('defers the skill-body markdown until the block is expanded', () => {
		// Collapsed (the streaming state): the body markdown is NOT rendered, so a
		// large SKILL.md can't block the main thread while the response streams.
		const { container } = render(ToolCallBlock, {
			props: {
				toolName: 'activate_skill',
				argumentsJson: '{"name":"review"}',
				result: activateResult,
				status: 'done',
			},
		});
		expect(container.textContent).not.toContain('Review the code carefully.');
	});

	it('lists bundled resources for an activated skill', async () => {
		const { container } = render(ToolCallBlock, {
			props: {
				toolName: 'activate_skill',
				argumentsJson: '{"name":"review"}',
				result: activateResult,
				status: 'done',
			},
		});
		await expandDetails(container);
		expect(container.textContent).toContain('references/api.md');
		expect(container.textContent).not.toContain('<skill_resources');
	});

	it('renders read_skill_file as a Skill file chip with the path + file text', async () => {
		const { container } = render(ToolCallBlock, {
			props: {
				toolName: 'read_skill_file',
				argumentsJson: '{"name":"review","path":"references/api.md"}',
				result:
					'<skill_file name="review" path="references/api.md">\nfile text here\n</skill_file>',
				status: 'done',
			},
		});
		// Chip (summary) is visible while collapsed; the file text is in the body.
		expect(screen.getByText('Skill file')).toBeInTheDocument();
		expect(screen.getByText('references/api.md')).toBeInTheDocument();
		expect(screen.queryByText('Tool')).toBeNull();
		await expandDetails(container);
		expect(container.textContent).toContain('file text here');
		expect(container.textContent).not.toContain('<skill_file');
	});

	it('surfaces a skill activation error without the JSON envelope', () => {
		const { container } = render(ToolCallBlock, {
			props: {
				toolName: 'activate_skill',
				argumentsJson: '{"name":"ghost"}',
				result: '{"error":"No enabled skill named \\"ghost\\"."}',
				isError: true,
				status: 'error',
			},
		});
		expect(screen.getByText('Error')).toBeInTheDocument();
		expect(container.textContent).toContain('No enabled skill named "ghost".');
		expect(container.textContent).not.toContain('{"error"');
	});
});

describe('ToolCallBlock — approval prompt (MCP / generic)', () => {
	const pendingProps = {
		toolName: 'mcp__server__do_thing',
		argumentsJson: '{"x":1}',
		status: 'pending_approval' as const,
		toolCallId: 'call-1',
	};

	it('renders the three approval buttons + needs-approval badge (open by default)', () => {
		// pending_approval is open-by-default, so no expand needed.
		render(ToolCallBlock, { props: pendingProps });
		expect(screen.getByText('needs approval')).toBeInTheDocument();
		expect(screen.getByText('Awaiting your approval')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Allow always' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
	});

	it('highlights only the staged decision', () => {
		render(ToolCallBlock, { props: { ...pendingProps, decision: 'allow' } });
		expect(screen.getByRole('button', { name: 'Allow' }).className).toContain('border-success/50');
		expect(screen.getByRole('button', { name: 'Reject' }).className).not.toContain(
			'border-danger/50',
		);
	});

	it('fires onApprovalSelect with the toolCallId + action on click', async () => {
		const onApprovalSelect = vi.fn();
		render(ToolCallBlock, { props: { ...pendingProps, onApprovalSelect } });
		screen.getByRole('button', { name: 'Reject' }).click();
		expect(onApprovalSelect).toHaveBeenCalledWith('call-1', 'reject');
	});

	it('disables the buttons while approvalBusy', () => {
		render(ToolCallBlock, {
			props: { ...pendingProps, approvalBusy: true, onApprovalSelect: vi.fn() },
		});
		expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
	});
});

describe('ToolCallBlock — attachments', () => {
	it('shows produced media even when the block is collapsed (done)', () => {
		// Attachments live outside <details>, so they're visible while collapsed.
		const { container } = render(ToolCallBlock, {
			props: {
				toolName: 'run_python',
				argumentsJson: '{"code":"x"}',
				result: 'ok',
				status: 'done',
				attachments: [{ type: 'image', mediaId: 'media-9' }],
			},
		});
		const img = container.querySelector('img');
		expect(img).toBeInTheDocument();
		expect(img?.getAttribute('src')).toContain('media-9');
	});
});
