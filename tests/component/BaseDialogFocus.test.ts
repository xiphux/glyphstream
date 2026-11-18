/**
 * BaseDialog declares `aria-modal`, so it has to behave like a modal for the
 * keyboard too: focus moves in when it opens, Tab stays inside, and focus goes
 * back to what had it when it closes. Driven through ConfirmDialog, the
 * shell's most common consumer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
import { confirmDialog } from '#lib/confirm.svelte.js';

let trigger: HTMLButtonElement | null = null;

afterEach(() => {
	if (confirmDialog.pending) confirmDialog.cancel();
	trigger?.remove();
	trigger = null;
});

async function openFrom(): Promise<HTMLButtonElement> {
	trigger = document.createElement('button');
	trigger.textContent = 'Delete thing';
	document.body.appendChild(trigger);
	trigger.focus();
	render(ConfirmDialog);
	void confirmDialog.ask({ title: 'Delete this?', message: 'Gone.' });
	await tick();
	return trigger;
}

describe('BaseDialog focus', () => {
	it('moves focus to Cancel when a confirm dialog opens', async () => {
		await openFrom();
		const dialog = screen.getByRole('alertdialog');
		expect(dialog.contains(document.activeElement)).toBe(true);
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
	});

	it('keeps Tab inside the dialog', async () => {
		const user = userEvent.setup();
		await openFrom();
		const cancel = screen.getByRole('button', { name: 'Cancel' });
		const del = screen.getByRole('button', { name: 'Delete' });

		await user.tab();
		expect(document.activeElement).toBe(del);
		await user.tab();
		expect(document.activeElement).toBe(cancel);
		await user.tab({ shift: true });
		expect(document.activeElement).toBe(del);
	});

	it('returns focus to the trigger on cancel', async () => {
		const user = userEvent.setup();
		const t = await openFrom();
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		await tick();
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(document.activeElement).toBe(t);
	});
});
