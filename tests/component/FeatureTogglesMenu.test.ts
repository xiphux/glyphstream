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
import { FEATURE_CATEGORIES, FEATURE_CATEGORY_LABELS } from '$lib/types/api';

describe('FeatureTogglesMenu — trigger button', () => {
	it('renders with the expected aria-label', () => {
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: [], onChange: vi.fn() }
		});
		expect(screen.getByLabelText('Feature toggles')).toBeInTheDocument();
	});

	it('has no off-state dot when all features are enabled', () => {
		const { container } = render(FeatureTogglesMenu, {
			props: { disabledFeatures: [], onChange: vi.fn() }
		});
		expect(container.querySelector('.bg-amber-500')).toBeNull();
	});

	it('shows an off-state dot when any feature is disabled', () => {
		const { container } = render(FeatureTogglesMenu, {
			props: { disabledFeatures: ['web'], onChange: vi.fn() }
		});
		expect(container.querySelector('.bg-amber-500')).toBeInTheDocument();
	});

	it('reflects the disabled prop on the trigger', () => {
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: [], onChange: vi.fn(), disabled: true }
		});
		expect(screen.getByLabelText('Feature toggles')).toBeDisabled();
	});
});

describe('FeatureTogglesMenu — popover content', () => {
	it('opens on trigger click and renders a row per FEATURE_CATEGORIES entry', async () => {
		const user = userEvent.setup();
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: [], onChange: vi.fn() }
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		for (const category of FEATURE_CATEGORIES) {
			const meta = FEATURE_CATEGORY_LABELS[category];
			expect(screen.getByText(meta.label)).toBeInTheDocument();
			expect(screen.getByText(meta.description)).toBeInTheDocument();
		}
	});

	it('renders a switch per category, checked when its category is enabled', async () => {
		const user = userEvent.setup();
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: [], onChange: vi.fn() }
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		for (const category of FEATURE_CATEGORIES) {
			const meta = FEATURE_CATEGORY_LABELS[category];
			const sw = screen.getByRole('switch', { name: meta.label });
			expect(sw).toHaveAttribute('data-state', 'checked');
		}
	});

	it('switch reads as unchecked when its category is in disabledFeatures', async () => {
		const user = userEvent.setup();
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: ['web'], onChange: vi.fn() }
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		const sw = screen.getByRole('switch', { name: 'Web access' });
		expect(sw).toHaveAttribute('data-state', 'unchecked');
	});
});

describe('FeatureTogglesMenu — toggle callbacks', () => {
	it('calls onChange with the new disabled list when a checked switch is clicked', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: [], onChange }
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		await user.click(screen.getByRole('switch', { name: 'Web access' }));
		expect(onChange).toHaveBeenCalledWith(['web']);
	});

	it('calls onChange with the category removed when an unchecked switch is clicked', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(FeatureTogglesMenu, {
			props: { disabledFeatures: ['web'], onChange }
		});
		await user.click(screen.getByLabelText('Feature toggles'));
		await user.click(screen.getByRole('switch', { name: 'Web access' }));
		expect(onChange).toHaveBeenCalledWith([]);
	});
});
