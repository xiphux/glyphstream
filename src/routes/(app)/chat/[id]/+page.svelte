<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import {
		AlertCircle,
		ArrowDown,
		ArrowUp,
		Check,
		ChevronLeft,
		ChevronRight,
		Copy,
		Pencil,
		Plus,
		RotateCcw,
		Square,
		Trash2,
		X
	} from 'lucide-svelte';
	import { preferredFirstName } from '$lib/greeting';
	import { renderLiveMarkdown } from '$lib/markdown-live';
	import { readSSE } from '$lib/sse-client';
	import { AttachmentStore, attachmentsAllowedFor } from '$lib/attachments.svelte';
	import { composerEnterHandler } from '$lib/composer-keys';
	import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
	import MediaLightbox from '$lib/components/MediaLightbox.svelte';
	import { toast } from '$lib/toast.svelte';
	import type { MediaListItem } from '$lib/server/db/queries/media';
	import type {
		ChatMessage,
		MessagePart,
		ModelKind,
		SendMessageResponse,
		StreamEvent
	} from '$lib/types/api';

	let { data } = $props();

	// Friendly bubble labels: the user's preferred name (Preferences ▸ Name
	// if set, else GitHub display name's first token, else login) +
	// the model's friendly name (server resolves custom-model name).
	const userLabel = $derived(
		preferredFirstName(
			data.prefs?.name,
			data.user.displayName,
			data.user.githubUsername
		)
	);
	const assistantLabel = $derived(data.assistantLabel);

	// Read data eagerly so SSR includes messages on first paint; $effect
	// below re-syncs on subsequent navigation invalidation. The warning
	// about capturing the initial value is intentional here — that IS the
	// behavior we want.
	// svelte-ignore state_referenced_locally
	let messages = $state<ChatMessage[]>(data.conversation.messages);
	// svelte-ignore state_referenced_locally
	let title = $state<string | null>(data.conversation.title);
	// svelte-ignore state_referenced_locally
	let modelId = $state(data.conversation.modelId);
	// svelte-ignore state_referenced_locally
	let convId = $state(data.conversation.id);
	// svelte-ignore state_referenced_locally
	let modelKind = $state<ModelKind | null>(data.conversation.modelKind);

	$effect(() => {
		messages = data.conversation.messages;
		title = data.conversation.title;
		modelId = data.conversation.modelId;
		convId = data.conversation.id;
		modelKind = data.conversation.modelKind;
	});

	// Per-turn picker re-binds modelId; whenever the user picks a different
	// model, derive the new modelKind from data.models so the composer's
	// modality-driven affordances (placeholder, attachment allowance) update.
	// If the new model doesn't permit attachments, drop any in-flight ones —
	// otherwise the user could ship an upload that the new model rejects.
	// untrack the actions so this effect's dep set stays as just (modelId).
	$effect(() => {
		void modelId;
		const next = data.models.find((m) => m.id === modelId);
		if (!next) return;
		untrack(() => {
			modelKind = next.kind;
			if (!attachmentsAllowedFor(next.kind) && attachments.items.length > 0) {
				attachments.clear();
			}
		});
	});

	let composerText = $state('');
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);
	let scrollContainer = $state<HTMLElement | null>(null);

	// Per-page attachment store. The store eagerly POSTs to /api/uploads
	// as files are picked, so by send-time `readyMediaIds()` is just a
	// state read. See $lib/attachments.svelte.ts.
	const attachments = new AttachmentStore();
	let fileInputEl = $state<HTMLInputElement | null>(null);
	const allowAttachments = $derived(attachmentsAllowedFor(modelKind));
	// Imported OWUI conversations land with a stored modelId like "gpt-4o"
	// (no endpoint:: prefix), which the picker shows as "Choose a model…".
	// Without this gate the user could type+submit and the server would 500
	// on `parseModelId(...) === null`. Gating the submit means the picker
	// is the obvious next step.
	const hasValidModel = $derived(data.models.some((m) => m.id === modelId));
	onDestroy(() => attachments.destroy());

	// Auto-attach last generated image for I2I follow-ups: when the
	// conversation's most recent assistant turn produced an image, pre-
	// populate the composer with that image as a starting attachment so
	// "make her shirt blue" / "remove the background" turns Just Work
	// without re-uploading. The user can dismiss with the same X they'd
	// use on any attachment.
	//
	// `autoAttachedFor` records which assistant id we've already
	// auto-attached for, so dismissing the auto-attach sticks for that
	// turn (we don't keep re-adding it on every reactive re-run).
	let autoAttachedFor = $state<string | null>(null);

	// Reset composer state when navigating between conversations — without
	// this the previous chat's attachments (and its auto-attach memory)
	// would carry into the new one.
	$effect(() => {
		void data.conversation.id;
		attachments.clear();
		autoAttachedFor = null;
	});

	$effect(() => {
		if (modelKind !== 'image') return;
		// Only auto-attach when the composer is empty — a manual pick
		// always takes precedence.
		if (attachments.items.length > 0) return;
		// Walk from the leaf back to find the most recent assistant
		// message that has an image part.
		const lastAssistant = [...messages]
			.reverse()
			.find((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'image'));
		if (!lastAssistant) return;
		if (lastAssistant.id === autoAttachedFor) return;
		const imagePart = lastAssistant.parts.find((p) => p.type === 'image');
		if (!imagePart || imagePart.type !== 'image') return;
		attachments.attachExisting(imagePart.mediaId);
		autoAttachedFor = lastAssistant.id;
	});

	// --- inline image lightbox --------------------------------------------
	//
	// Tapping a generated image used to open it in a new tab (target=_blank
	// on the wrapping anchor). That works on desktop but breaks in PWA
	// standalone mode where there's no tab strip to return through — users
	// got stranded on a bare image page with only a back-swipe gesture
	// home. Reusing the gallery's MediaLightbox keeps the tap inside the
	// app and brings model/prompt/download affordances along for free.
	//
	// MessagePart only carries `mediaId`; model + prompt + size live on
	// the media row. One fetch per tap (~100-200ms) populates the metadata.
	// The fetch races are guarded by the id-comparison pattern: a stale
	// response from a previous tap can't clobber the current state.
	let lightbox = $state<MediaListItem | null>(null);
	let openingLightboxFor = $state<string | null>(null);

	async function openImageInLightbox(mediaId: string) {
		if (openingLightboxFor === mediaId) return;
		openingLightboxFor = mediaId;
		try {
			const res = await fetch(`/api/media/${mediaId}`);
			if (!res.ok) throw new Error(`Server returned ${res.status}`);
			const m = (await res.json()) as MediaListItem;
			if (openingLightboxFor === mediaId) lightbox = m;
		} catch (e) {
			if (openingLightboxFor === mediaId) {
				toast.error(
					`Couldn't load image details: ${e instanceof Error ? e.message : String(e)}`
				);
			}
		} finally {
			if (openingLightboxFor === mediaId) openingLightboxFor = null;
		}
	}

	// --- drag-drop + paste-from-clipboard ---------------------------------
	//
	// Both desktop niceties; mobile users use the file picker (touch
	// devices generally can't drag from OS shells, and paste UX is rare).
	// Both feed into the same `attachments.addFiles()` pipeline as the
	// file picker, so they get the same upload/progress/error UX for
	// free.
	let isDraggingOver = $state(false);
	// Drag-enter/leave fires recursively as the cursor moves over child
	// elements within the drop zone. The counter pattern handles this
	// without needing relatedTarget detection (which is fragile across
	// browsers with shadow DOM / iframes).
	let dragDepth = 0;

	function dragHasFiles(e: DragEvent): boolean {
		return Array.from(e.dataTransfer?.types ?? []).includes('Files');
	}

	function onDragEnter(e: DragEvent) {
		if (!allowAttachments || !dragHasFiles(e)) return;
		e.preventDefault();
		dragDepth++;
		isDraggingOver = true;
	}

	function onDragOver(e: DragEvent) {
		if (!allowAttachments || !dragHasFiles(e)) return;
		// preventDefault on dragover is what enables drop. Without it, the
		// browser interprets the drag as "not droppable" and the drop
		// event never fires.
		e.preventDefault();
	}

	function onDragLeave(e: DragEvent) {
		if (!allowAttachments || !dragHasFiles(e)) return;
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) isDraggingOver = false;
	}

	function onDrop(e: DragEvent) {
		if (!allowAttachments) return;
		e.preventDefault();
		dragDepth = 0;
		isDraggingOver = false;
		const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
			f.type.startsWith('image/')
		);
		if (files.length > 0) {
			void attachments.addFiles(files);
		}
	}

	function onPaste(e: ClipboardEvent) {
		if (!allowAttachments) return;
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (const item of items) {
			if (item.kind === 'file' && item.type.startsWith('image/')) {
				const f = item.getAsFile();
				if (f) files.push(f);
			}
		}
		if (files.length > 0) {
			// Only swallow the paste when we actually consumed an image.
			// Plain-text pastes fall through to the textarea's default
			// behavior so typing-flow isn't disrupted.
			e.preventDefault();
			void attachments.addFiles(files);
		}
	}

	// Scroll-to-bottom affordance: shows a floating button just above the
	// composer when the user has scrolled meaningfully away from the latest
	// message. Same flag also gates the streaming auto-scroll so we don't
	// yank the user back down while they're reading older messages.
	//
	// Implemented with an IntersectionObserver watching a 1px sentinel
	// element pinned to the bottom of the message list. The 100px
	// rootMargin on the bottom edge gives us the "near bottom" tolerance
	// — the observer fires "intersecting" when the sentinel is within
	// 100px of the visible viewport. Way cheaper than recomputing scroll
	// math on every onscroll event, and the browser typically runs the
	// observation off the main thread.
	let isNearBottom = $state(true);
	let bottomSentinel = $state<HTMLElement | null>(null);
	$effect(() => {
		const sentinel = bottomSentinel;
		const root = scrollContainer;
		if (!sentinel || !root) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				isNearBottom = entry.isIntersecting;
			},
			{ root, rootMargin: '0px 0px 100px 0px', threshold: 0 }
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	});

	// Auto-resize textarea: grow with content up to a sensible max so
	// long-form composition gets the room it needs without pushing the
	// message list off-screen on small phones.
	let composerEl = $state<HTMLTextAreaElement | null>(null);
	const COMPOSER_MAX_HEIGHT_PX = 240;
	$effect(() => {
		const el = composerEl;
		void composerText; // re-run on every keystroke
		if (!el) return;
		// Reset to "auto" first so scrollHeight reflects the content's
		// natural height instead of a previously-set larger value.
		el.style.height = 'auto';
		const next = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
		el.style.height = `${next}px`;
		el.style.overflowY = el.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden';
	});

	// AbortController for the in-flight fetch. Stop button click triggers
	// .abort() AND fires a POST to /api/conversations/:id/cancel so the
	// server tears down upstream too (otherwise the bridge keeps generating).
	let activeAbort = $state<AbortController | null>(null);

	// In-flight assistant render state. While streaming we show a transient
	// "assistant" bubble that isn't yet a row in the messages array; on `done`
	// we splice the canonical persisted ChatMessage into messages.
	let inFlightText = $state('');
	let inFlightReasoning = $state('');
	let inFlightOpen = $state(false);
	let inFlightProgress = $state<number | null>(null);
	let inFlightStatus = $state<string | null>(null);
	const inFlightHtml = $derived(renderLiveMarkdown(inFlightText));

	// Tick a timer while the in-flight bubble is open so the user gets a
	// progress signal for slow operations (image generation, video gen) and
	// also for chat round-trips that stall before the first token.
	let elapsedSeconds = $state(0);
	$effect(() => {
		if (!inFlightOpen) {
			elapsedSeconds = 0;
			return;
		}
		const startedAt = Date.now();
		elapsedSeconds = 0;
		const interval = setInterval(() => {
			elapsedSeconds = (Date.now() - startedAt) / 1000;
		}, 100);
		return () => clearInterval(interval);
	});

	const inFlightLabel = $derived(
		modelKind === 'image'
			? 'Generating image'
			: modelKind === 'video'
				? 'Generating video'
				: 'Thinking'
	);

	/**
	 * Build a placeholder user message rendered optimistically so the
	 * bubble appears the moment the user hits Send, before the upstream
	 * call (which can take seconds for chat, minutes for image/video)
	 * has had a chance to come back. The canonical persisted message
	 * replaces it on the SSE 'start' event (chat/video) or in the JSON
	 * response handler (image).
	 *
	 * The temp id is prefixed `optimistic-` so any code that compares
	 * by id (replacement, removal, error recovery) can recognize it.
	 */
	function buildOptimisticUserMessage(
		text: string,
		attachedMediaIds: string[]
	): ChatMessage {
		const parts: MessagePart[] = [];
		if (text) parts.push({ type: 'text', text });
		for (const mediaId of attachedMediaIds) {
			parts.push({ type: 'image', mediaId });
		}
		return {
			id: `optimistic-${crypto.randomUUID()}`,
			role: 'user',
			parts,
			contentHtml: null,
			reasoningText: null,
			finishReason: null,
			modelUsed: null,
			tokensIn: null,
			tokensOut: null,
			createdAt: Date.now()
		};
	}

	interface SendOptions {
		/** Edit flow — make the new user message a sibling of this parent. */
		parentMessageId?: string;
		/** Edit flow — id of the message being replaced. Used to trim the
		 * old branch's continuation out of the visible list at optimistic-
		 * insert time, so the new in-flight bubble doesn't briefly stream
		 * BELOW the previous branch's stale tail. Symmetric counterpart
		 * to retry's `retryFromMessageId` slice. */
		editedMessageId?: string;
		/** Retry flow — skip the new user message entirely; regenerate
		 * a sibling assistant of this id. */
		retryFromMessageId?: string;
	}

	async function sendStreaming(
		text: string,
		attachedMediaIds: string[] = [],
		options: SendOptions = {}
	) {
		busy = true;
		errorMsg = null;
		inFlightText = '';
		inFlightReasoning = '';
		inFlightProgress = null;
		inFlightStatus = null;

		// For send / edit: render an optimistic user bubble. For retry:
		// the user message already exists, so skip — but DO trim the
		// retry target (and any descendants on the active branch) out of
		// the visible list so the in-flight bubble visually takes the
		// retried message's slot. Otherwise the user briefly sees the
		// old response above the streaming new one ("assistant replied
		// twice" effect) until invalidateAll runs after 'done'.
		const isRetry = !!options.retryFromMessageId;
		let optimisticId: string | null = null;
		if (isRetry) {
			const retryIdx = messages.findIndex((m) => m.id === options.retryFromMessageId);
			if (retryIdx >= 0) messages = messages.slice(0, retryIdx);
		} else {
			// Edit case: trim everything from the edited message onward so
			// the new optimistic bubble visually replaces it. Without this
			// the old branch's [B, C, D, E] would still be rendered above
			// the in-flight bubble, making it look like a new message at
			// the end of the conversation instead of a sibling replacing B.
			if (options.editedMessageId) {
				const editIdx = messages.findIndex((m) => m.id === options.editedMessageId);
				if (editIdx >= 0) messages = messages.slice(0, editIdx);
			}
			const opt = buildOptimisticUserMessage(text, attachedMediaIds);
			messages = [...messages, opt];
			optimisticId = opt.id;
			await tick();
			scrollToBottom();
		}
		inFlightOpen = true;

		// Image-kind conversations use the sync JSON path — there's nothing
		// to stream (one-shot generate). Chat and video both stream via SSE
		// (chat for tokens, video for poll-based progress events).
		if (modelKind === 'image') {
			await sendImageGeneration(text, attachedMediaIds, optimisticId, options);
			return;
		}

		const abort = new AbortController();
		activeAbort = abort;
		try {
			// Always include modelId / modelKind — server cheaply no-ops when
			// they match the conversation's stored values, so this stays
			// simple (no client-side dirty tracking) and the server is the
			// single source of truth on "did the user switch?".
			const requestBody = isRetry
				? { regenerateFromMessageId: options.retryFromMessageId, modelId, modelKind }
				: {
						text,
						attachedMediaIds,
						modelId,
						modelKind,
						...(options.parentMessageId ? { parentMessageId: options.parentMessageId } : {})
					};
			const res = await fetch(`/api/conversations/${convId}/messages?stream=1`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'text/event-stream'
				},
				body: JSON.stringify(requestBody),
				signal: abort.signal
			});
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.message ?? `HTTP ${res.status}`);
			}
			if (!res.body) throw new Error('Server returned no body');

			for await (const rec of readSSE(res.body)) {
				let event: StreamEvent;
				try {
					event = JSON.parse(rec.data) as StreamEvent;
				} catch {
					continue;
				}
				switch (event.type) {
					case 'start':
						// Send / edit: replace the optimistic placeholder with
						// the canonical persisted user message. Retry: the
						// canonical user message already exists in the array
						// (it predates this turn) so we just no-op here.
						if (optimisticId) {
							messages = messages.some((m) => m.id === optimisticId)
								? messages.map((m) => (m.id === optimisticId ? event.userMessage : m))
								: [...messages, event.userMessage];
							await tick();
							scrollToBottom();
						}
						break;
					case 'text':
						inFlightText += event.chunk;
						// Streaming auto-scrolls only follow the user if they're
						// already at/near the bottom. Lets them scroll up to read
						// history mid-stream without getting yanked back.
						if (isNearBottom) scrollToBottom();
						break;
					case 'reasoning':
						inFlightReasoning += event.chunk;
						if (isNearBottom) scrollToBottom();
						break;
					case 'progress':
						inFlightProgress = event.percent;
						inFlightStatus = event.status ?? null;
						break;
					case 'done':
						messages = [...messages, event.assistantMessage];
						inFlightOpen = false;
						inFlightText = '';
						inFlightReasoning = '';
						inFlightProgress = null;
						inFlightStatus = null;
						break;
					case 'error':
						errorMsg = event.message;
						inFlightOpen = false;
						inFlightProgress = null;
						inFlightStatus = null;
						break;
				}
			}
			void invalidateAll();
		} catch (e) {
			// AbortError from clicking Stop is expected — don't surface as
			// a user-facing error. The server-side recorder will have committed
			// whatever partial text it had; invalidateAll picks that up.
			if (isAbortError(e)) {
				void invalidateAll();
			} else {
				errorMsg = e instanceof Error ? e.message : String(e);
			}
			inFlightOpen = false;
		} finally {
			busy = false;
			activeAbort = null;
		}
	}

	async function sendImageGeneration(
		text: string,
		attachedMediaIds: string[] = [],
		optimisticId: string | null = null,
		options: SendOptions = {}
	) {
		const abort = new AbortController();
		activeAbort = abort;
		const isRetry = !!options.retryFromMessageId;
		try {
			// Same all-paths shape as the streaming dispatch above — see
			// that branch for why we always send modelId/modelKind.
			const requestBody = isRetry
				? { regenerateFromMessageId: options.retryFromMessageId, modelId, modelKind }
				: {
						text,
						attachedMediaIds,
						modelId,
						modelKind,
						...(options.parentMessageId ? { parentMessageId: options.parentMessageId } : {})
					};
			const res = await fetch(`/api/conversations/${convId}/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody),
				signal: abort.signal
			});
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.message ?? `HTTP ${res.status}`);
			}
			const body = (await res.json()) as SendMessageResponse;
			// Send / edit: drop optimistic, then append both canonical rows.
			// Retry: only append the new assistant — the user message
			// already exists in the array.
			if (isRetry) {
				messages = [...messages, body.assistantMessage];
			} else {
				messages = (
					optimisticId ? messages.filter((m) => m.id !== optimisticId) : messages
				).concat([body.userMessage, body.assistantMessage]);
			}
			inFlightOpen = false;
			void invalidateAll();
		} catch (e) {
			if (isAbortError(e)) {
				void invalidateAll();
			} else {
				errorMsg = e instanceof Error ? e.message : String(e);
			}
			inFlightOpen = false;
		} finally {
			busy = false;
			activeAbort = null;
		}
	}

	async function stop() {
		const abort = activeAbort;
		if (!abort) return;
		// Tell the server to tear down upstream first (so the bridge stops
		// generating instead of running to completion). Then abort the local
		// fetch so we stop receiving the in-flight events.
		try {
			await fetch(`/api/conversations/${convId}/cancel`, { method: 'POST' });
		} catch {
			// Best-effort — even if the cancel POST fails, aborting locally
			// still gives the user the "stopped" UX.
		}
		abort.abort();
	}

	function isAbortError(e: unknown): boolean {
		if (e instanceof DOMException && e.name === 'AbortError') return true;
		if (e instanceof Error && e.name === 'AbortError') return true;
		return false;
	}

	async function send(e: Event) {
		e.preventDefault();
		const text = composerText.trim();
		if ((!text && attachments.items.length === 0) || busy) return;
		if (attachments.isBusy) return;
		const attachedMediaIds = attachments.readyMediaIds();
		// Editing: send the new message as a sibling under the same parent
		// as the original. The original stays in the DB as an alt branch.
		const editParent = editingParentId;
		composerText = '';
		attachments.clear();
		editingMessageId = null;
		editingParentId = null;
		await sendStreaming(
			text,
			attachedMediaIds,
			editParent ? { parentMessageId: editParent } : {}
		);
	}

	/**
	 * Scroll the message viewport to the latest content.
	 *
	 * `smooth: true` for user-triggered scrolls (the floating button); the
	 * gentle animation gives them feedback that something happened.
	 *
	 * `smooth: false` (default) for the streaming auto-scroll path — instant
	 * scrolling keeps up with arriving tokens without lagging behind. A
	 * smooth scroll during streaming would visibly chase the bottom edge.
	 */
	function scrollToBottom(opts?: { smooth?: boolean }) {
		const el = scrollContainer;
		if (!el) return;
		if (opts?.smooth) {
			el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
		} else {
			el.scrollTop = el.scrollHeight;
		}
	}

	// Auto-scroll on new content, but only if the user is already near the
	// bottom. If they've scrolled up to read history, leave them alone — the
	// floating button gives them an explicit way to rejoin the latest.
	//
	// `untrack(isNearBottom)` is load-bearing here: without it, the effect
	// would also re-run every time the user's scroll position crossed the
	// 100px threshold (because reading `isNearBottom` would track it),
	// causing a snap-to-bottom mid-scroll the moment the observer flipped
	// the flag true. We only want this effect to fire on actual content
	// changes — messages added or new tokens streaming in.
	$effect(() => {
		void messages.length;
		void inFlightText;
		if (!untrack(() => isNearBottom)) return;
		void tick().then(() => scrollToBottom());
	});

	// First-message handoff from /(app)/+page.svelte: when the new-chat page
	// creates a conversation, it stashes the first message in sessionStorage
	// and navigates here so the response can stream in this page's lifecycle.
	// Payload is JSON-encoded {text, attachedMediaIds[]} so attachments
	// picked on the new-chat page travel into the first send. The bare-string
	// branch keeps backwards compat with any in-flight tabs from before the
	// JSON shape — safe to delete a release or two from now.
	let bootstrapped = $state(false);
	$effect(() => {
		if (bootstrapped || typeof window === 'undefined' || busy) return;
		const key = `glyphstream:pendingFirstMessage:${convId}`;
		const pending = window.sessionStorage.getItem(key);
		if (pending) {
			window.sessionStorage.removeItem(key);
			bootstrapped = true;
			let pendingText = pending;
			let pendingMediaIds: string[] = [];
			try {
				const parsed = JSON.parse(pending) as unknown;
				if (parsed && typeof parsed === 'object' && 'text' in parsed) {
					pendingText = String((parsed as { text: unknown }).text ?? '');
					const ids = (parsed as { attachedMediaIds?: unknown }).attachedMediaIds;
					if (Array.isArray(ids)) {
						pendingMediaIds = ids.filter((s): s is string => typeof s === 'string');
					}
				}
			} catch {
				// Old format — pending was already plain text.
			}
			void sendStreaming(pendingText, pendingMediaIds);
		}
	});

	function partsToText(parts: MessagePart[]): string {
		return parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
	}

	// Copy-to-clipboard. Tracks the most recently copied message id so the
	// trigger icon can briefly swap to a check mark as feedback. We use a
	// single id slot rather than a per-message map because only one copy
	// confirmation is on screen at a time.
	let recentlyCopiedId = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	async function copyMessage(m: ChatMessage) {
		const text = partsToText(m.parts);
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			recentlyCopiedId = m.id;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => {
				if (recentlyCopiedId === m.id) recentlyCopiedId = null;
				copyTimer = null;
			}, 1500);
		} catch (e) {
			// clipboard.writeText can reject in non-secure contexts (HTTP) or
			// when the document isn't focused. Surface to console; the user
			// will see no feedback and can try again.
			console.warn('Copy to clipboard failed:', e);
		}
	}

	/** Whether to show the action bar for a message — only when there's
	 * something copyable. Skip for media-only messages with no text. */
	function hasCopyableText(m: ChatMessage): boolean {
		return partsToText(m.parts).trim().length > 0;
	}

	/**
	 * Inline-edit state. When non-null, the message bubble for
	 * `editingMessageId` re-renders as an in-place editor instead of a
	 * static bubble. The bottom composer hides during edit so it's
	 * unambiguous which message you're editing. Save creates a new
	 * sibling under `editingParentId`; cancel discards.
	 *
	 * Edit state is kept separate from the composer's state so a
	 * partially-typed draft in the composer isn't clobbered by entering
	 * edit mode.
	 */
	let editingMessageId = $state<string | null>(null);
	let editingParentId = $state<string | null>(null);
	let editText = $state('');
	const editAttachments = new AttachmentStore();
	let editComposerEl = $state<HTMLTextAreaElement | null>(null);
	let editFileInputEl = $state<HTMLInputElement | null>(null);
	onDestroy(() => editAttachments.destroy());

	$effect(() => {
		const el = editComposerEl;
		void editText;
		if (!el) return;
		el.style.height = 'auto';
		const next = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
		el.style.height = `${next}px`;
		el.style.overflowY = el.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden';
	});

	function beginEdit(m: ChatMessage) {
		if (busy) return;
		editText = partsToText(m.parts);
		editAttachments.clear();
		for (const p of m.parts) {
			if (p.type === 'image') {
				editAttachments.attachExisting(p.mediaId);
			}
		}
		editingMessageId = m.id;
		editingParentId = m.parentMessageId ?? null;
		void tick().then(() => editComposerEl?.focus());
	}

	function cancelEdit() {
		editingMessageId = null;
		editingParentId = null;
		editText = '';
		editAttachments.clear();
	}

	async function saveEdit() {
		const text = editText.trim();
		if ((!text && editAttachments.items.length === 0) || busy) return;
		if (editAttachments.isBusy) return;
		const editedId = editingMessageId;
		if (!editedId) return;
		const attachedMediaIds = editAttachments.readyMediaIds();
		// Snapshot then reset state — sendStreaming does its own UI work
		// (in-flight bubble, optimistic placeholder swap on 'start') that
		// we don't want to compete with the dismissed editor.
		editingMessageId = null;
		editingParentId = null;
		editText = '';
		editAttachments.clear();
		// Send only `editedMessageId`. The server looks up the edited
		// message and copies its parent_message_id onto the new sibling
		// — including the null case (edit of the conversation's root
		// message), which the older parent-resolved-on-the-client
		// approach silently dropped on the wire and caused those root
		// edits to append-instead-of-branch.
		await sendStreaming(text, attachedMediaIds, { editedMessageId: editedId });
	}

	/**
	 * Retry an assistant turn — server creates a new assistant sibling
	 * under the same parent user message and re-dispatches. Reuses the
	 * normal streaming pipeline; the retry-specific bits (skip optimistic,
	 * forward `regenerateFromMessageId`) are handled in sendStreaming.
	 */
	async function retryAssistant(m: ChatMessage) {
		if (busy) return;
		await sendStreaming('', [], { retryFromMessageId: m.id });
	}

	/** Switch the active branch to a sibling of the given message. Used by
	 * the `‹ N/M ›` arrows. Refetches the conversation on success so the
	 * page renders the new branch, then scrolls the newly-visible sibling
	 * into view — otherwise a shorter new branch's natural scroll-height
	 * clamping leaves the user at the bottom (often far below where they
	 * were when they clicked the arrow), or a longer one strands them
	 * mid-content with no clear orientation. */
	async function selectSibling(targetMessageId: string) {
		if (busy) return;
		errorMsg = null;
		try {
			const res = await fetch(
				`/api/conversations/${convId}/messages/${targetMessageId}/select`,
				{ method: 'POST' }
			);
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.message ?? `HTTP ${res.status}`);
			}
			await invalidateAll();
			// Wait one microtask for the messages-sync $effect to apply the
			// new data and the DOM to reflect it, then scroll the sibling
			// into the middle of the viewport.
			await tick();
			document
				.getElementById(`msg-${targetMessageId}`)
				?.scrollIntoView({ block: 'center', behavior: 'auto' });
		} catch (e) {
			errorMsg = `Couldn't switch branch: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	/** Delete the branch rooted at this message — only meaningful when the
	 * message has siblings. Confirms first because the operation is
	 * irreversible (subtree messages + any uniquely-referenced generated
	 * media get hard-deleted via the ref-counted purger path). */
	async function deleteBranch(m: ChatMessage) {
		if (busy) return;
		if (!confirm('Delete this branch and all messages on it? This cannot be undone.')) return;
		errorMsg = null;
		try {
			const res = await fetch(
				`/api/conversations/${convId}/messages/${m.id}/branch`,
				{ method: 'DELETE' }
			);
			if (!res.ok && res.status !== 404) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.message ?? `HTTP ${res.status}`);
			}
			await invalidateAll();
		} catch (e) {
			errorMsg = `Couldn't delete branch: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	function hasMedia(parts: MessagePart[]): boolean {
		return parts.some((p) => p.type === 'image' || p.type === 'video');
	}

	function partKey(p: MessagePart): string {
		if (p.type === 'image' || p.type === 'video') return p.mediaId;
		return p.type + ':' + ('text' in p ? p.text.slice(0, 8) : '');
	}
</script>

<div class="flex h-full flex-col">
	<header class="flex items-center justify-between px-4 py-3">
		<div class="min-w-0 flex-1">
			<h1 class="truncate text-sm font-semibold">{title ?? 'Untitled chat'}</h1>
			<p class="truncate text-xs text-neutral-500">{assistantLabel}</p>
		</div>
	</header>

	<!--
		Bottom mask-fade so message content dissolves into the page bg
		just before reaching the composer, instead of meeting it with a
		hard rectangular edge. ~32px fade is enough to soften the seam
		without cutting off readable content. Pure CSS mask-image — no JS,
		works the same on every browser that supports CSS Masking L1.
	-->
	<div
		bind:this={scrollContainer}
		class="flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 [mask-image:linear-gradient(to_bottom,black_calc(100%-32px),transparent)]"
	>
		<div class="mx-auto min-w-0 max-w-3xl space-y-4">
			{#each messages as m (m.id)}
				<!--
					Message + action-bar group. The actions row sits directly
					below the bubble, aligned to the same side (right for user
					messages, left for assistant), and reveals on hover at sm+.
					On mobile it stays visible since there's no hover.
				-->
				<div id="msg-{m.id}" class="group">
				{#if m.id === editingMessageId}
					<!--
						Inline editor: replaces the static bubble with an
						editable surface in the same position so it's
						unambiguous WHICH message is being edited. Save creates
						a sibling under the original's parent (preserving the
						original as a branch); Cancel discards.
					-->
					<article
						class="ml-auto max-w-[85%] rounded-2xl border border-amber-300 bg-white p-3 shadow-sm dark:border-amber-800 dark:bg-neutral-900"
					>
						<div class="mb-1 text-[11px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400">
							Editing
						</div>
						{#if editAttachments.items.length > 0}
							<div class="mb-2 flex flex-wrap gap-2 border-b border-neutral-200 pb-2 dark:border-neutral-800">
								{#each editAttachments.items as a (a.clientId)}
									<div
										class="group/thumb relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-neutral-200 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800"
										title={a.error ?? a.contentType}
									>
										<img
											src={a.objectUrl}
											alt=""
											class="h-full w-full object-cover {a.status === 'uploading'
												? 'opacity-60'
												: a.status === 'error'
													? 'opacity-40'
													: ''}"
										/>
										{#if a.status === 'uploading'}
											<div
												class="absolute inset-0 flex items-center justify-center bg-black/20 text-white"
											>
												<div class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
											</div>
										{:else if a.status === 'error'}
											<div
												class="absolute inset-0 flex items-center justify-center bg-red-600/40 text-white"
											>
												<AlertCircle size={20} strokeWidth={2} />
											</div>
										{/if}
										<button
											type="button"
											onclick={() => editAttachments.remove(a.clientId)}
											aria-label="Remove attachment"
											title="Remove"
											class="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900/80 text-white opacity-0 transition group-hover/thumb:opacity-100 hover:bg-neutral-900 focus-visible:opacity-100"
										>
											<X size={12} strokeWidth={2.5} />
										</button>
									</div>
								{/each}
							</div>
						{/if}
						<textarea
							bind:this={editComposerEl}
							bind:value={editText}
							rows="1"
							onkeydown={(e) => {
								if (e.key === 'Escape') {
									e.preventDefault();
									cancelEdit();
									return;
								}
								composerEnterHandler(
									data.prefs?.enterBehavior ?? 'send',
									() => void saveEdit()
								)(e);
							}}
							class="block w-full resize-none border-0 bg-transparent px-1 py-1 text-base focus:outline-none sm:text-sm"
						></textarea>
						<div class="mt-2 flex items-center gap-2">
							{#if allowAttachments}
								<input
									bind:this={editFileInputEl}
									type="file"
									accept="image/*"
									multiple
									class="hidden"
									onchange={(e) => {
										const t = e.currentTarget;
										if (t.files && t.files.length > 0) {
											void editAttachments.addFiles(t.files);
										}
										t.value = '';
									}}
								/>
								<button
									type="button"
									onclick={() => editFileInputEl?.click()}
									aria-label="Attach image"
									title="Attach image"
									class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
								>
									<Plus size={18} strokeWidth={2.25} />
								</button>
							{/if}
							<div class="flex-1"></div>
							<button
								type="button"
								onclick={cancelEdit}
								class="rounded-md px-3 py-1.5 text-xs text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
							>
								Cancel
							</button>
							<button
								type="button"
								onclick={() => saveEdit()}
								disabled={(!editText.trim() && editAttachments.items.length === 0) ||
									editAttachments.isBusy}
								class="rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white transition hover:bg-neutral-800 disabled:opacity-30 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
							>
								Save
							</button>
						</div>
					</article>
				{:else}
				<article
					class="min-w-0 rounded-2xl px-4 py-3 text-sm {m.role === 'user'
						? 'ml-auto max-w-[85%] bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
						: m.role === 'assistant'
							? 'bg-neutral-100 dark:bg-neutral-800'
							: 'bg-amber-50 dark:bg-amber-950/40'}"
				>
					<div class="text-[11px] font-medium tracking-wide opacity-60">
						{m.role === 'user' ? userLabel : m.role === 'assistant' ? assistantLabel : m.role}
					</div>
					{#if m.reasoningText}
						<details class="mt-1 rounded-md border border-neutral-300 bg-white p-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
							<summary class="cursor-pointer text-neutral-500">Reasoning</summary>
							<div class="mt-2 whitespace-pre-wrap break-words text-neutral-700 dark:text-neutral-300">
								{m.reasoningText}
							</div>
						</details>
					{/if}
					{#if m.role === 'assistant' && m.contentHtml}
						<!-- HTML is server-rendered (markdown-it w/ html=false + shiki); safe to {@html}. -->
						<div class="gs-prose mt-1">{@html m.contentHtml}</div>
					{:else}
						{@const text = partsToText(m.parts)}
						{#if text}
							<div class="mt-1 whitespace-pre-wrap break-words">{text}</div>
						{/if}
						{#if hasMedia(m.parts)}
							<div class="mt-2 space-y-2">
								{#each m.parts as p (partKey(p))}
									{#if p.type === 'image'}
										{@const mediaId = p.mediaId}
										<button
											type="button"
											onclick={() => openImageInLightbox(mediaId)}
											aria-label="Open image"
											class="block w-full overflow-hidden rounded-lg p-0 text-left transition disabled:opacity-60"
											disabled={openingLightboxFor === mediaId}
										>
											<img
												src="/api/media/{p.mediaId}/content"
												alt={p.alt ?? 'Image'}
												loading="lazy"
												class="block h-auto w-full max-h-[80vh] rounded-lg object-contain"
											/>
										</button>
									{:else if p.type === 'video'}
										<!-- svelte-ignore a11y_media_has_caption -->
										<video
											src="/api/media/{p.mediaId}/content"
											controls
											class="block h-auto w-full max-h-[80vh] rounded-lg"
										></video>
									{/if}
								{/each}
							</div>
						{/if}
					{/if}
				</article>
				{/if}
				{#if (m.role === 'user' || m.role === 'assistant') && m.id !== editingMessageId}
					{@const showEdit = m.role === 'user'}
					{@const showRetry = m.role === 'assistant'}
					{@const showCopy = hasCopyableText(m)}
					{@const siblingCount = m.siblingCount ?? 1}
					{@const hasSiblings = siblingCount > 1}
					{@const justCopied = recentlyCopiedId === m.id}
					<div
						class="mt-1 flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 {m.role ===
						'user'
							? 'justify-end'
							: 'justify-start'}"
					>
						{#if hasSiblings}
							{@const pos = m.siblingPosition ?? 1}
							{@const ids = m.siblingIds ?? [m.id]}
							<button
								type="button"
								onclick={() => selectSibling(ids[pos - 2])}
								disabled={pos === 1 || busy}
								aria-label="Previous sibling"
								title="Previous"
								class="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
							>
								<ChevronLeft size={14} strokeWidth={2.25} />
							</button>
							<span class="text-xs tabular-nums text-neutral-500">
								{pos} / {siblingCount}
							</span>
							<button
								type="button"
								onclick={() => selectSibling(ids[pos])}
								disabled={pos === siblingCount || busy}
								aria-label="Next sibling"
								title="Next"
								class="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
							>
								<ChevronRight size={14} strokeWidth={2.25} />
							</button>
							<!-- Trash this branch. Only meaningful (and only shown) when
								 siblings exist — deleting an only-branch would just be
								 truncating the conversation, a different operation that
								 isn't exposed here. Server defensively re-checks. -->
							<button
								type="button"
								onclick={() => deleteBranch(m)}
								disabled={busy}
								aria-label="Delete this branch"
								title="Delete branch"
								class="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-red-100 hover:text-red-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-red-950/40 dark:hover:text-red-300"
							>
								<Trash2 size={14} strokeWidth={2.25} />
							</button>
						{/if}
						{#if showCopy}
							<button
								type="button"
								onclick={() => copyMessage(m)}
								aria-label={justCopied ? 'Copied' : 'Copy message'}
								title={justCopied ? 'Copied' : 'Copy'}
								class="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
							>
								{#if justCopied}
									<Check size={14} strokeWidth={2.25} class="text-emerald-600 dark:text-emerald-400" />
								{:else}
									<Copy size={14} strokeWidth={2.25} />
								{/if}
							</button>
						{/if}
						{#if showEdit}
							<button
								type="button"
								onclick={() => beginEdit(m)}
								disabled={busy}
								aria-label="Edit message"
								title="Edit"
								class="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
							>
								<Pencil size={14} strokeWidth={2.25} />
							</button>
						{/if}
						{#if showRetry}
							<button
								type="button"
								onclick={() => retryAssistant(m)}
								disabled={busy}
								aria-label="Retry"
								title="Retry"
								class="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
							>
								<RotateCcw size={14} strokeWidth={2.25} />
							</button>
						{/if}
					</div>
				{/if}
				</div>
			{/each}

			{#if inFlightOpen}
				<article class="min-w-0 rounded-2xl bg-neutral-100 px-4 py-3 text-sm dark:bg-neutral-800">
					<div class="text-[11px] font-medium tracking-wide opacity-60">{assistantLabel}</div>
					{#if inFlightReasoning}
						<details open class="mt-1 rounded-md border border-neutral-300 bg-white p-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
							<summary class="cursor-pointer text-neutral-500">Reasoning</summary>
							<div class="mt-2 whitespace-pre-wrap break-words text-neutral-700 dark:text-neutral-300">
								{inFlightReasoning}
							</div>
						</details>
					{/if}
					{#if inFlightText}
						<div class="gs-prose mt-1">{@html inFlightHtml}</div>
					{:else if !inFlightReasoning}
						<div class="mt-1 flex items-center gap-2 text-neutral-500">
							<span>{inFlightLabel}</span>
							<span class="inline-flex gap-1">
								<span class="animate-pulse">·</span>
								<span class="animate-pulse [animation-delay:120ms]">·</span>
								<span class="animate-pulse [animation-delay:240ms]">·</span>
							</span>
							{#if inFlightStatus && inFlightStatus !== 'in_progress'}
								<span class="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
									{inFlightStatus}
								</span>
							{/if}
							{#if inFlightProgress !== null}
								<span class="font-mono text-xs tabular-nums">{inFlightProgress.toFixed(0)}%</span>
							{/if}
							{#if elapsedSeconds >= 0.3}
								<span class="font-mono text-xs tabular-nums">{elapsedSeconds.toFixed(1)}s</span>
							{/if}
						</div>
					{/if}
				</article>
			{/if}
			<!--
				Bottom sentinel for IntersectionObserver. Pinned to the very
				end of the message list so the observer can tell when the
				user is scrolled within ~100px of it (see effect above).
				1px tall + aria-hidden so it's invisible / inaudible to AT.
			-->
			<div bind:this={bottomSentinel} aria-hidden="true" class="h-px"></div>
		</div>
	</div>

	<!-- Floating composer. Sits above the scrollable message area without
		 a separator border — reads as part of the chat surface. The form
		 itself is the rounded box; no surrounding footer chrome. -->
	<div class="relative px-4 pb-4">
		<!--
			Scroll-to-bottom affordance. Anchored to the composer wrapper so
			it sits a fixed distance above the composer regardless of how tall
			the textarea has grown. Aria-hidden when not visible so screen
			readers don't announce it; opacity transition for a soft fade.
		-->
		<div
			class="pointer-events-none absolute -top-4 left-1/2 -translate-x-1/2 -translate-y-full transition-opacity {isNearBottom
				? 'opacity-0'
				: 'opacity-100'}"
		>
			<button
				type="button"
				onclick={() => scrollToBottom({ smooth: true })}
				aria-label="Scroll to latest message"
				aria-hidden={isNearBottom}
				tabindex={isNearBottom ? -1 : 0}
				class="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-700 shadow-md transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
			>
				<ArrowDown size={16} strokeWidth={2.25} />
			</button>
		</div>
		{#if editingMessageId}
			<!-- Composer hidden while editing: the edit happens inline on
				 the message bubble itself, with its own Save/Cancel
				 controls. Re-shown when the user dismisses the inline
				 editor. -->
		{:else}
		<form
			onsubmit={send}
			ondragenter={onDragEnter}
			ondragover={onDragOver}
			ondragleave={onDragLeave}
			ondrop={onDrop}
			class="relative mx-auto max-w-3xl"
		>
			{#if errorMsg}
				<div
					class="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
				>
					{errorMsg}
				</div>
			{/if}
			<div class="rounded-2xl border border-neutral-300 bg-white px-3 py-2 shadow-sm transition focus-within:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-500">
				{#if attachments.items.length > 0}
					<div class="flex flex-wrap gap-2 border-b border-neutral-200 px-1 pb-2 dark:border-neutral-800">
						{#each attachments.items as a (a.clientId)}
							<div
								class="group/thumb relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-neutral-200 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800"
								title={a.error ?? a.contentType}
							>
								<img
									src={a.objectUrl}
									alt=""
									class="h-full w-full object-cover {a.status === 'uploading'
										? 'opacity-60'
										: a.status === 'error'
											? 'opacity-40'
											: ''}"
								/>
								{#if a.status === 'uploading'}
									<div
										class="absolute inset-0 flex items-center justify-center bg-black/20 text-white"
									>
										<div class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
									</div>
								{:else if a.status === 'error'}
									<div
										class="absolute inset-0 flex items-center justify-center bg-red-600/40 text-white"
									>
										<AlertCircle size={20} strokeWidth={2} />
									</div>
								{/if}
								<button
									type="button"
									onclick={() => attachments.remove(a.clientId)}
									aria-label="Remove attachment"
									title="Remove"
									class="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900/80 text-white opacity-0 transition group-hover/thumb:opacity-100 hover:bg-neutral-900 focus-visible:opacity-100"
								>
									<X size={12} strokeWidth={2.5} />
								</button>
							</div>
						{/each}
					</div>
				{/if}
				<textarea
					bind:this={composerEl}
					bind:value={composerText}
					rows="1"
					placeholder={modelKind === 'image' ? 'Describe an image to generate…' : 'Write a message…'}
					disabled={busy}
					onkeydown={composerEnterHandler(
						data.prefs?.enterBehavior ?? 'send',
						(e) => void send(e)
					)}
					onpaste={onPaste}
					class="block w-full resize-none border-0 bg-transparent px-2 py-2 text-base focus:outline-none disabled:opacity-50 sm:text-sm"
				></textarea>
				<div class="flex items-center gap-2 px-1 pt-1">
					{#if allowAttachments}
						<input
							bind:this={fileInputEl}
							type="file"
							accept="image/*"
							multiple
							class="hidden"
							onchange={(e) => {
								const t = e.currentTarget;
								if (t.files && t.files.length > 0) {
									void attachments.addFiles(t.files);
								}
								// Clear so re-picking the same file fires onchange again.
								t.value = '';
							}}
						/>
						<button
							type="button"
							onclick={() => fileInputEl?.click()}
							disabled={busy}
							aria-label="Attach image"
							title="Attach image"
							class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-30 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
						>
							<Plus size={18} strokeWidth={2.25} />
						</button>
					{/if}
					<div class="flex-1"></div>
					<!--
						Per-turn model picker: defaulted to the conversation's
						current model so the no-change case is invisible. Picking
						a different model rewrites the conversation's stored
						endpoint/model on the next send (see
						/api/conversations/:id/messages — `modelId` in the body).
						Custom presets are intentionally NOT shown here because
						they bundle persona, and switching persona mid-thread is
						a different feature.
					-->
					<ModelPicker
						models={data.models}
						bind:value={modelId}
						filterKinds={['chat', 'image', 'video']}
						disabled={busy}
						inline
					/>
					{#if busy && activeAbort}
						<button
							type="button"
							onclick={stop}
							aria-label="Stop generation"
							title="Stop"
							class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-600 text-white transition hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
						>
							<Square size={14} strokeWidth={2.5} fill="currentColor" />
						</button>
					{:else}
						<button
							type="submit"
							disabled={(!composerText.trim() && attachments.items.length === 0) ||
								busy ||
								attachments.isBusy ||
								!hasValidModel}
							aria-label="Send message"
							title={!hasValidModel ? 'Pick a model to send' : 'Send'}
							class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-800 disabled:opacity-30 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
						>
							<ArrowUp size={16} strokeWidth={2.5} />
						</button>
					{/if}
				</div>
			</div>
			{#if isDraggingOver}
				<!--
					Drop-zone overlay — covers the form rectangle while a file
					drag is active. pointer-events-none so the underlying drop
					event still fires on the form.
				-->
				<div
					aria-hidden="true"
					class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl border-2 border-dashed border-neutral-500 bg-neutral-100/85 text-sm text-neutral-700 backdrop-blur-sm dark:border-neutral-400 dark:bg-neutral-900/85 dark:text-neutral-200"
				>
					Drop image to attach
				</div>
			{/if}
		</form>
		{/if}
	</div>
</div>

<!--
	In-conversation media lightbox. State + fetch live in this page so
	the chat owns the open/close lifecycle; the component is purely
	presentational. We deliberately don't pass `onDelete` or
	`conversationsUsingThis` — destructive media deletion belongs in
	the gallery surface, and listing "conversations referencing this"
	would just be a circular link back to where the user already is.
	`inConversation` switches the gallery-launch button labels to
	wording that makes it explicit they start a *new* chat, since the
	user is currently inside one and "Regenerate" otherwise reads
	ambiguously.
-->
<MediaLightbox
	media={lightbox}
	onClose={() => (lightbox = null)}
	inConversation
/>
