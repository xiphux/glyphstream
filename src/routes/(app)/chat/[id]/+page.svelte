<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { fade } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { preferredFirstName } from '$lib/greeting';
	import { ensureLiveMarkdown, renderLiveMarkdown } from '$lib/markdown-live';
	import { ensureLiveHighlighter } from '$lib/markdown-live-shiki.svelte';
	import { consumeChatStream } from '$lib/consume-chat-stream';
	import {
		buildApprovalDecisionsSnapshot,
		runApprovalResume,
		type ApprovalAction,
	} from '$lib/approval-workflow';
	import { errorMessageFromResponse } from '$lib/fetch-error';
	import { toggleFavoriteModel } from '$lib/favorite-models';
	import { pendingFirstMessageKey } from '$lib/pending-first-message';
	import { confirmDialog } from '$lib/confirm.svelte';
	import ChatComposer from '$lib/components/chat/ChatComposer.svelte';
	import ChatHeader from '$lib/components/chat/ChatHeader.svelte';
	import EditMessageForm from '$lib/components/chat/EditMessageForm.svelte';
	import InFlightBubble from '$lib/components/chat/InFlightBubble.svelte';
	import MessageActions from '$lib/components/chat/MessageActions.svelte';
	import MessageBubble from '$lib/components/chat/MessageBubble.svelte';
	import ScrollToBottomButton from '$lib/components/chat/ScrollToBottomButton.svelte';
	import {
		appendReasoning as inFlightAppendReasoning,
		appendText as inFlightAppendText,
		buildRenderedConversation,
		computeMergeFlags,
		inFlightToBlocks,
		markToolCallPendingApproval as inFlightMarkToolCallPendingApproval,
		pushToolCall as inFlightPushToolCall,
		updateToolCallArgs as inFlightUpdateToolCallArgs,
		updateToolCallResult as inFlightUpdateToolCallResult,
		type InFlightSegment,
	} from '$lib/chat-render';
	import { AttachmentStore, attachmentsAllowedFor } from '$lib/attachments.svelte';
	import {
		buildSendRequestBody,
		buildFanoutBranchBody,
		type SendOptions,
	} from '$lib/chat-send-body';
	import FanoutColumns from '$lib/components/chat/FanoutColumns.svelte';
	import { allColumnsSettled, type FanoutColumn, type FanoutModel } from '$lib/fanout';
	import { toast } from '$lib/toast.svelte';
	import { clearTitlePending, markTitlePending } from '$lib/title-pending.svelte';
	import type { MediaListItem } from '$lib/server/db/queries/media';
	import type {
		ChatMessage,
		FeatureCategory,
		MessagePart,
		ModelKind,
		PrepareFanoutRequest,
		PrepareFanoutResponse,
		SendMessageResponse,
	} from '$lib/types/api';

	let { data } = $props();

	// Friendly bubble labels: the user's preferred name (Preferences ▸ Name
	// if set, else GitHub display name's first token, else login) +
	// the model's friendly name (server resolves custom-model name).
	const userLabel = $derived(
		preferredFirstName(data.prefs?.name, data.user.displayName, data.user.email ?? 'You'),
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
	let disabledFeatures = $state<FeatureCategory[]>([...data.conversation.disabledFeatures]);

	async function persistDisabledFeatures(next: FeatureCategory[]) {
		// Optimistic update — the toggle should feel instant. On error we
		// revert + toast, so the visible state matches what the server has.
		const previous = disabledFeatures;
		disabledFeatures = next;
		try {
			const res = await fetch(`/api/conversations/${data.conversation.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ disabledFeatures: next }),
			});
			if (!res.ok) {
				throw new Error(await errorMessageFromResponse(res));
			}
		} catch (e) {
			disabledFeatures = previous;
			toast.error(e instanceof Error ? e.message : String(e));
		}
	}
	// svelte-ignore state_referenced_locally
	let convId = $state(data.conversation.id);
	// svelte-ignore state_referenced_locally
	let modelKind = $state<ModelKind | null>(data.conversation.modelKind);
	// Server's in-flight registry start time for this conversation (unix
	// ms), or null. Mirrored from the load function so the "Generating…"
	// indicator can survive an iOS suspension that killed the client fetch.
	// svelte-ignore state_referenced_locally
	let serverInFlightSince = $state<number | null>(data.inFlightSince);

	$effect(() => {
		messages = data.conversation.messages;
		title = data.conversation.title;
		modelId = data.conversation.modelId;
		convId = data.conversation.id;
		modelKind = data.conversation.modelKind;
		serverInFlightSince = data.inFlightSince;
	});

	// In-flight streaming state. Lifted to the top of the script so the
	// derived approval-pending state (below) can reference it; the
	// mutation helpers + the rest of the SSE pipeline live further down.
	let inFlightSegments = $state<InFlightSegment[]>([]);

	// Fold tool-result messages out of the visible list and expose them
	// via a side-map keyed by tool_call_id. The matching assistant
	// message renders each of its tool_call parts as a ToolCallBlock
	// inline (looking up the result here), so the user sees the call +
	// result as one visual unit instead of two separate bubbles. This
	// is the "folded into assistant bubble" UX the user picked over
	// "separate sequential bubbles."
	//
	// `pendingApprovals` is the toolCallIds halted on untrusted MCP
	// tools — non-empty hides the composer until the user posts
	// decisions to /tool-approval. All three derive from the same
	// messages array via a single pass to avoid three walks per update.
	const rendered = $derived(buildRenderedConversation(messages));
	const visibleMessages = $derived(rendered.visibleMessages);
	const toolResultsByCallId = $derived(rendered.toolResultsByCallId);
	const pendingApprovals = $derived(rendered.pendingApprovals);

	// Precompute merge flags once per render rather than calling
	// computeMergeFlags inside the per-row {@const} in the {#each}.
	// Each call is O(1) but it was running for every row on every
	// reactive update; building the map up-front keeps render walks
	// linear instead of having the per-row inputs (editing id,
	// inFlightOpen) re-trigger work for every message.
	const mergeFlagsById = $derived.by(() => {
		const map = new Map<string, { mergeWithPrev: boolean; mergeWithNext: boolean }>();
		for (let i = 0; i < visibleMessages.length; i++) {
			const m = visibleMessages[i];
			map.set(m.id, computeMergeFlags(visibleMessages, i, editingMessageId, inFlightOpen));
		}
		return map;
	});

	// User's per-tool decisions, accumulating until every pending tool
	// has one — at which point the Submit button enables and posts the
	// batch as a single resume request.
	let approvalDecisions = $state<Map<string, ApprovalAction>>(new Map());
	let approvalSubmitting = $state(false);
	let approvalError = $state<string | null>(null);

	// Reset decisions whenever the pending set changes (a resume just
	// completed, or a new turn left a different set of pending tools).
	// Track BOTH the persisted pending set and the live in-flight
	// pending set so a decision the user picked against a live row
	// survives the moment when invalidate adds the same row to the
	// persisted list (the id is in both during the overlap).
	$effect(() => {
		const ids = allPendingToolCallIds;
		untrack(() => {
			let mutated = false;
			const next = new Map<string, ApprovalAction>();
			for (const [id, action] of approvalDecisions) {
				if (ids.has(id)) next.set(id, action);
				else mutated = true;
			}
			if (mutated || next.size !== approvalDecisions.size) approvalDecisions = next;
		});
	});

	// Live in-flight pending tool IDs — extracted from the streaming
	// bubble's segments so the approval prompt is responsive *during*
	// the stream, not only after invalidate refetches the persisted
	// pending rows.
	const liveInFlightPendingIds = $derived(
		inFlightSegments
			.filter((s) => s.kind === 'tool_call' && s.status === 'pending_approval')
			.map((s) => (s as { toolCallId: string }).toolCallId),
	);
	// Union of persisted-row pending IDs + live in-flight pending IDs.
	// The server already persisted the live ones before emitting the SSE
	// event (and before `done`), so the resume endpoint can find them
	// either way; the client just doesn't need to wait for invalidate.
	const allPendingToolCallIds = $derived(
		new Set<string>([...pendingApprovals, ...liveInFlightPendingIds]),
	);
	const hasAnyPendingApproval = $derived(allPendingToolCallIds.size > 0);
	const approvalsAllDecided = $derived(
		allPendingToolCallIds.size > 0 &&
			Array.from(allPendingToolCallIds).every((id) => approvalDecisions.has(id)),
	);

	function onApprovalSelect(toolCallId: string, action: ApprovalAction): void {
		approvalDecisions = new Map(approvalDecisions).set(toolCallId, action);
	}

	// Auto-submit the moment every pending tool has a decision so the
	// common single-pending case is a single click rather than click +
	// Continue. Guard with `approvalSubmitting` so the effect doesn't
	// loop while the resume stream is in flight, and only fire when
	// there's at least one pending tool (otherwise we'd submit an
	// empty batch on every load). Builds the decision list from the
	// merged live+persisted id set so clicks on the in-flight bubble
	// resume just as fast as clicks on the persisted bubble.
	$effect(() => {
		if (!approvalsAllDecided) return;
		if (approvalSubmitting) return;
		const ids = allPendingToolCallIds;
		untrack(() => {
			void submitApprovalDecisions(buildApprovalDecisionsSnapshot(ids, approvalDecisions));
		});
	});

	async function submitApprovalDecisions(
		decisions: Array<{ toolCallId: string; action: ApprovalAction }>,
	): Promise<void> {
		if (approvalSubmitting) return;
		approvalSubmitting = true;
		approvalError = null;
		try {
			await runApprovalStream(data.conversation.id, decisions);
			approvalDecisions = new Map();
			await invalidateAll();
		} catch (e) {
			// AbortError from clicking Stop mid-resume is expected and
			// shouldn't surface as a red banner — same convention as the
			// initial-send path. The server-side recorder will have
			// committed whatever partial text it had; invalidateAll on
			// the way out picks that up.
			if (!isAbortError(e)) {
				approvalError = e instanceof Error ? e.message : String(e);
			}
			await invalidateAll();
		} finally {
			approvalSubmitting = false;
		}
	}

	async function runApprovalStream(
		convId: string,
		decisions: Array<{ toolCallId: string; action: ApprovalAction }>,
	): Promise<void> {
		const turnConvId = convId;
		// Open the in-flight bubble so the user sees text + tool calls
		// streaming in live instead of staring at "Resuming…" for the
		// duration of the model's response.
		resetInFlightSegments();
		inFlightProgress = null;
		inFlightStatus = null;
		inFlightOpen = true;
		// Reuse the same Stop wiring the initial send path uses — the
		// in-flight registry on the server keys by conversation id, so
		// stop()'s POST to /cancel reaches the resumed upstream call,
		// and aborting `activeAbort` here tears down our local fetch.
		// Without this the user has no way to halt a runaway resumed
		// generation (small models in a thinking loop, etc.).
		const abort = new AbortController();
		activeAbort = abort;
		try {
			const { sawToolCalls } = await runApprovalResume(convId, decisions, abort.signal, (body) =>
				runChatStream(body, {
					turnConvId,
					optimisticId: null,
					// onDone omitted — approvalSubmitting clears in the
					// caller's finally so the inline buttons stay disabled
					// until the invalidate completes and the persisted
					// rows surface.
				}),
			);
			if (convId === turnConvId) {
				await invalidateAll();
				if (sawToolCalls) {
					inFlightOpen = false;
					resetInFlightSegments();
					inFlightProgress = null;
					inFlightStatus = null;
				}
			}
		} finally {
			if (activeAbort === abort) activeAbort = null;
		}
	}

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
	const allowAttachments = $derived(attachmentsAllowedFor(modelKind));
	// Imported OWUI conversations land with a stored modelId like "gpt-4o"
	// (no endpoint:: prefix), which the picker shows as "Choose a model…".
	// Without this gate the user could type+submit and the server would 500
	// on `parseModelId(...) === null`. Gating the submit means the picker
	// is the obvious next step.
	const hasValidModel = $derived(data.models.some((m) => m.id === modelId));

	// Conversation context size: tokens_in + tokens_out of the most
	// recent assistant turn with usage populated. That sum is roughly
	// what the next request's prompt_tokens will be (the new user
	// message will add a bit), so it answers "how big is this thread
	// right now?" without needing a tokenizer on the client. Old
	// conversations and providers that don't report usage simply yield
	// 0, which we hide.
	const contextTokenCount = $derived.by(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== 'assistant') continue;
			const tin = m.tokensIn ?? 0;
			const tout = m.tokensOut ?? 0;
			if (tin > 0 || tout > 0) return tin + tout;
		}
		return 0;
	});

	// Per-user-message "tokens we sent up to and including this turn":
	// the prompt_tokens of the next assistant message whose backend
	// reported usage. Computed once per `messages` change with a single
	// right-to-left sweep rather than once per row at render time —
	// the previous per-row lookup made the message list render O(N²).
	// Null when no downstream assistant reported usage (in-flight or
	// cancelled turn, or backend doesn't return usage).
	const userSentTokens = $derived.by(() => {
		const out = new Array<number | null>(messages.length);
		let next: number | null = null;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === 'assistant') {
				if (m.tokensIn != null) next = m.tokensIn;
			} else if (m.role === 'user') {
				out[i] = next;
			} else {
				out[i] = null;
			}
		}
		return out;
	});

	onDestroy(() => attachments.destroy());

	// Auto-attach last generated image for I2I follow-ups: when the
	// conversation's most recent assistant turn produced an image, pre-
	// populate the composer with that image as a starting attachment so
	// "make her shirt blue" / "remove the background" turns Just Work
	// without re-uploading. The user can dismiss with the same X they'd
	// use on any attachment.
	//
	// `autoAttached` records both the assistant turn we auto-attached
	// *for* and the media we attached, so when the leaf assistant
	// changes (new turn arrives, branch switched via the sibling
	// arrows, or a previous user message gets edited and a new branch
	// streams in) we can find and remove the now-stale auto-attached
	// item before evaluating whether to attach the new branch's image.
	// Without tracking the mediaId here, a branch switch would leave
	// the old branch's image in the composer indefinitely (the
	// existing `attachments.items.length > 0` guard would bail before
	// the auto-attach effect ever got a chance to swap).
	let autoAttached = $state<{ assistantId: string; mediaId: string } | null>(null);

	// Reset composer state when navigating between conversations — without
	// this the previous chat's attachments (and its auto-attach memory)
	// would carry into the new one.
	$effect(() => {
		void data.conversation.id;
		attachments.clear();
		autoAttached = null;
	});

	$effect(() => {
		if (modelKind !== 'image') return;
		// Walk from the leaf back to find the most recent assistant
		// message that has an image part. This `messages` read is the
		// only thing we want this effect to track — `attachments`
		// reads/writes inside the `untrack` below are intentionally
		// outside the dep graph (otherwise auto-removing the stale
		// auto-attachment would re-trigger this effect and we'd
		// thrash).
		const lastAssistant = [...messages]
			.reverse()
			.find((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'image'));
		const imagePart = lastAssistant?.parts.find((p) => p.type === 'image');
		const candidateMediaId = imagePart?.type === 'image' ? imagePart.mediaId : null;

		untrack(() => {
			// Branch switched / new turn arrived — the previous
			// auto-attached item is now pointing at a different
			// branch's output. Pull it from the composer before
			// deciding what (if anything) to attach next. User-picked
			// attachments stay untouched: we only ever remove items
			// whose mediaId matches what *we* added.
			if (autoAttached && autoAttached.assistantId !== lastAssistant?.id) {
				const stale = attachments.items.find((i) => i.mediaId === autoAttached!.mediaId);
				if (stale) attachments.remove(stale.clientId);
				autoAttached = null;
			}

			// Don't auto-attach if the user has picked something, or if
			// there's no candidate to attach, or if we've already
			// auto-attached this exact turn (e.g. a re-render that
			// doesn't actually change the leaf — dismissing the
			// auto-attach should stick).
			if (attachments.items.length > 0) return;
			if (!lastAssistant || !candidateMediaId) return;
			if (autoAttached?.assistantId === lastAssistant.id) return;

			attachments.attachExisting(candidateMediaId);
			autoAttached = { assistantId: lastAssistant.id, mediaId: candidateMediaId };
		});
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
				toast.error(`Couldn't load image details: ${e instanceof Error ? e.message : String(e)}`);
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
			{ root, rootMargin: '0px 0px 100px 0px', threshold: 0 },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	});

	// Reference to the ChatComposer instance so the focus effect below
	// can land focus in its textarea. The composer owns the ref + the
	// auto-resize; the page owns the *when* of focusing.
	let composerRef = $state<{ focus: () => void } | null>(null);

	// Measured height of the floating composer overlay. The message list
	// pads its bottom by this much (plus a gap) so the last message can
	// scroll fully clear of the frosted composer that floats over it.
	let composerHeight = $state(0);

	// Message-arrival fade. `listMounted` gates the in:fade so only bubbles
	// that mount AFTER the initial render animate — a fresh send, a streamed
	// reply, or a branch switch — rather than the whole history re-fading on
	// load. Opacity-only (no layout shift) so it can't perturb the pin-to-
	// bottom / scroll math. Honors prefers-reduced-motion.
	let listMounted = $state(false);
	// Message id the deep-link arrived for. Drives a brief highlight class
	// on the matching wrapper that fades out via `transition-colors`. The
	// id is cleared after the fade completes so the class doesn't stick.
	let highlightedMessageId = $state<string | null>(null);
	onMount(() => {
		listMounted = true;
		// Start the lazy syntax-highlighter chunk download as soon as the
		// chat opens. ~72 KB gzip, route-lazy. Idempotent; safe to call on
		// every chat-page mount. Result is ignored — the module flips its
		// own reactive `liveHighlighterReady` signal once loaded, which
		// the rAF-driven inFlightSegments effect picks up automatically.
		void ensureLiveHighlighter();
		// markdown-it itself is also route-lazy (~45 KB gzip). Kicking it
		// off at mount means the first streaming tick after the user sends
		// a message almost always finds it already loaded; while it's
		// loading renderLiveMarkdown falls back to an escaped <p>.
		void ensureLiveMarkdown();
		// Deep-link from the search modal: URL hash like `#msg-<id>`.
		// Wait for the message wrappers to be in the DOM before scrolling.
		const hash = typeof location !== 'undefined' ? location.hash : '';
		const match = hash.match(/^#msg-(.+)$/);
		if (!match) return;
		const targetId = decodeURIComponent(match[1]);
		void tick().then(() => {
			const el = document.getElementById(`msg-${targetId}`);
			if (!el) return;
			el.scrollIntoView({ block: 'center', behavior: 'auto' });
			highlightedMessageId = targetId;
			// 1500ms covers the user's eye-track plus the CSS fade so the
			// transient state doesn't visibly snap off when we clear it.
			setTimeout(() => {
				if (highlightedMessageId === targetId) highlightedMessageId = null;
			}, 1500);
		});
	});
	const reduceMotion =
		typeof window !== 'undefined' &&
		!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

	// The assistant message id that just finished streaming / generating.
	// Its content was already on screen as the in-flight bubble, so when
	// the persisted row mounts to replace it we suppress the arrival fade —
	// otherwise the bubble visibly blinks out and re-fades on finalize. The
	// in-flight bubble itself carries the fade (on stream start) instead.
	let streamedMessageId = $state<string | null>(null);

	// Land focus in the follow-up composer whenever the conversation
	// becomes ready for input — on entering a conversation (including
	// switching straight from another one), and the moment an in-flight
	// generation finishes. Sending a follow-up is the dominant next
	// action, but nothing otherwise puts focus here: the new-chat page
	// navigates in with focus left behind, and a finished stream leaves
	// focus nowhere, so the user has to click/tab into the box before
	// they can type.
	//
	// The textarea is `disabled` while `generating`, and a disabled
	// element can't take focus — a focus attempt mid-generation is a
	// no-op. `generating` is in this effect's dep set, so it re-runs
	// once generation clears and lands the focus then.
	//
	// Skipped on touch devices: focusing a textarea there springs the
	// on-screen keyboard open unprompted, eating half the viewport.
	$effect(() => {
		void data.conversation.id; // re-focus when switching conversations
		if (generating) return;
		if (!composerRef) return;
		if (window.matchMedia?.('(pointer: coarse)').matches) return;
		composerRef.focus();
	});

	// AbortController for the in-flight fetch. Stop button click triggers
	// .abort() AND fires a POST to /api/conversations/:id/cancel so the
	// server tears down upstream too (otherwise the bridge keeps generating).
	let activeAbort = $state<AbortController | null>(null);

	// Tracks whether the page got backgrounded while a fetch was in flight.
	// iOS aggressively suspends PWAs and Safari tabs after a few seconds in
	// the background, which kills the in-flight network request and surfaces
	// as a generic "Load failed" TypeError on the catch side — indistinguishable
	// from a real network failure. We flip this flag in a visibilitychange
	// listener so the catch blocks below can recognize the suspension case
	// and treat it like an abort (silent invalidate, no misleading error
	// toast) instead of like a real failure. Reset at the top of each send.
	let wasHiddenDuringFetch = $state(false);

	// Parallel flag for connectivity transitions during a fetch — the
	// foreground equivalent of the suspension case. iPhone hopping
	// between wifi and cellular (or vice versa), losing signal briefly
	// in a dead zone, an AP changing, an airplane-mode toggle, etc. all
	// kill in-flight TCP connections and surface the same generic
	// "Load failed" TypeError. browser `offline`/`online` events fire
	// around these transitions (iOS Safari included) — we use them
	// the same way visibilitychange handles suspension.
	let wasOfflineDuringFetch = $state(false);

	// Visibility-change + connectivity listeners: tracks interruptions
	// during in-flight sends, and re-invalidates on return so any work
	// that completed in the background (the most common case for
	// image/video generation, where the server keeps generating even
	// after the client's fetch dies) shows up immediately rather than
	// only after the user navigates away and back to force a refetch.
	$effect(() => {
		if (typeof document === 'undefined') return;
		function onVisibilityChange() {
			if (document.visibilityState === 'hidden' && busy) {
				wasHiddenDuringFetch = true;
			} else if (document.visibilityState === 'visible' && wasHiddenDuringFetch) {
				// Reconcile against server state — if the generation
				// completed while we were backgrounded, the new assistant
				// message will arrive via the load function.
				void invalidateAll();
			}
		}
		function onOffline() {
			if (busy) wasOfflineDuringFetch = true;
		}
		function onOnline() {
			if (wasOfflineDuringFetch) void invalidateAll();
		}
		document.addEventListener('visibilitychange', onVisibilityChange);
		window.addEventListener('offline', onOffline);
		window.addEventListener('online', onOnline);
		return () => {
			document.removeEventListener('visibilitychange', onVisibilityChange);
			window.removeEventListener('offline', onOffline);
			window.removeEventListener('online', onOnline);
		};
	});

	// In-flight assistant render state. While streaming we show a transient
	// "assistant" bubble that isn't yet a row in the messages array; on `done`
	// we splice the canonical persisted ChatMessage into messages.
	// In-flight content is a single ordered list of segments — reasoning,
	// text, and tool_call interleaved in arrival order. The mutation
	// helpers + the segments-to-blocks conversion are pure functions in
	// $lib/chat-render so they can be vitest-tested independently of the
	// Svelte component.
	// inFlightSegments lifted to the top of the script — see the
	// pending-approval derivations that depend on it. The other three
	// pieces of in-flight state stay here next to the helper functions
	// that mutate them.
	let inFlightOpen = $state(false);
	let inFlightProgress = $state<number | null>(null);
	let inFlightStatus = $state<string | null>(null);
	// Set when the server emits a `queued` event (the endpoint's
	// max_concurrent was full); cleared by resetInFlightSegments at turn
	// boundaries and by the first real generation event below. Drives the
	// "Queued…" placeholder in the in-flight bubble.
	let inFlightQueued = $state<{ ahead: number } | null>(null);

	// --- Multi-model fan-out -------------------------------------------------
	// Models staged for a comparison (the composer chips). When non-empty, the
	// next send fans the prompt out to each instead of a single send.
	let fanoutModels = $state<FanoutModel[]>([]);
	// Live + settled comparison columns. Non-empty == the compare view is up.
	let fanoutColumns = $state<FanoutColumn[]>([]);
	// A pick/dismiss request is in flight.
	let fanoutPicking = $state(false);
	// Per-branch abort controllers, keyed by column branchId, for Stop.
	const fanoutAborts = new Map<string, AbortController>();
	const fanoutComparing = $derived(fanoutColumns.length > 0);
	const fanoutStreaming = $derived(
		fanoutColumns.some((c) => c.status === 'queued' || c.status === 'streaming'),
	);
	const fanoutColumnsSettled = $derived(fanoutComparing && allColumnsSettled(fanoutColumns));

	function modelDisplayName(modelId: string | null): string {
		if (!modelId) return 'Model';
		return data.models.find((m) => m.id === modelId)?.displayName ?? modelId;
	}

	function addFanoutModel() {
		const m = data.models.find((x) => x.id === modelId);
		if (!m || m.kind !== 'chat') return;
		fanoutModels = [
			...fanoutModels,
			{ modelId: m.id, modelKind: m.kind, displayName: m.displayName },
		];
	}
	function removeFanoutModel(index: number) {
		fanoutModels = fanoutModels.filter((_, i) => i !== index);
	}

	function resetInFlightSegments() {
		inFlightSegments = [];
		inFlightQueued = null;
	}
	function appendInFlightText(chunk: string) {
		inFlightSegments = inFlightAppendText(inFlightSegments, chunk);
	}
	function appendInFlightReasoning(chunk: string) {
		inFlightSegments = inFlightAppendReasoning(inFlightSegments, chunk);
	}
	function pushInFlightToolCall(toolCallId: string, toolName: string) {
		inFlightSegments = inFlightPushToolCall(inFlightSegments, toolCallId, toolName);
	}
	function updateInFlightToolCallArgs(toolCallId: string, argsDelta: string) {
		inFlightSegments = inFlightUpdateToolCallArgs(inFlightSegments, toolCallId, argsDelta);
	}
	function updateInFlightToolCallResult(toolCallId: string, result: string, isError: boolean) {
		inFlightSegments = inFlightUpdateToolCallResult(inFlightSegments, toolCallId, result, isError);
	}
	function markInFlightToolCallPendingApproval(toolCallId: string, toolName: string, args: string) {
		inFlightSegments = inFlightMarkToolCallPendingApproval(
			inFlightSegments,
			toolCallId,
			toolName,
			args,
		);
	}

	const inFlightBlocks = $derived(inFlightToBlocks(inFlightSegments));

	// rAF-coalesced per-segment markdown render. Each text segment grows
	// independently; we render each segment's HTML on the next frame
	// rather than on every chunk to cap markdown-it cost at ~60Hz no
	// matter how fast the upstream streams tokens.
	//
	// Critically the callback does NOT reassign `inFlightSegments` — Svelte
	// 5's $state proxy wraps each array element, so mutating `s.html` in
	// place triggers reactivity for every reader that touched that field
	// (notably `inFlightBlocks`). Reassigning the array would re-trigger
	// this very effect (which reads `inFlightSegments` to iterate), causing
	// a self-perpetuating rAF loop at 60Hz that fires the auto-scroll
	// effect each frame — which yanked the scroll position back to the
	// bottom whenever the user tried to scroll up, even when idle.
	let inFlightHtmlFrame = 0;
	$effect(() => {
		// Touch every text segment's text so the effect re-runs whenever
		// any of them grows.
		for (const s of inFlightSegments) {
			if (s.kind === 'text') void s.text;
		}
		if (inFlightHtmlFrame !== 0) return;
		inFlightHtmlFrame = requestAnimationFrame(() => {
			inFlightHtmlFrame = 0;
			for (const s of inFlightSegments) {
				if (s.kind !== 'text') continue;
				if (s.htmlFromText === s.text) continue;
				s.html = renderLiveMarkdown(s.text);
				s.htmlFromText = s.text;
			}
		});
	});

	// Server-reported truth: a generation is running for this conversation
	// but this client isn't the one driving it — its fetch died (iOS
	// suspended the PWA, the network dropped). `serverInFlightSince` is
	// mirrored from the load function; `recoveredInFlight` means "show the
	// bubble hydrated from the registry, not from a live local fetch."
	//
	// The leaf check matters: the registry entry lingers a little past the
	// message itself (the SSE stream stays open through the background
	// title task), so `serverInFlightSince` can still be set for a
	// generation that already produced its assistant turn. If `messages`
	// already ends in an assistant message, there's nothing to recover.
	const recoveredInFlight = $derived(
		serverInFlightSince !== null &&
			!inFlightOpen &&
			// A live/parked fan-out owns the in-flight display via its columns,
			// so don't also surface the single recovered bubble — its N branches
			// keep serverInFlightSince set while the leaf sits on the user message.
			!fanoutComparing &&
			messages[messages.length - 1]?.role !== 'assistant',
	);
	// The in-flight bubble shows for either a live local turn or a
	// recovered one.
	const showInFlight = $derived(inFlightOpen || recoveredInFlight);
	// A generation is in progress, whether or not this client is driving
	// it — gates composer input + message actions the same as a live
	// turn. Includes the approval-resume window (`approvalSubmitting`)
	// so the composer disables and the Send button flips to Stop while
	// the resumed iteration is streaming, AND the pending-approval
	// window so the user can't type a new message while the existing
	// turn is suspended waiting on a tool decision.
	const generating = $derived(
		busy || approvalSubmitting || recoveredInFlight || hasAnyPendingApproval || fanoutComparing,
	);

	// Tick a timer while the in-flight bubble is open so the user gets a
	// progress signal for slow operations (image generation, video gen) and
	// also for chat round-trips that stall before the first token.
	let elapsedSeconds = $state(0);
	$effect(() => {
		if (!showInFlight) {
			elapsedSeconds = 0;
			return;
		}
		// A recovered bubble counts from the server-reported start time so
		// the timer stays honest after a suspension; a live local turn
		// counts from now (when this send began).
		const startedAt =
			recoveredInFlight && serverInFlightSince !== null ? serverInFlightSince : Date.now();
		elapsedSeconds = (Date.now() - startedAt) / 1000;
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
				: 'Thinking',
	);

	// Abandon the in-flight turn when navigating to a different
	// conversation. This component instance is reused across
	// /chat/[id] -> /chat/[id] navigations (same route), so a send
	// fired in conversation A keeps its fetch + closure alive after the
	// user switches to conversation B. Without this reset B inherits A's
	// open "Thinking…/Generating…" bubble, and A's completion handler
	// would graft A's messages onto B's list. Aborting the fetch is
	// safe: the server keeps generating regardless of the client
	// connection (see streaming/relay.ts) and fires its push
	// notification when done, so the work isn't lost — the user just
	// gets notified instead of watching it.
	let previousConvId: string | undefined;
	$effect(() => {
		const id = data.conversation.id;
		if (id === previousConvId) return;
		previousConvId = id;
		activeAbort?.abort();
		activeAbort = null;
		busy = false;
		inFlightOpen = false;
		resetInFlightSegments();
		inFlightProgress = null;
		inFlightStatus = null;
		errorMsg = null;
		// Tear down any fan-out from the conversation we're leaving — abort
		// its in-flight branches and drop the comparison state. The new
		// conversation's columns (if any) re-hydrate from its load data below.
		for (const a of fanoutAborts.values()) a.abort();
		fanoutAborts.clear();
		fanoutColumns = [];
		fanoutModels = [];
	});

	// Re-hydrate the compare columns from server data after a reload (or a
	// conversation switch into a parked fan-out). The load function surfaces
	// the assistant siblings whenever the active-branch tail is a user message
	// — only a fan-out parks the leaf there with multiple children. Guarded to
	// `>= 2` siblings (a genuine comparison) so a stray single off-branch
	// message (e.g. from a truncate) can't masquerade as one, and skipped
	// whenever a live comparison already owns `fanoutColumns`.
	$effect(() => {
		const sibs = data.fanoutSiblings;
		if (!sibs || sibs.length < 2) return;
		untrack(() => {
			if (fanoutColumns.length > 0 || busy) return;
			fanoutColumns = sibs.map((m) => ({
				branchId: m.id,
				modelId: m.modelUsed ?? '',
				modelKind: 'chat' as const,
				label: modelDisplayName(m.modelUsed),
				segments: [],
				status: 'done' as const,
				queuedAhead: 0,
				persisted: m,
				error: null,
			}));
		});
	});

	// While a generation runs server-side that this client isn't driving
	// (a recovered bubble — the local fetch died to an iOS suspension or
	// dropped connection), poll the lightweight conversation endpoint so
	// the "Generating…" bubble resolves the moment the generation finishes
	// — even if the user just stays in the app. invalidateAll() is too
	// heavy to poll (it re-fetches every endpoint's model list); the GET
	// endpoint is DB-only.
	$effect(() => {
		if (!recoveredInFlight) return;
		const id = convId;
		let stopped = false;
		const interval = setInterval(async () => {
			try {
				const res = await fetch(`/api/conversations/${id}`);
				if (stopped || !res.ok) return;
				const body = (await res.json()) as {
					conversation: { messages: Array<{ role: string }> };
					inFlightSince: number | null;
				};
				// Done when the assistant turn has landed (the timely
				// signal — beats the registry, which lingers through the
				// title task) or the registry cleared with no message
				// (a cancelled generation).
				const msgs = body.conversation.messages;
				const finished = msgs[msgs.length - 1]?.role === 'assistant' || body.inFlightSince === null;
				if (finished && !stopped) {
					stopped = true;
					clearInterval(interval);
					// One full reload to pull in the finished message, the
					// AI title, and the now-cleared in-flight state.
					await invalidateAll();
				}
			} catch {
				// Transient — the next tick retries.
			}
		}, 4000);
		return () => {
			stopped = true;
			clearInterval(interval);
		};
	});

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
	function buildOptimisticUserMessage(text: string, attachedMediaIds: string[]): ChatMessage {
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
			createdAt: Date.now(),
		};
	}

	/**
	 * Drive the SSE consumer (extracted to $lib/consume-chat-stream so
	 * its event-loop semantics can be unit-tested) with the chat-page
	 * UI bindings. Used by the initial send / edit / retry path
	 * (sendStreaming below) AND the approval-resume path
	 * (runApprovalStream further down) — both flows want identical
	 * handling, including `tool_pending_approval` flipping the in-flight
	 * tool segment to render the inline Allow/Always/Reject buttons live.
	 *
	 * Returns whether the stream included tool calls so the caller can
	 * decide between (a) keeping the in-flight bubble visible until
	 * invalidate lands the canonical intermediate rows or (b) clearing
	 * it immediately for single-iteration turns.
	 */
	function runChatStream(
		body: ReadableStream<Uint8Array>,
		ctx: {
			turnConvId: string;
			optimisticId: string | null;
			/** Fired when `done` arrives so the caller can flip its busy
			 *  flag mid-stream (background title delivery still keeps the
			 *  SSE open after done in the messages POST path). */
			onDone?: () => void;
		},
	): Promise<{ sawToolCalls: boolean }> {
		return consumeChatStream(body, {
			// Abandoned mid-stream by a conversation switch — stop
			// touching shared render state; it belongs to a different
			// conversation now.
			shouldContinue: () => convId === ctx.turnConvId,
			onQueued(ahead) {
				// Waiting on a per-endpoint concurrency slot. Show "Queued…"
				// until the slot is granted and the first real event lands.
				inFlightQueued = { ahead };
			},
			async onStart(userMessage) {
				inFlightQueued = null;
				// Send / edit: replace the optimistic placeholder with
				// the canonical persisted user message. Retry +
				// resume: no optimistic id (resume's start event
				// carries the prior user message we already render),
				// so this branch is a no-op.
				if (ctx.optimisticId) {
					messages = messages.some((m) => m.id === ctx.optimisticId)
						? messages.map((m) => (m.id === ctx.optimisticId ? userMessage : m))
						: [...messages, userMessage];
					await tick();
					scrollToBottom();
				}
			},
			onText(chunk) {
				inFlightQueued = null;
				appendInFlightText(chunk);
				if (isNearBottom) scrollToBottom();
			},
			onReasoning(chunk) {
				inFlightQueued = null;
				appendInFlightReasoning(chunk);
				if (isNearBottom) scrollToBottom();
			},
			onToolCallStart(toolCallId, toolName) {
				inFlightQueued = null;
				pushInFlightToolCall(toolCallId, toolName);
				if (isNearBottom) scrollToBottom();
			},
			onToolCallArgsDelta(toolCallId, argumentsDelta) {
				updateInFlightToolCallArgs(toolCallId, argumentsDelta);
			},
			onToolCallResult(toolCallId, result, isError) {
				updateInFlightToolCallResult(toolCallId, result, isError);
			},
			onToolPendingApproval(toolCallId, toolName, args) {
				// Untrusted MCP tool — the relay halted before
				// executing. Flip the in-flight segment to
				// pending_approval so the Allow/Always/Reject buttons
				// appear right where the tool call rendered, without
				// waiting for the post-stream invalidate.
				markInFlightToolCallPendingApproval(toolCallId, toolName, args);
				if (isNearBottom) scrollToBottom();
			},
			onProgress(percent, status) {
				inFlightQueued = null;
				inFlightProgress = percent;
				inFlightStatus = status;
			},
			onTitle(newTitle) {
				// Task-model auto-title arrived ahead of `done`. Update
				// the chat-page header immediately; the sidebar
				// refreshes via invalidateAll after the stream closes.
				title = newTitle;
			},
			onDone({ assistantMessage, sawToolCalls }) {
				// Single-iteration turn: optimistically append the
				// final assistant message and clear in-flight — snappy
				// because `done`'s message is the only new server-side
				// row.
				//
				// Multi-iteration turn (sawToolCalls): `done` carries
				// only the FINAL iteration's row; the intermediate
				// assistant + role:'tool' rows live in the DB and come
				// back via invalidateAll once the stream closes. Keep
				// the in-flight bubble visible until then so the user
				// doesn't stare at a blank gap.
				streamedMessageId = assistantMessage.id;
				if (!sawToolCalls) {
					messages = [...messages, assistantMessage];
					inFlightOpen = false;
					resetInFlightSegments();
				}
				inFlightProgress = null;
				inFlightStatus = null;
				ctx.onDone?.();
			},
			onError(message) {
				errorMsg = message;
				inFlightOpen = false;
				inFlightProgress = null;
				inFlightStatus = null;
				resetInFlightSegments();
			},
		});
	}

	// SendOptions used to live inline here; extracted to
	// `$lib/chat-send-body` so the wire body construction can be
	// unit-tested in isolation. The chat-page uses the same shape
	// for one additional client-only purpose: `editedMessageId`
	// also drives the optimistic-insert trim below (slicing the old
	// branch's continuation out of the visible list so the new
	// in-flight bubble doesn't briefly stream beneath stale tail
	// messages — symmetric counterpart to retry's `retryFromMessageId`
	// slice). That client-side use is unchanged; only the wire-body
	// construction moved.

	/**
	 * Shared front-half for both send paths (sendStreaming and
	 * sendImageGeneration). Snapshots the conversation id for the
	 * abandon-on-conversation-switch guards, installs a fresh
	 * AbortController as the active one (so Stop / a newer turn can
	 * abort this one), and builds the wire body once. The optimistic-
	 * bubble setup stays in sendStreaming since the image branch
	 * receives `optimisticId` as input from its caller.
	 */
	function startTurn(text: string, attachedMediaIds: string[], options: SendOptions) {
		const turnConvId = convId;
		const isRetry = !!options.retryFromMessageId;
		const abort = new AbortController();
		activeAbort = abort;
		// Wire body construction lives in `buildSendRequestBody` — see
		// that module for the three modes (retry, edit, plain send) and
		// why the field-spread shape matters.
		const requestBody = buildSendRequestBody({
			text,
			attachedMediaIds,
			modelId,
			modelKind,
			options,
		});
		return { turnConvId, isRetry, abort, requestBody };
	}

	/**
	 * Shared catch-side reconciliation for both send paths.
	 *
	 * AbortError from clicking Stop is expected — don't surface as a
	 * user-facing error. The server-side recorder will have committed
	 * whatever partial text it had; invalidateAll picks that up.
	 *
	 * wasHiddenDuringFetch / wasOfflineDuringFetch are the "client
	 * connection died, server still has the generation" cases: iOS
	 * suspension and network handoff (wifi↔cellular, dead zone,
	 * airplane-mode toggle) respectively. Either way the fetch error
	 * is a connectivity artifact, not a real server-side failure, so
	 * we re-sync against the conversation instead of surfacing a
	 * misleading toast. The actual generation is whatever the server
	 * made of it — completed, still running, or genuinely errored on
	 * its end — and the invalidate picks up whichever.
	 *
	 * All of this is render state for `turnConvId`'s thread — skip it
	 * entirely if the user has since navigated away (the abandon-on-
	 * navigation $effect already cleaned up).
	 */
	function handleSendError(e: unknown, turnConvId: string): void {
		if (convId !== turnConvId) return;
		if (isAbortError(e) || wasHiddenDuringFetch || wasOfflineDuringFetch) {
			void invalidateAll();
		} else {
			errorMsg = e instanceof Error ? e.message : String(e);
		}
		inFlightOpen = false;
	}

	async function sendStreaming(
		text: string,
		attachedMediaIds: string[] = [],
		options: SendOptions = {},
	) {
		// The conversation this turn belongs to. The chat-page component
		// is reused across conversation navigations, so by the time an
		// await below resolves the user may be looking at a different
		// conversation — every post-await mutation of shared render state
		// is guarded against `convId` having moved on.
		const turnConvId = convId;
		// First exchange ⇒ the server runs the auto-title task once the
		// response lands; drives the sidebar's title spinner below.
		const isFirstExchange = messages.length === 0;
		busy = true;
		errorMsg = null;
		wasHiddenDuringFetch = false;
		wasOfflineDuringFetch = false;
		resetInFlightSegments();
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
		// Tracks whether ANY tool_call SSE event arrived during this turn.
		// When true, we know the server's multi-iteration loop ran and the
		// `done` event's single `assistantMessage` is just the LAST
		// iteration's row — there are intermediate assistant + tool rows
		// in the DB that `done` doesn't carry. Skip the optimistic append
		// in that case and rely on invalidateAll to populate the full
		// sequence in the right order. Without this, the user briefly sees
		// only the final answer, then the intermediate "tool-call" bubble
		// pops in above it once invalidate lands.
		let sawToolCalls = false;
		if (isRetry) {
			// Trim the retry target AND everything in its multi-iteration
			// tool chain — walk back from the target through preceding
			// assistant/tool rows until the user message that started the
			// turn. Server-side retry re-anchors at that user message
			// (same logic, see api/conversations/[id]/messages/+server.ts).
			// Without this walk-back the user sees stale iter-0 bubbles
			// (assistant + tool) hanging above the in-flight regeneration.
			const retryIdx = messages.findIndex((m) => m.id === options.retryFromMessageId);
			if (retryIdx >= 0) {
				let cutIdx = retryIdx;
				while (cutIdx > 0 && messages[cutIdx - 1].role !== 'user') {
					cutIdx--;
				}
				messages = messages.slice(0, cutIdx);
			}
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
		}
		// Flip the in-flight bubble on BEFORE the tick+scroll so the
		// "Thinking…/Generating…" row is in the DOM when we measure.
		// Otherwise scrollToBottom lands with the optimistic user message
		// at the viewport bottom and the in-flight bubble renders one row
		// below it, off-screen — the user has to scroll manually to see
		// that anything is happening.
		inFlightOpen = true;
		if (!isRetry) {
			await tick();
			scrollToBottom();
		}

		// Image-kind conversations use the sync JSON path — there's nothing
		// to stream (one-shot generate). Chat and video both stream via SSE
		// (chat for tokens, video for poll-based progress events).
		if (modelKind === 'image') {
			await sendImageGeneration(text, attachedMediaIds, optimisticId, options);
			return;
		}

		// First message of a conversation ⇒ the server auto-titles it once
		// the response lands. Flag the sidebar spinner now, at submit time,
		// so the title slot reads as "a title is coming" instead of sitting
		// on "Untitled" and then snapping to a title. `clearTitlePending`
		// in the `finally` removes it once the title task has run.
		if (isFirstExchange) markTitlePending(turnConvId);

		const { abort, requestBody } = startTurn(text, attachedMediaIds, options);
		try {
			const res = await fetch(`/api/conversations/${convId}/messages?stream=1`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'text/event-stream',
				},
				body: JSON.stringify(requestBody),
				signal: abort.signal,
			});
			if (!res.ok) {
				throw new Error(await errorMessageFromResponse(res));
			}
			if (!res.body) throw new Error('Server returned no body');

			const consumed = await runChatStream(res.body, {
				turnConvId,
				optimisticId,
				onDone: () => {
					// Release the composer now — `done` means the response
					// is complete. The relay deliberately keeps the SSE
					// stream open past this point so the background
					// auto-title task can still deliver a `title` event
					// (first exchange only); the for-await loop keeps
					// reading for it. But the user must not be blocked
					// from sending a follow-up while a cosmetic title
					// generates, so `busy` releases here rather than in
					// `finally` (which only runs once the stream
					// actually closes).
					busy = false;
				},
			});
			sawToolCalls = consumed.sawToolCalls;
			if (convId === turnConvId) {
				// Await the reload so the in-flight bubble (still visible for
				// multi-iteration tool turns — see the `done` handler) only
				// clears once the canonical message rows are in `messages`.
				// Without this, the user stares at a blank gap for as long
				// as the load functions take (model-list fetch, etc.).
				await invalidateAll();
				if (sawToolCalls) {
					inFlightOpen = false;
					resetInFlightSegments();
					inFlightProgress = null;
					inFlightStatus = null;
				}
			}
		} catch (e) {
			handleSendError(e, turnConvId);
		} finally {
			// The stream has closed — the title task (if any) has delivered
			// or timed out. Drop the sidebar spinner. Gated on isFirstExchange
			// so a fast follow-up turn can't clear a spinner it didn't set.
			if (isFirstExchange) clearTitlePending(turnConvId);
			// Only the turn that still owns the controller clears it — a
			// conversation switch (or a newer turn) may have replaced it.
			// The in-flight transients live here (not in the 'done' / 'error'
			// cases) so a stream that closes without either event — or a
			// success/catch path that early-returned on a convId mismatch —
			// still leaves the bubble closed.
			if (activeAbort === abort) {
				inFlightOpen = false;
				resetInFlightSegments();
				inFlightProgress = null;
				inFlightStatus = null;
				busy = false;
				activeAbort = null;
			}
		}
	}

	async function sendImageGeneration(
		text: string,
		attachedMediaIds: string[] = [],
		optimisticId: string | null = null,
		options: SendOptions = {},
	) {
		// See sendStreaming — the component is reused across conversation
		// navigations, so the result of this (20-60s) request must not be
		// grafted onto whatever conversation is on screen when it lands.
		const { turnConvId, isRetry, abort, requestBody } = startTurn(text, attachedMediaIds, options);
		try {
			const res = await fetch(`/api/conversations/${convId}/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody),
				signal: abort.signal,
			});
			if (!res.ok) {
				throw new Error(await errorMessageFromResponse(res));
			}
			const body = (await res.json()) as SendMessageResponse;
			// Abandoned by a conversation switch while the request was in
			// flight. The server still persisted the result — it'll show
			// on this thread's next load — so just drop it here rather
			// than splicing it into whatever conversation is on screen.
			if (convId !== turnConvId) return;
			// Send / edit: drop optimistic, then append both canonical rows.
			// Retry: only append the new assistant — the user message
			// already exists in the array.
			streamedMessageId = body.assistantMessage.id;
			if (isRetry) {
				messages = [...messages, body.assistantMessage];
			} else {
				messages = (optimisticId ? messages.filter((m) => m.id !== optimisticId) : messages).concat(
					[body.userMessage, body.assistantMessage],
				);
			}
			// Image branch is non-streaming, so the task-model title (if
			// any) piggybacks on the response body rather than an SSE
			// frame. Same effect as the streaming 'title' case: update
			// the local header now; invalidateAll below refreshes sidebar.
			if (body.title) {
				title = body.title;
			}
			inFlightOpen = false;
			void invalidateAll();
		} catch (e) {
			handleSendError(e, turnConvId);
		} finally {
			// Only the turn that still owns the controller clears it. The
			// in-flight bubble close lives here (not in the success / catch
			// branches above) so a path that early-returned on a convId
			// mismatch — or a thrown body parse — still resets the bubble.
			if (activeAbort === abort) {
				inFlightOpen = false;
				busy = false;
				activeAbort = null;
			}
		}
	}

	async function stop() {
		// A streaming fan-out has its own per-branch controllers; cancel them
		// all (and the server-side generations) rather than the single-turn
		// abort path below.
		if (fanoutStreaming) {
			await stopFanout();
			return;
		}
		const abort = activeAbort;
		// A recovered bubble has no local fetch to abort, but the server
		// generation is still registered — /cancel reaches it by
		// conversation id all the same.
		if (!abort && !recoveredInFlight) return;
		// Tell the server to tear down upstream first (so the bridge stops
		// generating instead of running to completion). Then abort the local
		// fetch so we stop receiving the in-flight events.
		try {
			await fetch(`/api/conversations/${convId}/cancel`, { method: 'POST' });
		} catch {
			// Best-effort — even if the cancel POST fails, aborting locally
			// still gives the user the "stopped" UX.
		}
		if (abort) {
			abort.abort();
		} else {
			// Recovered case: nothing local to abort. Re-sync so the
			// cancelled state lands; the recovery poll backstops this if
			// the server hasn't finished tearing down yet.
			void invalidateAll();
		}
	}

	function isAbortError(e: unknown): boolean {
		if (e instanceof DOMException && e.name === 'AbortError') return true;
		if (e instanceof Error && e.name === 'AbortError') return true;
		return false;
	}

	async function send() {
		const text = composerText.trim();
		if ((!text && attachments.items.length === 0) || generating) return;
		if (attachments.isBusy) return;
		const attachedMediaIds = attachments.readyMediaIds();
		// Editing: send the new message as a sibling under the same parent
		// as the original. The original stays in the DB as an alt branch.
		const editParent = editingParentId;
		composerText = '';
		attachments.clear();
		editingMessageId = null;
		editingParentId = null;
		// Multi-model fan-out takes precedence over a single send (and over an
		// in-progress edit — comparing is a fresh turn, not an edit).
		if (fanoutModels.length > 0) {
			const models = fanoutModels;
			fanoutModels = [];
			await sendFanout(text, attachedMediaIds, models);
			return;
		}
		await sendStreaming(text, attachedMediaIds, editParent ? { parentMessageId: editParent } : {});
	}

	/**
	 * Fan one prompt out to N models. Creates the shared user message once
	 * (POST /prepare), then streams a sibling assistant response per model into
	 * its own column. The active leaf stays pinned at the user message
	 * (server-side, advanceActiveLeaf:false) so every branch serializes the
	 * identical history and the unpicked siblings remain reachable; picking a
	 * column promotes it to the active thread.
	 */
	async function sendFanout(
		text: string,
		attachedMediaIds: string[],
		models: FanoutModel[],
	): Promise<void> {
		const turnConvId = convId;
		const isFirstExchange = messages.length === 0;
		busy = true;
		errorMsg = null;

		// 1. Create the shared user message (no dispatch).
		let userMessage: ChatMessage;
		try {
			const res = await fetch(`/api/conversations/${convId}/messages/prepare`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text, attachedMediaIds } satisfies PrepareFanoutRequest),
			});
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			userMessage = ((await res.json()) as PrepareFanoutResponse).userMessage;
		} catch (e) {
			if (convId === turnConvId) errorMsg = e instanceof Error ? e.message : String(e);
			busy = false;
			return;
		}
		if (convId !== turnConvId) {
			busy = false;
			return;
		}

		// 2. Render the user message and spin up the columns.
		messages = [...messages, userMessage];
		if (isFirstExchange) markTitlePending(turnConvId);
		fanoutColumns = models.map((m, i) => ({
			branchId: `${userMessage.id}:${i}`,
			modelId: m.modelId,
			modelKind: m.modelKind,
			label: m.displayName,
			segments: [],
			status: 'queued' as const,
			queuedAhead: 0,
			persisted: null,
			error: null,
		}));
		await tick();
		scrollToBottom();
		// The compare view (fanoutComparing) now keeps the composer disabled
		// until the user picks; the per-turn `busy` flag can release.
		busy = false;

		// 3. Stream every branch concurrently.
		await Promise.all(fanoutColumns.map((col) => runFanoutBranch(turnConvId, userMessage.id, col)));
		if (convId === turnConvId) clearTitlePending(turnConvId);
	}

	/** Drive one fan-out branch's SSE stream into its column's state. */
	async function runFanoutBranch(
		turnConvId: string,
		userMessageId: string,
		col: FanoutColumn,
	): Promise<void> {
		const abort = new AbortController();
		fanoutAborts.set(col.branchId, abort);
		try {
			const res = await fetch(`/api/conversations/${turnConvId}/messages?stream=1`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
				body: JSON.stringify(
					buildFanoutBranchBody({
						parentMessageId: userMessageId,
						modelId: col.modelId,
						modelKind: col.modelKind,
					}),
				),
				signal: abort.signal,
			});
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			if (!res.body) throw new Error('Server returned no body');
			await consumeChatStream(res.body, {
				shouldContinue: () => convId === turnConvId,
				onQueued(ahead) {
					col.status = 'queued';
					col.queuedAhead = ahead;
				},
				onStart() {
					col.status = 'streaming';
				},
				onText(chunk) {
					col.status = 'streaming';
					col.segments = inFlightAppendText(col.segments, chunk);
				},
				onReasoning(chunk) {
					col.status = 'streaming';
					col.segments = inFlightAppendReasoning(col.segments, chunk);
				},
				onDone({ assistantMessage }) {
					col.persisted = assistantMessage;
					col.status = 'done';
				},
				onError(message) {
					col.error = message;
					col.status = 'error';
				},
			});
		} catch (e) {
			if (isAbortError(e)) col.status = 'cancelled';
			else {
				col.error = e instanceof Error ? e.message : String(e);
				col.status = 'error';
			}
		} finally {
			fanoutAborts.delete(col.branchId);
		}
	}

	/** Promote a column to the active thread: select its branch, drop the
	 *  compare view, and continue the conversation with that model. */
	async function pickFanout(col: FanoutColumn): Promise<void> {
		if (!col.persisted || fanoutPicking) return;
		fanoutPicking = true;
		const targetId = col.persisted.id;
		try {
			const res = await fetch(`/api/conversations/${convId}/messages/${targetId}/select`, {
				method: 'POST',
			});
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			fanoutColumns = [];
			streamedMessageId = targetId;
			await invalidateAll();
			// Continue with the chosen model — the picker reflects it now and
			// the next send persists it as the conversation's model. tick()
			// lets the data-sync effect (which resets modelId from the
			// unchanged conversation row) flush first so this assignment wins.
			await tick();
			modelId = col.modelId;
			modelKind = col.modelKind;
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			fanoutPicking = false;
		}
	}

	/** Abandon the comparison without an explicit choice: make the first
	 *  generated branch active (so the thread has a response), then re-sync. */
	async function dismissFanout(): Promise<void> {
		if (fanoutPicking) return;
		fanoutPicking = true;
		const firstPersisted = fanoutColumns.find((c) => c.persisted);
		fanoutColumns = [];
		try {
			if (firstPersisted?.persisted) {
				await fetch(`/api/conversations/${convId}/messages/${firstPersisted.persisted.id}/select`, {
					method: 'POST',
				});
			}
			await invalidateAll();
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			fanoutPicking = false;
		}
	}

	/** Stop a streaming fan-out: cancel every branch server-side + locally. */
	async function stopFanout(): Promise<void> {
		try {
			await fetch(`/api/conversations/${convId}/cancel`, { method: 'POST' });
		} catch {
			// Best-effort — aborting locally still gives the "stopped" UX.
		}
		for (const a of fanoutAborts.values()) a.abort();
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
		void inFlightSegments;
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
		const key = pendingFirstMessageKey(convId);
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
	onDestroy(() => editAttachments.destroy());

	// Drop the composer draft and any open inline-edit session when
	// navigating to a different conversation. Like the in-flight turn
	// state, these are component-local and the /chat/[id] component is
	// reused across conversation switches, so without this a half-typed
	// draft reappears in the next conversation — and worse, a stale
	// `editingMessageId` (whose target message doesn't exist in the new
	// conversation) hides the composer with no inline editor to replace
	// it, leaving no way to type. Guarded on a real id change so a
	// same-conversation invalidateAll() can't wipe a draft mid-compose.
	let composerResetConvId: string | undefined;
	$effect(() => {
		const id = data.conversation.id;
		if (id === composerResetConvId) return;
		composerResetConvId = id;
		composerText = '';
		editingMessageId = null;
		editingParentId = null;
		editText = '';
		editAttachments.clear();
	});

	function beginEdit(m: ChatMessage) {
		if (generating) return;
		editText = partsToText(m.parts);
		editAttachments.clear();
		for (const p of m.parts) {
			if (p.type === 'image') {
				editAttachments.attachExisting(p.mediaId);
			}
		}
		editingMessageId = m.id;
		editingParentId = m.parentMessageId ?? null;
	}

	function cancelEdit() {
		editingMessageId = null;
		editingParentId = null;
		editText = '';
		editAttachments.clear();
	}

	async function saveEdit() {
		const text = editText.trim();
		if ((!text && editAttachments.items.length === 0) || generating) return;
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
		if (generating) return;
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
		if (generating) return;
		errorMsg = null;
		try {
			const res = await fetch(`/api/conversations/${convId}/messages/${targetMessageId}/select`, {
				method: 'POST',
			});
			if (!res.ok) {
				throw new Error(await errorMessageFromResponse(res));
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
		if (generating) return;
		const ok = await confirmDialog.ask({
			title: 'Delete this branch?',
			message: 'This deletes the branch and every message on it. It cannot be undone.',
		});
		if (!ok) return;
		errorMsg = null;
		try {
			const res = await fetch(`/api/conversations/${convId}/messages/${m.id}/branch`, {
				method: 'DELETE',
			});
			if (!res.ok && res.status !== 404) {
				throw new Error(await errorMessageFromResponse(res));
			}
			await invalidateAll();
		} catch (e) {
			errorMsg = `Couldn't delete branch: ${e instanceof Error ? e.message : String(e)}`;
		}
	}
</script>

<div class="relative flex h-full flex-col">
	<ChatHeader {title} {assistantLabel} {contextTokenCount} />

	<!--
		Scroll area fills the full height *behind* the floating composer
		(see below); the message list pads its own bottom by the composer's
		measured height so the last message scrolls clear. No mask-fade —
		content now slides under the frosted-glass composer, which is the
		transition, rather than dissolving into the page bg.
	-->
	<div bind:this={scrollContainer} class="flex-1 overflow-x-hidden overflow-y-auto px-4 pt-4">
		<div
			class="mx-auto min-w-0 max-w-3xl space-y-4"
			style="padding-bottom: {composerHeight + 24}px"
		>
			{#each visibleMessages as m, i (m.id)}
				<!--
					Message + action-bar group. The actions row sits directly
					below the bubble, aligned to the same side (right for user
					messages, left for assistant), and reveals on hover at sm+.
					On mobile it stays visible since there's no hover.

					mergeWithPrev/mergeWithNext: consecutive assistant messages
					from a multi-iteration tool-using turn (iter 0 has tool_call
					parts, iter 1+ has the follow-up text) are persisted as
					separate rows but should render as ONE bubble — that's the
					"folded into assistant bubble" UX the user picked. We do it
					by collapsing the gap + sharing corners + suppressing the
					duplicate role label / interstitial action bar.
				-->
				{@const merge = mergeFlagsById.get(m.id) ?? { mergeWithPrev: false, mergeWithNext: false }}
				{@const mergeWithPrev = merge.mergeWithPrev}
				{@const mergeWithNext = merge.mergeWithNext}
				<!--
					Bubble-merge gap close. Tailwind v4's `space-y-4` sets
					`margin-block-end: 1rem` on EVERY child (not the v3 pattern
					of margin-top on subsequent siblings) — so the gap is the
					BOTTOM margin of the upper item, not the top of the lower.
					We override mb on mergeWithNext (closes the gap from above)
					and mt on mergeWithPrev (defensive — would matter if the
					parent ever switched back to a top-margin spacing scheme).
					Tailwind v4 important syntax is the `!` SUFFIX (`mb-0!`),
					not the v3 prefix (`!mb-0`).
				-->
				<div
					id="msg-{m.id}"
					in:fade={{
						duration: listMounted && !reduceMotion && m.id !== streamedMessageId ? 160 : 0,
					}}
					class={[
						'group rounded-lg transition-colors duration-1000',
						mergeWithPrev && 'mt-0!',
						mergeWithNext && 'mb-0!',
						m.id === highlightedMessageId && 'bg-amber-200/40 dark:bg-amber-500/15',
					]}
				>
					{#if m.id === editingMessageId}
						<!--
						Inline editor: replaces the static bubble with an
						editable surface in the same position so it's
						unambiguous WHICH message is being edited. Save creates
						a sibling under the original's parent (preserving the
						original as a branch); Cancel discards.
					-->
						<EditMessageForm
							bind:editText
							attachments={editAttachments}
							{allowAttachments}
							enterBehavior={data.prefs?.enterBehavior ?? 'send'}
							onSave={() => void saveEdit()}
							onCancel={cancelEdit}
						/>
					{:else}
						<MessageBubble
							message={m}
							{toolResultsByCallId}
							{userLabel}
							{assistantLabel}
							{mergeWithPrev}
							{mergeWithNext}
							onImageClick={openImageInLightbox}
							{openingLightboxFor}
							{approvalDecisions}
							approvalBusy={approvalSubmitting}
							{onApprovalSelect}
						/>
					{/if}
					{#if (m.role === 'user' || m.role === 'assistant') && m.id !== editingMessageId && !mergeWithNext}
						<MessageActions
							message={m}
							{generating}
							recentlyCopied={recentlyCopiedId === m.id}
							canCopy={hasCopyableText(m)}
							userSentTokens={m.role === 'user' ? userSentTokens[i] : null}
							onCopy={() => copyMessage(m)}
							onEdit={() => beginEdit(m)}
							onRetry={() => retryAssistant(m)}
							onSelectSibling={(id) => selectSibling(id)}
							onDeleteBranch={() => deleteBranch(m)}
						/>
					{/if}
				</div>
			{/each}

			{#if showInFlight}
				{@const last = visibleMessages[visibleMessages.length - 1]}
				{@const fuseWithPrevAssistant =
					!!last && last.role === 'assistant' && last.id !== editingMessageId}
				<div
					class={fuseWithPrevAssistant ? 'mt-0!' : ''}
					in:fade={{ duration: listMounted && !reduceMotion ? 160 : 0 }}
				>
					<InFlightBubble
						blocks={inFlightBlocks}
						{assistantLabel}
						label={inFlightLabel}
						status={inFlightStatus}
						progress={inFlightProgress}
						queued={inFlightQueued}
						{elapsedSeconds}
						onImageClick={openImageInLightbox}
						{openingLightboxFor}
						{approvalDecisions}
						approvalBusy={approvalSubmitting}
						{onApprovalSelect}
						mergeWithPrev={fuseWithPrevAssistant}
					/>
				</div>
			{/if}
			{#if fanoutComparing}
				<div in:fade={{ duration: listMounted && !reduceMotion ? 160 : 0 }}>
					<FanoutColumns
						columns={fanoutColumns}
						onPick={(c) => void pickFanout(c)}
						onImageClick={openImageInLightbox}
						busy={fanoutPicking}
					/>
					{#if fanoutColumnsSettled}
						<div class="mt-2 flex justify-center">
							<button
								type="button"
								onclick={() => void dismissFanout()}
								disabled={fanoutPicking}
								class="rounded-lg px-3 py-1.5 text-xs text-fg-muted transition hover:bg-surface-raised disabled:opacity-40"
							>
								Dismiss comparison
							</button>
						</div>
					{/if}
				</div>
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

	<!--
		Floating composer overlay. Absolutely positioned over the bottom of
		the scroll area so messages scroll *behind* the frosted glass (the
		Signature liquid-glass look). pointer-events-none lets wheel / clicks
		in the side margins fall through to the messages; the centered
		composer re-enables them. Its measured height pads the message list.
	-->
	<div class="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-4">
		<div class="pointer-events-auto relative mx-auto max-w-3xl" bind:clientHeight={composerHeight}>
			<ScrollToBottomButton
				visible={!isNearBottom}
				onClick={() => scrollToBottom({ smooth: true })}
			/>
			{#if editingMessageId}
				<!-- Composer hidden while editing: the edit happens inline on
					 the message bubble itself, with its own Save/Cancel
					 controls. Re-shown when the user dismisses the inline
					 editor. -->
			{:else}
				<!--
					Composer stays visible across the entire turn lifecycle —
					sending, generating, pending-approval, and resuming. The
					Allow / Allow Always / Reject buttons live inline with
					their tool_call blocks above; the composer here disables
					its textarea via `generating` so the user can't type a
					new message mid-turn, and the Send slot flips to a Stop
					button (canStop below) whenever there's a local fetch
					that can be aborted — meaning the user can always halt a
					runaway resumed generation, not just an initial one.
				-->
				<ChatComposer
					bind:this={composerRef}
					bind:composerText
					bind:modelId
					{errorMsg}
					{attachments}
					{modelKind}
					{disabledFeatures}
					featureCategories={data.featureCategories}
					models={data.models}
					favoritedIds={data.prefs?.favoriteModels ?? []}
					{allowAttachments}
					{hasValidModel}
					{generating}
					canStop={((busy || approvalSubmitting) && activeAbort != null) ||
						recoveredInFlight ||
						fanoutStreaming}
					enterBehavior={data.prefs?.enterBehavior ?? 'send'}
					{fanoutModels}
					onAddFanoutModel={addFanoutModel}
					onRemoveFanoutModel={removeFanoutModel}
					onSend={() => void send()}
					onStop={stop}
					onFeaturesChange={(next) => void persistDisabledFeatures(next)}
					onToggleFavorite={(id) => void toggleFavoriteModel(data.prefs?.favoriteModels ?? [], id)}
				/>
			{/if}
		</div>
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

	Dynamically imported on first open so the ~10 KB gz chunk stays out
	of the chat-route critical path — most chat sessions never tap an
	image. Vite caches the resolved module, so subsequent opens reuse
	it without a network fetch. The `{#await}` only mounts under the
	`{#if lightbox}` guard, which the fetch in openImageInLightbox sets
	~100-200 ms after the tap — easily long enough for the import chunk
	to land in parallel on the first open.
-->
{#if lightbox}
	{#await import('$lib/components/MediaLightbox.svelte') then { default: MediaLightbox }}
		<MediaLightbox media={lightbox} onClose={() => (lightbox = null)} inConversation />
	{/await}
{/if}
