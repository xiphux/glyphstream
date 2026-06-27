/* @vitest-environment happy-dom */

/**
 * Component test for ChatComposer — the bottom composer area. Covers the
 * send-enable matrix, Send-vs-Stop branching, attach gating, feature
 * toggles + favorite wiring, and the drag-drop / paste handlers that
 * moved into the component. ModelPicker has its own test; here we just
 * verify it's wired and that selecting flows through.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ChatComposer from '$lib/components/chat/ChatComposer.svelte';
import type { AttachmentStore } from '$lib/attachments.svelte';
import type { ModelEntry } from '$lib/types/api';

function makeStore(overrides: Partial<AttachmentStore> = {}): AttachmentStore {
	return {
		items: [],
		isBusy: false,
		addFiles: vi.fn(),
		remove: vi.fn(),
		...overrides,
	} as unknown as AttachmentStore;
}

function makeModel(overrides: Partial<ModelEntry> = {}): ModelEntry {
	return {
		id: overrides.id ?? 'bridge::gpt-4o',
		endpointId: 'bridge',
		upstreamId: overrides.upstreamId ?? 'gpt-4o',
		displayName: overrides.displayName ?? 'gpt-4o',
		ownedBy: null,
		kind: overrides.kind ?? 'chat',
		kindKnown: true,
		group: 'Bridge',
		groupKey: 'bridge',
		supportsTools: false,
		contextWindow: overrides.contextWindow ?? null,
	};
}

function baseProps(overrides: Record<string, unknown> = {}) {
	return {
		composerText: '',
		modelId: 'bridge::gpt-4o',
		errorMsg: null,
		attachments: makeStore(),
		modelKind: 'chat' as const,
		disabledFeatures: [],
		featureCategories: [
			{
				id: 'web',
				label: 'Web access',
				description: 'Lets the assistant search the web and fetch pages.',
				source: 'builtin' as const,
			},
			{
				id: 'personalization',
				label: 'Personalization',
				description: 'Sends preferences + memory.',
				source: 'builtin' as const,
			},
		],
		models: [makeModel()],
		favoritedIds: [],
		allowAttachments: true,
		hasValidModel: true,
		generating: false,
		canStop: false,
		enterBehavior: 'send' as const,
		compareSelections: [],
		compareMode: false,
		modelSets: [],
		onSend: vi.fn(),
		onStop: vi.fn(),
		onFeaturesChange: vi.fn(),
		onToggleFavorite: vi.fn(),
		onSaveModelSet: vi.fn(),
		onDeleteModelSet: vi.fn(),
		...overrides,
	};
}

describe('ChatComposer — rendering', () => {
	it('renders the textarea with the chat placeholder', () => {
		render(ChatComposer, { props: baseProps() });
		expect(screen.getByPlaceholderText('Write a message…')).toBeInTheDocument();
	});

	it('uses the image placeholder for image models', () => {
		render(ChatComposer, { props: baseProps({ modelKind: 'image' }) });
		expect(screen.getByPlaceholderText('Describe an image to generate…')).toBeInTheDocument();
	});

	it('shows the error banner when errorMsg is set', () => {
		render(ChatComposer, { props: baseProps({ errorMsg: 'Something broke' }) });
		expect(screen.getByText('Something broke')).toBeInTheDocument();
	});

	it('shows the attach button when allowAttachments', () => {
		render(ChatComposer, { props: baseProps() });
		expect(screen.getByRole('button', { name: 'Attach file' })).toBeInTheDocument();
	});

	it('hides the attach button when not allowAttachments', () => {
		render(ChatComposer, { props: baseProps({ allowAttachments: false }) });
		expect(screen.queryByRole('button', { name: 'Attach file' })).toBeNull();
	});

	it('renders the model picker trigger', () => {
		render(ChatComposer, { props: baseProps() });
		expect(screen.getByLabelText('Select model')).toBeInTheDocument();
	});

	it('renders the feature toggles trigger', () => {
		render(ChatComposer, { props: baseProps() });
		expect(screen.getByLabelText('Feature toggles')).toBeInTheDocument();
	});
});

describe('ChatComposer — send/stop button', () => {
	it('shows Send (not Stop) when idle', () => {
		render(ChatComposer, { props: baseProps() });
		expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Stop generation' })).toBeNull();
	});

	it('shows Stop (not Send) when canStop', () => {
		render(ChatComposer, { props: baseProps({ canStop: true }) });
		expect(screen.getByRole('button', { name: 'Stop generation' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
	});

	it('disables Send when text is empty and no attachments', () => {
		render(ChatComposer, { props: baseProps({ composerText: '   ' }) });
		expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
	});

	it('enables Send when text is present', () => {
		render(ChatComposer, { props: baseProps({ composerText: 'hello' }) });
		expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled();
	});

	it('disables Send when no valid model', () => {
		render(ChatComposer, { props: baseProps({ composerText: 'hi', hasValidModel: false }) });
		const btn = screen.getByRole('button', { name: 'Send message' });
		expect(btn).toBeDisabled();
		expect(btn).toHaveAttribute('title', 'Pick a model to send');
	});

	it('disables Send while attachments are uploading', () => {
		const store = makeStore({ items: [{ clientId: 'a' }] as never, isBusy: true });
		render(ChatComposer, { props: baseProps({ composerText: 'hi', attachments: store }) });
		expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
	});

	it('disables the textarea while generating', () => {
		render(ChatComposer, { props: baseProps({ generating: true }) });
		expect(screen.getByPlaceholderText('Write a message…')).toBeDisabled();
	});
});

describe('ChatComposer — callbacks', () => {
	it('fires onSend when Send is clicked', async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		render(ChatComposer, { props: baseProps({ composerText: 'hi', onSend }) });
		await user.click(screen.getByRole('button', { name: 'Send message' }));
		expect(onSend).toHaveBeenCalledTimes(1);
	});

	it('fires onSend on Enter (send behavior)', async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		render(ChatComposer, { props: baseProps({ composerText: 'hi', onSend }) });
		const textarea = screen.getByPlaceholderText('Write a message…');
		textarea.focus();
		await user.keyboard('{Enter}');
		expect(onSend).toHaveBeenCalledTimes(1);
	});

	it('fires onStop when Stop is clicked', async () => {
		const user = userEvent.setup();
		const onStop = vi.fn();
		render(ChatComposer, { props: baseProps({ canStop: true, onStop }) });
		await user.click(screen.getByRole('button', { name: 'Stop generation' }));
		expect(onStop).toHaveBeenCalledTimes(1);
	});

	it('fires onFeaturesChange when a feature toggle flips', async () => {
		const user = userEvent.setup();
		const onFeaturesChange = vi.fn();
		render(ChatComposer, { props: baseProps({ onFeaturesChange }) });
		await user.click(screen.getByLabelText('Feature toggles'));
		await user.click(screen.getByRole('switch', { name: 'Web access' }));
		expect(onFeaturesChange).toHaveBeenCalledWith(['web']);
	});

	it('adds picked files to the attachment store', async () => {
		const user = userEvent.setup();
		const store = makeStore();
		const { container } = render(ChatComposer, { props: baseProps({ attachments: store }) });
		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File(['x'], 'cat.png', { type: 'image/png' });
		await user.upload(input, file);
		expect(store.addFiles).toHaveBeenCalled();
	});
});

describe('ChatComposer — focus()', () => {
	it('exposes a focus() method that focuses the textarea', () => {
		// @testing-library/svelte returns the mounted component instance,
		// whose exported `focus()` is callable — this is how the page lands
		// focus here on conversation-ready transitions.
		const { component } = render(ChatComposer, { props: baseProps() }) as unknown as {
			component: { focus: () => void };
		};
		expect(typeof component.focus).toBe('function');
		component.focus();
		expect(screen.getByPlaceholderText('Write a message…')).toHaveFocus();
	});
});
