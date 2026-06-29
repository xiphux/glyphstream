/* @vitest-environment happy-dom */

/**
 * Component test for FeatureTogglesMenu — pure presentation, exercises
 * the prop/callback contract end-to-end through a real DOM.
 *
 * Pattern notes (see tests/component/README.md):
 * - Popover.Portal renders content to document.body, so we query via
 *   screen.* not container.*.
 * - user-event (not fireEvent) so the pointerdown/pointerup/click
 *   sequence matches what bits-ui's focus trap + outside-click logic
 *   expects.
 * - bits-ui Switch.Root carries role="switch" + data-state="checked"
 *   | "unchecked"; we assert against the attribute, not visual state.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import FeatureTogglesMenu from '$lib/components/FeatureTogglesMenu.svelte';
import type { FeatureCategoryEntry } from '$lib/types/api';

/** Test fixture mirroring what the layout server load ships to the client. */
const CATEGORIES: FeatureCategoryEntry[] = [
	{
		id: 'web',
		label: 'Web access',
		description: 'Lets the assistant search the web and fetch pages.',
		source: 'builtin',
	},
	{
		id: 'personalization',
		label: 'Personalization',
		description: 'Sends preferences + memory.',
		source: 'builtin',
	},
];

/** Same as CATEGORIES but with one connected MCP server added. */
const CATEGORIES_WITH_MCP: FeatureCategoryEntry[] = [
	...CATEGORIES,
	{
		id: 'mcp:filesystem',
		label: 'Filesystem',
		description: 'Tools from the "Filesystem" MCP server (2 tools).',
		source: 'mcp',
	},
];

/** Built-ins including the image-only enhancement toggle. */
const CATEGORIES_WITH_IMG: FeatureCategoryEntry[] = [
	...CATEGORIES,
	{
		id: 'image_prompt_enhancement',
		label: 'Image prompt enhancement',
		description: 'Rewrites your prompt for the target image model.',
		source: 'builtin',
	},
];

describe('FeatureTogglesMenu — trigger button', () => {
	it('renders with the expected aria-label', () => {
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: [], categories: CATEGORIES, onChange: vi.fn() },
		});
		expect(screen.getByLabelText('Feature toggles')).toBeInTheDocument();
	});

	it('has no off-state dot when all features are enabled', () => {
		const { container } = render(FeatureTogglesMenu, {
			props: { disabledFeatures: [], categories: CATEGORIES, onChange: vi.fn() },
		});
		expect(container.querySelector('.bg-warning')).toBeNull();
	});

	it('shows an off-state dot when any feature is disabled', () => {
		const { container } = render(FeatureTogglesMenu, {
			props: { disabledFeatures: ['web'], categories: CATEGORIES, onChange: vi.fn() },
		});
		expect(container.querySelector('.bg-warning')).toBeInTheDocument();
	});

	it('reflects the disabled prop on the trigger', () => {
		render(FeatureTogglesMenu, {
			props: {
				disabledFeatures: [],
				categories: CATEGORIES,
				onChange: vi.fn(),
				disabled: true,
			},
		});
		expect(screen.getByLabelText('Feature toggles')).toBeDisabled();
	});
});

describe('FeatureTogglesMenu — popover content', () => {
	it('opens on trigger click and renders a row per category', async () => {
		const user = userEvent.setup();
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: [], categories: CATEGORIES, onChange: vi.fn() },
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		for (const meta of CATEGORIES) {
			expect(screen.getByText(meta.label)).toBeInTheDocument();
			// The description now lives in an (i) hover/focus tooltip rather than
			// inline, so the row carries a labelled tooltip trigger, not the text.
			expect(screen.getByLabelText(`About ${meta.label}`)).toBeInTheDocument();
		}
	});

	it('renders an MCP category alongside the built-ins when present', async () => {
		const user = userEvent.setup();
		render(FeatureTogglesMenu, {
			props: {
				disabledFeatures: [],
				categories: CATEGORIES_WITH_MCP,
				onChange: vi.fn(),
			},
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		expect(screen.getByText('Filesystem')).toBeInTheDocument();
		expect(screen.getByRole('switch', { name: 'Filesystem' })).toHaveAttribute(
			'data-state',
			'checked',
		);
	});

	it('renders a switch per category, checked when its category is enabled', async () => {
		const user = userEvent.setup();
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: [], categories: CATEGORIES, onChange: vi.fn() },
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		for (const meta of CATEGORIES) {
			const sw = screen.getByRole('switch', { name: meta.label });
			expect(sw).toHaveAttribute('data-state', 'checked');
		}
	});

	it('switch reads as unchecked when its category is in disabledFeatures', async () => {
		const user = userEvent.setup();
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: ['web'], categories: CATEGORIES, onChange: vi.fn() },
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		const sw = screen.getByRole('switch', { name: 'Web access' });
		expect(sw).toHaveAttribute('data-state', 'unchecked');
	});
});

describe('FeatureTogglesMenu — model-kind filtering', () => {
	it('hides image_prompt_enhancement for a chat model, keeps the rest', async () => {
		const user = userEvent.setup();
		render(FeatureTogglesMenu, {
			props: {
				disabledFeatures: [],
				categories: CATEGORIES_WITH_IMG,
				modelKind: 'chat',
				onChange: vi.fn(),
			},
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		expect(screen.queryByText('Image prompt enhancement')).toBeNull();
		expect(screen.getByText('Web access')).toBeInTheDocument();
	});

	it('shows image_prompt_enhancement for an image model', async () => {
		const user = userEvent.setup();
		render(FeatureTogglesMenu, {
			props: {
				disabledFeatures: [],
				categories: CATEGORIES_WITH_IMG,
				modelKind: 'image',
				onChange: vi.fn(),
			},
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		expect(screen.getByText('Image prompt enhancement')).toBeInTheDocument();
	});

	it('shows everything when the model kind is unknown (prop omitted)', async () => {
		const user = userEvent.setup();
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: [], categories: CATEGORIES_WITH_IMG, onChange: vi.fn() },
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		expect(screen.getByText('Image prompt enhancement')).toBeInTheDocument();
	});
});

describe('FeatureTogglesMenu — toggle callbacks', () => {
	it('calls onChange with the new disabled list when a checked switch is clicked', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: [], categories: CATEGORIES, onChange },
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		await user.click(screen.getByRole('switch', { name: 'Web access' }));
		expect(onChange).toHaveBeenCalledWith(['web']);
	});

	it('calls onChange with the category removed when an unchecked switch is clicked', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: ['web'], categories: CATEGORIES, onChange },
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		await user.click(screen.getByRole('switch', { name: 'Web access' }));
		expect(onChange).toHaveBeenCalledWith([]);
	});

	it('calls onChange with the MCP category added when its switch is toggled off', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: [], categories: CATEGORIES_WITH_MCP, onChange },
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		await user.click(screen.getByRole('switch', { name: 'Filesystem' }));
		expect(onChange).toHaveBeenCalledWith(['mcp:filesystem']);
	});
});
