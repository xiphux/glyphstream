<script lang="ts">
	import type { PageData } from './$types';
	import { browser } from '$app/environment';
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { prefersReducedMotion } from 'svelte/motion';
	import { goto, invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { observeSentinel } from '$lib/observe-sentinel';
	import { FanoutController } from '$lib/fanout-controller.svelte';
	import { ChatTurnController } from '$lib/chat-turn-controller.svelte';
	import { preferredFirstName } from '$lib/greeting';
	import { ensureLiveMarkdown, renderLiveMarkdown } from '$lib/markdown-live';
	import { ensureLiveHighlighter } from '$lib/markdown-live-shiki.svelte';
	import { buildApprovalDecisionsSnapshot, type ApprovalAction } from '$lib/approval-workflow';
	import { errorMessageFromResponse } from '$lib/fetch-error';
	import { toggleFavoriteModel } from '$lib/favorite-models';
	import { imageAttachment } from '$lib/model-capabilities';
	import { saveModelSet, deleteModelSet } from '$lib/model-sets';
	import { pendingFirstMessageKey } from '$lib/pending-first-message';
	import { dismissConversationNotifications } from '$lib/notification-dismiss';
	import {
		deriveReuseModels,
		upgradeToPresetModelId,
		PROMPT_REUSE_KEY,
		type PromptReuseIntent,
	} from '$lib/prompt-reuse';
	import { loadDraft, clearDraft, createDraftWriter } from '$lib/composer-draft';
	import { confirmDialog } from '$lib/confirm.svelte';
	import ChatComposer from '$lib/components/chat/ChatComposer.svelte';
	import ChatHeader from '$lib/components/chat/ChatHeader.svelte';
	import { CanvasController } from '$lib/canvas-controller.svelte';
	import { CompactionController } from '$lib/compaction-controller.svelte';
	import { EditSession } from '$lib/edit-session.svelte';
	import { privateView } from '$lib/private-chat.svelte';
	import { streamPresence } from '$lib/stream-presence.svelte';
	import {
		clearGenerating,
		isGenerating,
		markGenerating,
	} from '$lib/generating-conversations.svelte';
	import EditMessageForm from '$lib/components/chat/EditMessageForm.svelte';
	import InFlightBubble from '$lib/components/chat/InFlightBubble.svelte';
	import MessageActions from '$lib/components/chat/MessageActions.svelte';
	import MessageBubble from '$lib/components/chat/MessageBubble.svelte';
	import ScrollToBottomButton from '$lib/components/chat/ScrollToBottomButton.svelte';
	import {
		assistantLabelForMessage,
		buildRenderedConversation,
		CANVAS_TOOLS,
		computeMergeFlags,
		messageToBlocks,
		parseCanvasAck,
		splitCanvasCards,
		type RenderBlock,
	} from '$lib/chat-render';
	import { displayContextTokens, isCompactionSummary } from '$lib/chat-compaction';
	import CompactionSummary from '$lib/components/chat/CompactionSummary.svelte';
	import CompactionSummaryStreaming from '$lib/components/chat/CompactionSummaryStreaming.svelte';
	import ContextBudgetBar from '$lib/components/chat/ContextBudgetBar.svelte';
	import { AttachmentStore, attachmentsAllowedFor } from '$lib/attachments.svelte';
	import { resolve } from '$app/paths';
	import { stripSkillCommand } from '$lib/skill-command';
	import { hasCopyableText, partsToText } from '$lib/message-parts';
	import FanoutColumns from '$lib/components/chat/FanoutColumns.svelte';
	import {
		expandCompareSelections,
		expandFanoutBranches,
		type CompareSelection,
		type FanoutColumn,
		type FanoutModel,
	} from '$lib/fanout';
	import { toast } from '$lib/toast.svelte';
	import { isSnippetKind } from '$lib/types/api';
	import type {
		ChatMessage,
		ConversationMediaRef,
		FeatureCategory,
		MediaListItem,
		ModelKind,
	} from '$lib/types/api';

	let { data }: { data: PageData } = $props();

	// Friendly bubble labels: the user's preferred name (Preferences ▸ Name
	// if set, else GitHub display name's first token, else login) +
	// the model's friendly name (server resolves custom-model name).
	const userLabel = $derived(
		preferredFirstName(data.prefs?.name, data.user.displayName, data.user.email ?? 'You'),
	);
	const assistantLabel = $derived(data.assistantLabel);

	// Per-message assistant label — keeps a kept fan-out branch (or a per-turn
	// model override) reading as the model that actually produced it, instead
	// of the conversation default, once it's flipped to via the ‹N/M› sibling
	// nav. See assistantLabelForMessage for the fallback rules.
	const assistantLabelFor = (m: ChatMessage): string =>
		assistantLabelForMessage(m, data.conversation.modelId, assistantLabel, data.models);

	// Read data eagerly so SSR includes messages on first paint; $effect
	// below re-syncs on subsequent navigation invalidation. The warning
	// about capturing the initial value is intentional here — that IS the
	// behavior we want.
	//
	// `.raw`, not plain `$state`: every write to this array is a whole-array
	// reassign (`setMessages([...])`, `.slice`, the re-seed below) and nothing
	// anywhere mutates a ChatMessage in place, so the deep proxy buys nothing
	// and costs a proxy per message and per nested `parts[]` entry. On a long
	// code-heavy thread that's the difference between proxying the entire
	// conversation on every turn and not.
	// svelte-ignore state_referenced_locally
	let messages = $state.raw<ChatMessage[]>(data.conversation.messages);
	// svelte-ignore state_referenced_locally
	let title = $state<string | null>(data.conversation.title);
	// svelte-ignore state_referenced_locally
	let modelId = $state(data.conversation.modelId);
	// svelte-ignore state_referenced_locally
	let disabledFeatures = $state<FeatureCategory[]>([...data.conversation.disabledFeatures]);

	// Whether this is a "Private chat" (immutable content seal). Derived — it
	// tracks data.conversation across in-place navigations. Published to
	// `privateView` so the (app) layout paints the incognito re-tint while the
	// chat is open, and cleared when we leave it.
	let isPrivate = $derived(data.conversation.private);
	$effect(() => {
		// Read-only here (private is immutable once created): publish `active` for
		// the re-tint + the mobile top-bar badge, but no toggle.
		privateView.active = isPrivate;
		privateView.toggleable = false;
		privateView.onToggle = null;
		return () => privateView.reset();
	});

	// The custom-model preset this conversation was materialized from (if any).
	// Its system prompt + params are fixed for the thread server-side, so the
	// per-turn picker keeps showing the preset's name while its base model is
	// the one selected — otherwise the first follow-up reads as a silent switch
	// to the bare base model. Resolved from the layout's customModels list so
	// the preset's base is stable even after a per-turn switch mutates
	// conversation.modelId.
	const activePreset = $derived(
		data.conversation.customModelId
			? (data.customModels?.find((cm) => cm.id === data.conversation.customModelId) ?? null)
			: null,
	);
	const activePresetModelId = $derived(
		activePreset ? `${activePreset.baseEndpointId}::${activePreset.baseModelId}` : null,
	);

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

	// Side-by-side canvas pane. The server is authoritative; this holds the
	// live doc + open state. Seeded from the page load, updated by
	// canvas_version stream events during a turn (see ChatTurnController's
	// #runChatStream in $lib/chat-turn-controller.svelte, via the applyCanvas dep).
	const canvas = new CanvasController();
	// svelte-ignore state_referenced_locally
	canvas.hydrate(data.canvases);
	// The pane component is lazy-loaded once the conversation has a canvas (its
	// chunk stays off the chat-route critical path). Kept in a variable rather
	// than an {#await} so the open/close toggle below is a plain {#if}: Svelte
	// only plays a transition when an element is added/removed by a reactive
	// block, and an {#await} resolving with the pane already "open" would render
	// it as initial content (no intro). A stable {#if} makes the slide reliable.
	let CanvasPaneComp = $state<
		| import('svelte').Component<{
				doc: import('$lib/types/api').CanvasVersion;
				docs: Array<import('$lib/types/api').CanvasVersion>;
				changed: boolean;
				onClose: () => void;
				onSwitch: (artifactId: string) => void;
				onHighlightSettled: () => void;
		  }>
		| null
	>(null);
	$effect(() => {
		if (canvas.docs.length > 0 && !CanvasPaneComp) {
			void import('$lib/components/chat/CanvasPane.svelte').then(
				(m) => (CanvasPaneComp = m.default),
			);
		}
	});
	// svelte-ignore state_referenced_locally
	let hydratedCanvasConvId = data.conversation.id;
	// Tracks which conversation we've already auto-opened the canvas for, so the
	// auto-open fires once per entry (not on every reactive tick) and a manual
	// close isn't undone. Null so the first conversation counts — which takes both
	// call sites of `maybeAutoOpenCanvas` below, since the seeding effect skips
	// its own first run.
	let canvasAutoOpenedConvId: string | null = null;

	/**
	 * Auto-open the canvas beside the conversation on entry — but only on a wide
	 * viewport. On a small screen the pane is a full-screen overlay, so
	 * auto-opening would replace the conversation you just entered with a wall of
	 * document; there the inline card opens it on demand. Only ever called from an
	 * $effect (client-only), so `window.matchMedia` is safe.
	 *
	 * untrack the canvas reads: at both call sites `canvas.hydrate` has already
	 * run for this conversation, so `canvas.docs` is current — but WITHOUT untrack
	 * reading `canvas.docs.length` would make `canvas.docs` a dependency of the
	 * calling effect. A mid-turn `create_canvas`/`update_canvas` mutates
	 * `canvas.docs`, which would then re-fire the seeding effect and reset
	 * `messages` back to the (pre-turn) load data, making the user's just-sent
	 * prompt bubble vanish until the end-of-turn invalidateAll.
	 */
	function maybeAutoOpenCanvas(): void {
		untrack(() => {
			if (canvas.docs.length > 0 && canvasAutoOpenedConvId !== data.conversation.id) {
				canvasAutoOpenedConvId = data.conversation.id;
				if (window.matchMedia('(min-width: 768px)').matches) canvas.show();
			}
		});
	}
	// The `data.conversation` object we last re-seeded local state from. The
	// merged `data` prop gets a fresh identity whenever ANY load in the branch
	// re-runs — including a layout-only `invalidate('app:conversations')`, which
	// deliberately does not re-run this page's load (see +page.server.ts). In
	// that case `data.conversation` is the *reused* object from the last real
	// page load, i.e. a pre-turn snapshot: re-seeding from it would wipe the
	// messages this turn just appended and clobber a live-streamed title back to
	// null. Comparing identity re-seeds on a genuine page-data change (entering
	// another conversation, or the post-tool-turn invalidateAll) and skips the
	// layout-only refresh.
	// svelte-ignore state_referenced_locally
	let seededFromConversation: unknown = data.conversation;

	$effect(() => {
		if (data.conversation === seededFromConversation) return;
		seededFromConversation = data.conversation;
		messages = data.conversation.messages;
		title = data.conversation.title;
		modelId = data.conversation.modelId;
		convId = data.conversation.id;
		modelKind = data.conversation.modelKind;
		serverInFlightSince = data.inFlightSince;
		// Re-seed the canvas ONLY when switching conversations. A mid-turn
		// invalidateAll refreshes `data` with the same id — re-hydrating then
		// would reopen a pane the user closed and clobber the just-applied live
		// state, which already matches the persisted content.
		if (data.conversation.id !== hydratedCanvasConvId) {
			hydratedCanvasConvId = data.conversation.id;
			canvas.hydrate(data.canvases);
		}
		maybeAutoOpenCanvas();
	});

	// Also run it once at mount. The seeding effect above early-returns on its
	// first run (its sentinel starts at the current `data.conversation`), and
	// every other thing it seeds is separately initialized at its declaration —
	// the auto-open was the one that wasn't, so entering a chat by full page load
	// or from a non-chat route stopped opening the pane at all. Only the
	// /chat/a → /chat/b path still worked, because there the component is reused
	// and `data.conversation` identity genuinely changes.
	//
	// Deliberately reads nothing reactive (every read is inside `untrack`), so it
	// fires exactly once, after `canvas.hydrate` at init has populated `docs`.
	// `canvasAutoOpenedConvId` makes it idempotent against the call above.
	$effect(() => {
		maybeAutoOpenCanvas();
	});

	// Single-turn orchestration (send/edit/retry streaming, approval-resume,
	// server-truth recovery) + its shared render state — the in-flight bubble,
	// `busy`, `activeAbort`, `streamedMessageId`, the approval-resume latch, and
	// the suspend/offline flags — extracted to $lib/chat-turn-controller for
	// testability. Constructed up here (ahead of the fan-out controller) because
	// the approval-pending derivations below read `turn.inFlightSegments`. The
	// page owns the composer/picker bindings, the higher-level send() dispatch,
	// and a few effects that delegate here; the controller reaches shared page
	// state through these getters/setters. The `fanout.comparing` read is a
	// forward reference (fanout is constructed further down) — safe inside a
	// getter, which only runs after both controllers exist.
	// Explicitly typed (as is `fanout` below) to break the mutual-reference cycle:
	// turn's `fanoutComparing` reads `fanout`, fanout's `interrupted` reads `turn`,
	// and without the annotations TS infers each as `any` inside the other's
	// initializer.
	const turn: ChatTurnController = new ChatTurnController({
		convId: () => convId,
		getMessages: () => messages,
		setMessages: (next) => (messages = next),
		modelId: () => modelId,
		modelKind: () => modelKind,
		setError: (m) => (errorMsg = m),
		// A failed approval-resume is a turn-level failure — one resume covers the
		// whole batch of decisions, so there's no single tool block to pin it to.
		// Route it to the same banner every other turn error uses, which also
		// gives it the existing clear-on-navigate/branch-switch handling.
		setApprovalError: (m) => (errorMsg = m),
		clearApprovalDecisions: () => (approvalDecisions = new Map()),
		setTitle: (t) => (title = t),
		applyCanvas: (c) => canvas.apply(c),
		isNearBottom: () => isNearBottom,
		scrollToBottom: () => scrollToBottom(),
		serverInFlightSince: () => serverInFlightSince,
		fanoutComparing: () => fanout.comparing,
	});

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
			map.set(m.id, computeMergeFlags(visibleMessages, i, edit.messageId, turn.inFlightOpen));
		}
		return map;
	});

	// Canvas cards hoisted to the BOTTOM of each assistant group. The model
	// emits create_canvas/update_canvas in one message and its prose in a
	// follow-up message, so a per-message card lands above the reply. Instead we
	// gather each group's canvas edits (deduped to one card per artifact, latest
	// wins) and hand them to the group's LAST message, which renders them under
	// its text. Keyed by that last message's id.
	const canvasCardsByGroupLast = $derived.by(() => {
		const map = new Map<string, RenderBlock[]>();
		let group = new Map<string, RenderBlock>();
		for (const m of visibleMessages) {
			if (m.role !== 'assistant') {
				group = new Map();
				continue;
			}
			// Skip the block build entirely for the overwhelming majority of
			// assistant messages, which contain no canvas tool call at all. Building
			// every message's blocks just to collect canvas cards — and discarding
			// nearly all of it — made this O(messages x parts) of allocation on any
			// `messages` change, which after a turn is a fresh identity for all of
			// `visibleMessages`, `toolResultsByCallId` and `mergeFlagsById`.
			if (!m.parts.some((p) => p.type === 'tool_call' && CANVAS_TOOLS.has(p.toolName))) {
				if (!(mergeFlagsById.get(m.id)?.mergeWithNext ?? false)) {
					if (group.size > 0) map.set(m.id, [...group.values()]);
					group = new Map();
				}
				continue;
			}
			for (const card of splitCanvasCards(messageToBlocks(m, toolResultsByCallId)).cards) {
				if (card.type !== 'tool_call') continue;
				const key = parseCanvasAck(card.result).artifactId ?? card.toolCallId;
				group.set(key, card);
			}
			if (!(mergeFlagsById.get(m.id)?.mergeWithNext ?? false)) {
				if (group.size > 0) map.set(m.id, [...group.values()]);
				group = new Map();
			}
		}
		return map;
	});

	// User's per-tool decisions, accumulating until every pending tool
	// has one — at which point the Submit button enables and posts the
	// batch as a single resume request.
	let approvalDecisions = $state<Map<string, ApprovalAction>>(new Map());
	// `approvalSubmitting` (+ its monotonic latch token) lives on the turn
	// controller now — it owns the resume state machine.

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
		turn.inFlightSegments
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
		if (turn.approvalSubmitting) return;
		const ids = allPendingToolCallIds;
		untrack(() => {
			void turn.submitApproval(buildApprovalDecisionsSnapshot(ids, approvalDecisions));
		});
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
	let errorMsg = $state<string | null>(null);
	let scrollContainer = $state<HTMLElement | null>(null);

	// Per-page attachment store. The store eagerly POSTs to /api/uploads
	// as files are picked, so by send-time `readyMediaIds()` is just a
	// state read. See $lib/attachments.svelte.ts.
	const attachments = new AttachmentStore();
	const allowAttachments = $derived(attachmentsAllowedFor(modelKind));
	// Snippet filtering for the inline editor. The conversation's own kind, not
	// the composer's compare-cart-aware activeKind: you're editing a message
	// that belongs to THIS conversation.
	const editSnippetKind = $derived(isSnippetKind(modelKind) ? modelKind : null);
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
	// Scoped to the latest compaction boundary: usage from before a summary is
	// stale (it reflects the pre-compaction prompt), so right after a Compact
	// this reads 0 and the header drops to a bare count, self-correcting to the
	// real, smaller number on the next turn. See displayContextTokens.
	const contextTokenCount = $derived(displayContextTokens(messages));

	// The active model's total context window, when we know it. Read from the
	// model list rather than snapshotted onto the conversation, so a server
	// `--ctx-size` change is picked up on the next models-list load (navigation
	// or the 60s stale-while-revalidate refresh), not mid-session. Null →
	// ChatHeader shows just the raw token count, as before. See
	// extractContextWindow (server side).
	const modelContextWindow = $derived(
		data.models.find((m) => m.id === modelId)?.contextWindow ?? null,
	);

	// --- compaction ----------------------------------------------------------
	// Summarize older history through the conversation's own model, then refetch.
	// The manual button, the just-in-time auto pass before a send, and undo all
	// live in CompactionController; the page keeps only the view work — the
	// scroll-and-highlight below, which needs the DOM ids and `highlightedMessageId`.
	const compaction = new CompactionController({
		convId: () => data.conversation.id,
		getMessages: () => messages,
		turnBusy: () => turn.busy,
		fanoutComparing: () => fanout.comparing,
		contextWindow: () => modelContextWindow,
		autoCompactionEnabled: () => data.prefs?.autoCompactionEnabled ?? false,
		autoCompactionThreshold: () => data.prefs?.autoCompactionThreshold ?? 80,
		onCompacted: (summaryId) => {
			// Scroll to + briefly highlight the new summary so the result is visible:
			// the token number barely moves and the divider lands up-thread, so
			// without this a successful compaction looks like nothing happened.
			const el = document.getElementById(`summary-${summaryId}`);
			if (!el) return;
			el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
			highlightedMessageId = summaryId;
			setTimeout(() => {
				if (highlightedMessageId === summaryId) highlightedMessageId = null;
			}, 1500);
		},
	});

	// The context-budget bar (readout + Compact) lives just above the composer.
	// Show it once the conversation is actually doing something worth measuring —
	// a known size or an existing summary — so a fresh chat stays clean. Hidden
	// for non-chat kinds and during a fan-out comparison (where a single budget
	// number isn't meaningful and compaction is blocked). `$derived.by` for the
	// `fanout` forward-reference, as with the controller's `compactable`.
	const showBudgetBar = $derived.by(
		() =>
			modelKind !== 'image' &&
			modelKind !== 'video' &&
			!fanout.comparing &&
			(contextTokenCount > 0 || messages.some(isCompactionSummary)),
	);

	// Per-user-message "tokens we sent up to and including this turn":
	// the prompt_tokens of the next assistant message whose backend
	// reported usage. Computed once per `messages` change with a single
	// right-to-left sweep rather than once per row at render time —
	// the previous per-row lookup made the message list render O(N²).
	// Null when no downstream assistant reported usage (in-flight or
	// cancelled turn, or backend doesn't return usage).
	// Keyed by message id (not array index): visibleMessages drops tool rows and
	// repositions compaction summaries, so it no longer aligns 1:1 with the raw
	// `messages` branch this sweep walks.
	const userSentTokens = $derived.by(() => {
		const out = new Map<string, number | null>();
		let next: number | null = null;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === 'assistant') {
				if (m.tokensIn != null) next = m.tokensIn;
			} else if (m.role === 'user') {
				out.set(m.id, next);
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
	//
	// Compared against the last id rather than just read: touching
	// `data.conversation` makes the whole `data` prop a dependency, so this fired
	// on *any* invalidation, not just a conversation change. It was invisible
	// while every turn ended in `invalidateAll()` — the clear was immediately
	// followed by a re-seeded `messages`, which re-ran the auto-attach effect and
	// put the image back — but it meant each turn needlessly tore down and
	// rebuilt the composer's attachments, and a layout-only invalidation would
	// clear them with nothing to restore them.
	// svelte-ignore state_referenced_locally
	let attachmentsResetConvId = data.conversation.id;
	$effect(() => {
		if (data.conversation.id === attachmentsResetConvId) return;
		attachmentsResetConvId = data.conversation.id;
		attachments.clear();
		autoAttached = null;
		// Stale set from the previous conversation — cleared so it can't
		// briefly leak into a lightbox opened before the refetch lands.
		conversationMedia = [];
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

	// Ordered set the lightbox swipes/arrows between: every image/video in
	// the conversation, across ALL branches, oldest first. Fetched (not
	// derived from `visibleMessages`) because multi-image batches,
	// multi-model grids, and regenerate revisions are sibling branches —
	// only one sits on the active leaf path, so the message list would
	// surface just one image per generation point. `openImageInLightbox`
	// doubles as the resolver, fetching each swiped-to row's metadata.
	// `.raw` — replaced wholesale by the fetch below, never mutated in place.
	let conversationMedia = $state.raw<ConversationMediaRef[]>([]);
	async function loadConversationMedia() {
		try {
			const res = await fetch(`/api/conversations/${data.conversation.id}/media`);
			if (!res.ok) return; // carousel just stays single-item; non-fatal
			const body = (await res.json()) as { items: ConversationMediaRef[] };
			conversationMedia = body.items;
		} catch {
			// Network blip — leave the set as-is; the lightbox still opens
			// on the tapped image, just without sibling navigation.
		}
	}

	async function openImageInLightbox(mediaId: string) {
		if (openingLightboxFor === mediaId) return;
		// Initial open (lightbox was closed) — also (re)load the carousel
		// set so swipe/arrows have somewhere to go, and so just-generated
		// images are included. A swipe-driven navigate calls this with the
		// lightbox already open, so it skips the refetch.
		if (!lightbox) void loadConversationMedia();
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

	// --- viewport, focus + message-arrival state ---------------------------
	//
	// (Drag-drop and paste-to-attach are NOT here — they live on the composer
	// itself, in ComposerCore.svelte, feeding the same `attachments.addFiles()`
	// pipeline as the file picker. This header used to say otherwise.)
	//
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
	// An attachment rather than `bind:this` + a separate $effect: observeSentinel
	// already returns a disconnect cleanup, which is exactly an attachment's
	// contract, so the observer lives on the element it observes and the ref
	// state disappears. Reading `scrollContainer` inside still re-runs it if the
	// container changes, as the effect did.
	const observeNearBottom = (node: HTMLElement) =>
		observeSentinel(scrollContainer, node, (v) => (isNearBottom = v), {
			rootMargin: '0px 0px 100px 0px',
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
		// Start the lazy live-render chunks: the shiki subset (~72 KB gzip) and
		// markdown-it (~45 KB gzip). Both are route-lazy and idempotent; results
		// are ignored — until markdown-it lands `renderLiveMarkdown` returns an
		// escaped <p> and the next chunk picks up the real render.
		//
		// `renderLiveMarkdown` also does a tracked read of the shiki module's
		// `liveHighlighterReady`, but that only helps its `$derived` callers
		// (SkillToolBlock). The rAF callback below is NOT a tracking context, so
		// shiki landing mid-stream does not retroactively re-highlight the
		// in-flight bubble: a text segment that stopped growing first stays plain
		// until the next chunk grows it, or until the turn ends and the server's
		// full-coverage HTML swaps in. Narrow and self-healing, hence left alone.
		//
		// Kicked off at idle rather than straight away. These are only needed to
		// render a *streaming* reply, so opening an existing thread to read it
		// never uses them — but firing at mount put 120 KB gzip in contention with
		// the initial route graph on every chat open, including read-only ones.
		// Idle keeps the "already loaded before the first token arrives" property
		// (the user still has to type and send) without competing with first paint.
		// Safari has no requestIdleCallback, so fall back to a short timeout.
		const warmLiveRenderers = () => {
			void ensureLiveHighlighter();
			void ensureLiveMarkdown();
		};
		// Called through `window` rather than via a detached reference: WebIDL
		// does fall back to the global for a `this`-less Window operation, but
		// leaning on that reads as a bug and trips `unbound-method`.
		const w = window as Window & {
			requestIdleCallback?: (cb: () => void, o?: object) => number;
		};
		if (w.requestIdleCallback) w.requestIdleCallback(warmLiveRenderers, { timeout: 2000 });
		else setTimeout(warmLiveRenderers, 200);
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
	// Svelte's built-in reactive query — SSR-safe (false on the server) and live,
	// so toggling the OS setting takes effect without a reload. Read as a
	// $derived so the transitions and scroll calls below can use it directly.
	const reduceMotion = $derived(prefersReducedMotion.current);

	// Branch-switch direction. selectSibling sets this (+1 for "next" / ‹›,
	// -1 for "previous") just before the invalidate that swaps the active
	// branch in, and clears it once the new nodes have mounted. The
	// messageIntro transition reads it so a sibling swap slides in
	// directionally (the new branch arrives from the side you navigated
	// toward) while an ordinary message arrival keeps its plain fade.
	let branchSwitchDir = $state<1 | -1 | null>(null);

	/**
	 * Intro for a message wrapper. Three modes, picked at mount time:
	 *  - reduced-motion / pre-mount / the live-streamed row → no animation
	 *    (the streamed row suppresses its own re-fade so the persist swap is
	 *    seamless — preserved from the previous in:fade).
	 *  - mid branch-switch → directional fade + horizontal slide.
	 *  - otherwise → the subtle opacity-only arrival fade.
	 */
	function messageIntro(_node: Element, p: { streamed: boolean }) {
		if (!listMounted || reduceMotion || p.streamed) return { duration: 0 };
		if (branchSwitchDir !== null) {
			const dir = branchSwitchDir;
			return {
				duration: 260,
				easing: cubicOut,
				css: (t: number, u: number) => `opacity: ${t}; transform: translateX(${u * dir * 18}px)`,
			};
		}
		return { duration: 160, css: (t: number) => `opacity: ${t}` };
	}

	// The just-streamed message id (`turn.streamedMessageId`): its content was
	// already on screen as the in-flight bubble, so when the persisted row mounts
	// to replace it we suppress the arrival fade — otherwise the bubble visibly
	// blinks out and re-fades on finalize. The in-flight bubble itself carries the
	// fade (on stream start) instead.

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

	// The in-flight fetch's AbortController (`turn.activeAbort`) and the
	// suspend/offline interruption flags (`turn.wasHiddenDuringFetch` /
	// `turn.wasOfflineDuringFetch`) live on the turn controller now — the
	// visibility/online listeners below flip them via turn.markHidden/markOffline.

	// Live connectivity state (distinct from turn's per-fetch offline latch, which is a
	// per-fetch latch). Drives the composer's offline notice + disabled Send:
	// while offline we block sending rather than firing a doomed fetch, so the
	// typed message stays in the box (and its draft) instead of being cleared
	// into a "Load failed". navigator.onLine === false is reliable; a true is
	// only a hint, so we never over-block — a stale-true just falls through to
	// the existing error handling.
	//
	// Writable $derived: no reactive dependencies, so it seeds once per instance
	// (false during SSR, where `navigator.onLine` doesn't exist) and then holds
	// whatever the <svelte:window> online/offline handlers assign.
	let isOffline = $derived(browser && !navigator.onLine);

	// Multi-model fan-out controller (state + orchestration extracted to
	// $lib/fanout-controller for testability). The page owns the composer/picker
	// bindings + a few effects that delegate here; the controller reaches shared
	// page state through these getters/setters.
	const fanout: FanoutController = new FanoutController({
		convId: () => convId,
		models: () => data.models,
		messageCount: () => messages.length,
		busy: () => turn.busy,
		appendUserMessage: (m) => (messages = [...messages, m]),
		setBusy: (b) => (turn.busy = b),
		setError: (m) => (errorMsg = m),
		setActiveModel: (id, kind) => {
			modelId = id;
			modelKind = kind;
		},
		setStreamedMessageId: (id) => (turn.streamedMessageId = id),
		// Both controllers share the one pair of interruption flags (the turn
		// controller owns them).
		interrupted: () => turn.interrupted,
		clearInterruptedFlags: () => turn.clearInterruptedFlags(),
		scrollToBottom: () => scrollToBottom(),
	});

	// Looking at the thread IS the acknowledgment the notification was
	// asking for, so retract it and re-derive the app-icon badge from
	// what's left in the tray. Scoped to this conversation rather than
	// "the app was opened": the badge answers "did that thing finish?",
	// and opening the app to start an unrelated chat doesn't answer it —
	// clearing there would drop the signal before it had done its job.
	//
	// Gated on actually being visible. A backgrounded desktop tab parked
	// on this conversation is precisely the case the SW arbiter raises an
	// OS notification for (see pickAction: same thread but not visible ->
	// 'os'), so dismissing from a hidden window would retract the
	// notification we just showed.
	//
	// A window being focused on its way somewhere else is also not a visit.
	// Tapping thread A's notification focuses a window still parked on thread
	// B, and that focus is what flips visibility — so without the pending-
	// navigation check below, B's notification would be dismissed by a user
	// who only ever asked to see A. Compared by id rather than merely "is a
	// navigation in flight" so the acknowledgment still fires for the thread
	// we're actually heading to, whether or not `navigating` has settled by
	// the time this runs.
	function acknowledgeNotifications(conversationId: string) {
		if (document.visibilityState !== 'visible') return;
		const pendingId = navigating.to?.params?.id;
		if (pendingId !== undefined && pendingId !== conversationId) return;
		void dismissConversationNotifications(conversationId);
	}

	// Fires on mount and on every genuine conversation change. The sentinel
	// starts at null (not at the current id) so the first run isn't skipped —
	// arriving by full page load, which is exactly what tapping a notification
	// does when no window is open, has to count as a visit. Comparing rather
	// than just reading keeps a layout-only invalidation from re-querying the
	// tray on every completed turn.
	let acknowledgedConvId: string | null = null;
	$effect(() => {
		if (data.conversation.id === acknowledgedConvId) return;
		acknowledgedConvId = data.conversation.id;
		acknowledgeNotifications(data.conversation.id);
	});

	// Visibility-change + connectivity handlers: tracks interruptions
	// during in-flight sends, and re-invalidates on return so any work
	// that completed in the background (the most common case for
	// image/video generation, where the server keeps generating even
	// after the client's fetch dies) shows up immediately rather than
	// only after the user navigates away and back to force a refetch.
	// Bound via <svelte:window>/<svelte:document> at the top of the template.
	function onVisibilityChange() {
		// Swiping back into a thread you were notified about counts as seeing
		// it, independently of whether there's in-flight work to reconcile —
		// the notification was raised precisely BECAUSE this window was hidden,
		// so this is the path that clears it in the common iOS case.
		if (document.visibilityState === 'visible') {
			acknowledgeNotifications(data.conversation.id);
		}
		// A fan-out releases `busy` early (so the grid can show), so also
		// track its branch streams as in-flight work worth recovering.
		if (document.visibilityState === 'hidden' && (turn.busy || fanout.streaming)) {
			turn.markHidden();
		} else if (document.visibilityState === 'visible' && turn.wasHiddenDuringFetch) {
			// Reconcile against server state — if a single generation completed
			// while we were backgrounded, the new message arrives via the load.
			// A live fan-out's streams are NOT eagerly handed off here: a desktop
			// tab-switch fires visibilitychange without killing the SSE
			// connections, and aborting them would needlessly drop a healthy live
			// grid (losing the QUEUED badge + timer). If the connections actually
			// died (iOS suspend), the branch fetches error and runBranch hands the
			// fan-out off to recovery itself.
			void invalidateAll();
		}
	}
	function onOffline() {
		isOffline = true;
		if (turn.busy || fanout.streaming) turn.markOffline();
	}
	function onOnline() {
		isOffline = false;
		// Same reasoning as the visibility path — don't pre-emptively abort a
		// live fan-out; an actually-dropped branch fetch recovers via runBranch.
		if (turn.wasOfflineDuringFetch) void invalidateAll();
	}

	// In-flight assistant render state (segments + open/progress/status/queued/
	// mcp-unavailable) lives on `turn` — while streaming it shows a transient
	// "assistant" bubble that isn't yet a row in the messages array; on `done`
	// the canonical persisted ChatMessage is spliced into messages. The
	// segments-to-blocks conversion is `turn.inFlightBlocks`.

	// --- Multi-model fan-out -------------------------------------------------
	// The model picker's compare "cart" (model id → count) + whether compare
	// mode is on. Bound into ChatComposer → ModelPicker. When the cart is
	// non-empty the next send fans the prompt out instead of single-sending.
	let compareSelections = $state<CompareSelection[]>([]);
	let compareMode = $state(false);
	// Split-attachments: when on, each attached image fans out into its own
	// image-edit / i2v generation (instead of all going into one). Composes
	// with compare mode as a cross product (models × images). Bound into the
	// composer's attachment strip.
	let splitAttachments = $state(false);
	const fanoutModels = $derived(
		expandCompareSelections(compareSelections, (id) => {
			const m = data.models.find((x) => x.id === id);
			return m ? { displayName: m.displayName, modelKind: m.kind } : undefined;
		}),
	);

	function modelDisplayName(modelId: string | null): string {
		if (!modelId) return 'Model';
		return data.models.find((m) => m.id === modelId)?.displayName ?? modelId;
	}

	/** Reset the compare cart + mode (after a fan-out kicks off, or on nav). */
	function resetCompare() {
		compareSelections = [];
		compareMode = false;
	}

	// rAF-coalesced per-segment markdown render. Each text segment grows
	// independently; we render each segment's HTML on the next frame
	// rather than on every chunk to cap markdown-it cost at ~60Hz no
	// matter how fast the upstream streams tokens.
	//
	// Critically the callback does NOT reassign `turn.inFlightSegments` — Svelte
	// 5's $state proxy wraps each array element, so mutating `s.html` in
	// place triggers reactivity for every reader that touched that field
	// (notably `turn.inFlightBlocks`). Reassigning the array would re-trigger
	// this very effect (which reads the segments to iterate), causing
	// a self-perpetuating rAF loop at 60Hz that fires the auto-scroll
	// effect each frame — which yanked the scroll position back to the
	// bottom whenever the user tried to scroll up, even when idle.
	let inFlightHtmlFrame = 0;
	$effect(() => {
		// Touch every text segment's text so the effect re-runs whenever
		// any of them grows.
		for (const s of turn.inFlightSegments) {
			if (s.kind === 'text') void s.text;
		}
		if (inFlightHtmlFrame !== 0) return;
		inFlightHtmlFrame = requestAnimationFrame(() => {
			inFlightHtmlFrame = 0;
			for (const s of turn.inFlightSegments) {
				if (s.kind !== 'text') continue;
				if (s.htmlFromText === s.text) continue;
				s.html = renderLiveMarkdown(s.text);
				s.htmlFromText = s.text;
			}
		});
	});

	// `turn.recoveredInFlight` is server-reported truth: a generation is running
	// for this conversation but this client isn't driving it — its fetch died
	// (iOS suspended the PWA, the network dropped). Show the bubble hydrated from
	// the registry, not from a live local fetch.
	//
	// The in-flight bubble shows for either a live local turn or a recovered one.
	const showInFlight = $derived(turn.inFlightOpen || turn.recoveredInFlight);
	// A generation is in progress, whether or not this client is driving
	// it — gates composer input + message actions the same as a live
	// turn. Includes the approval-resume window (`turn.approvalSubmitting`)
	// so the composer disables and the Send button flips to Stop while
	// the resumed iteration is streaming, AND the pending-approval
	// window so the user can't type a new message while the existing
	// turn is suspended waiting on a tool decision.
	const generating = $derived(
		turn.busy ||
			turn.approvalSubmitting ||
			turn.recoveredInFlight ||
			hasAnyPendingApproval ||
			fanout.comparing,
	);

	// The subset of `generating` where THIS tab actually OWNS a live stream (or
	// a recovery poll) it will render the completion into — as opposed to a
	// UI-gating state that merely looks busy: an idle Allow/Reject prompt
	// (`hasAnyPendingApproval` — the SSE has already closed) or a settled
	// fan-out grid still on screen (`fanout.comparing` stays true after the last
	// branch finishes; `fanout.streaming` is the actively-generating subset).
	// Only stream-owning states may report cross-device presence, so we never
	// suppress a completion this tab won't actually show. See
	// stream-presence.svelte.ts.
	const renderingGeneration = $derived(
		turn.busy || turn.approvalSubmitting || turn.recoveredInFlight || fanout.streaming,
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
			turn.recoveredInFlight && serverInFlightSince !== null ? serverInFlightSince : Date.now();
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
		// Abandon the in-flight turn we're leaving: abort its fetch, clear busy +
		// the in-flight bubble, and drop the approval-resume latch (a resume streams
		// under `approvalSubmitting`, not `busy`, and registers its abort in
		// `activeAbort`) — so the presence-publish effect below doesn't transiently
		// report the new conversation while a resume from the old one is still
		// marked in flight.
		turn.teardown();
		errorMsg = null;
		// Tear down any fan-out from the conversation we're leaving — abort its
		// in-flight branches and drop the comparison state. The new
		// conversation's columns (if any) re-hydrate from its load data below.
		fanout.teardown();
		resetCompare();
	});

	// Publish "this tab is rendering a generation for convId" so the root
	// layout's presence heartbeat can suppress a cross-device push only while a
	// device is actually rendering the completion (see stream-presence.svelte.ts).
	// Defined AFTER the conversation-switch reset above so that, in the flush
	// where we switch A -> B mid-stream, `busy` is already cleared when this
	// runs — otherwise it would transiently publish B (the new convId with A's
	// not-yet-reset busy) before correcting to null. Scoped to convId + cleared
	// on cleanup so a switch or unmount never leaves a stale id set.
	$effect(() => {
		streamPresence.conversationId = renderingGeneration ? convId : null;
		return () => {
			streamPresence.conversationId = null;
		};
	});

	// Publish the same signal to the sidebar's generating dot — but with the
	// opposite teardown rule: no cleanup, so the flag SURVIVES navigating away.
	// That's the whole point (the abandoned thread keeps generating server-side
	// and is exactly the row the dot is for); the layout's poll is what takes it
	// back off. On an A -> B switch this runs with B's convId and
	// `renderingGeneration` already false — the reset effect above shares this
	// flush and clears `busy` first — so it clears B and leaves A flagged, which
	// is the intent. Navigating back into a finished thread clears it here
	// immediately, ahead of the poll.
	$effect(() => {
		if (renderingGeneration) {
			markGenerating(convId);
			// Then SUBSCRIBE to this id's membership, so the mark self-heals if the
			// layout's poll clears it. That happens for real: we flag on `busy`,
			// which is set before the POST is even dispatched, while the server
			// only registers the generation once the request lands — a poll whose
			// snapshot falls in that window answers without this conversation and
			// the clear-only reconcile drops it. Nothing else would put it back
			// (neither `renderingGeneration` nor `convId` changes again this turn,
			// so this effect wouldn't re-run), and the dot would be gone for the
			// rest of the session — precisely for a thread the user is about to
			// walk away from. Widest for a fan-out, whose `/prepare` round trip
			// opens the window for hundreds of ms. Re-marking is a no-op when the
			// id is already present, so this settles in one extra run rather than
			// looping.
			isGenerating(convId);
		} else clearGenerating(convId);
	});

	// Rebuild the compare grid from server-truth recovery state on a reload /
	// conversation-switch into a parked fan-out (and re-run as `data` refreshes
	// — e.g. the recovery poll's invalidate — to fill in branches as they land).
	// The controller skips the rebuild while THIS client is driving the fan-out
	// or has a branch fetch in flight, so it never clobbers the in-session grid.
	$effect(() => {
		const serverFanout = data.fanout;
		untrack(() => fanout.syncFromServer(serverFanout));
	});

	// While a generation runs server-side that this client isn't driving (a
	// recovered bubble — the local fetch died to an iOS suspension or dropped
	// connection), the controller polls the in-flight registry so the
	// "Generating…" bubble resolves the moment the generation finishes — even
	// if the user just stays in the app. invalidateAll() is too heavy to poll (it
	// re-fetches every endpoint's model list); see startRecoveryPoll for why it
	// rides the branch-walk-free `?fanout=1` variant.
	$effect(() => {
		if (!turn.recoveredInFlight) return;
		return turn.startRecoveryPoll();
	});

	// Recovery poll for a RECOVERED fan-out (rebuilt from server truth after a
	// reload/disconnect, so it has "Generating…" placeholder columns the client
	// isn't driving). The controller polls the lightweight GET and rebuilds the
	// grid as branches land, stopping once none are pending. The live in-session
	// fan-out doesn't need this — its own branch fetches drive the columns.
	$effect(() => {
		if (!fanout.hasRecoveredPending) return;
		return fanout.startRecoveryPoll();
	});

	async function stop() {
		// A streaming fan-out has its own per-branch controllers; cancel them all
		// (and the server-side generations). Otherwise the turn controller handles
		// the single-turn / recovered-bubble cancel path.
		if (fanout.streaming) {
			await fanout.stop();
			return;
		}
		await turn.stop();
	}

	async function send() {
		// Consume a leading `/skill-name` (explicit activation) — only when skills
		// are active for this conversation (chat model + `skills` enabled), so a
		// disabled-skills conversation sends `/foo` literally. A bare command with
		// no message strips to empty text and isn't sendable; a non-matching
		// `/token` (e.g. a file path) is left untouched.
		const skillsActive = modelKind === 'chat' && !disabledFeatures.includes('skills');
		const { text, activatedSkillNames } = skillsActive
			? stripSkillCommand(composerText.trim(), data.enabledSkills)
			: { text: composerText.trim(), activatedSkillNames: [] as string[] };
		if ((!text && attachments.items.length === 0) || generating || compaction.compacting) return;
		if (attachments.isBusy) return;
		// Offline: block the send before anything is cleared. The button is
		// already disabled, but Enter can still reach here — bail so the typed
		// message stays in the box (and its draft) rather than clearing into a
		// doomed fetch. onOnline re-enables Send the moment connectivity returns.
		if (isOffline) return;
		const attachedMediaIds = attachments.readyMediaIds();
		// Split-attachments image set (one branch per image) captured before the
		// strip is cleared below.
		const splitImageIds = splitAttachments ? attachments.readyImageMediaIds() : null;
		// Fan-out (multi-model and/or split-attachments) takes precedence over a
		// single send (and over an in-progress edit — comparing is a fresh turn).
		// Branches = the picked models (or the current single model) crossed with
		// the split images; 2+ branches fans out, exactly one collapses to a
		// normal send with that model.
		const baseModels: FanoutModel[] =
			fanoutModels.length > 0
				? fanoutModels
				: [{ modelId, modelKind: modelKind ?? 'chat', displayName: modelDisplayName(modelId) }];
		const branches = expandFanoutBranches(baseModels, splitImageIds);
		const willFanOut = branches.length >= 2;

		// Image-input-only models (upscalers, background removal, image-to-video)
		// reject a text-only request upstream. The composer's Send button is
		// already disabled in this case, but Enter reaches here — bail so the typed
		// prompt stays put (draft intact) rather than clearing into a doomed send.
		// Absent capabilities data reads as "unknown" (never `required`), so
		// passthrough models are unaffected. Mirrors ChatComposer's `needsImage`.
		if (
			attachments.readyImageCount === 0 &&
			baseModels.some((b) => {
				const m = data.models.find((x) => x.id === b.modelId);
				return m ? imageAttachment(m) === 'required' : false;
			})
		) {
			return;
		}

		// Plain continuation sends only: a fan-out is a fresh comparison turn. Run
		// BEFORE the composer is cleared so that if compaction fails and the user
		// backs out, their typed message + attachments are still intact rather than
		// discarded. (An edit resend can't reach here — the composer is unmounted
		// while an edit session is open, and `edit.save()` goes straight to
		// `turn.send`.)
		if (!willFanOut) {
			const proceed = await compaction.maybeAutoCompact();
			if (!proceed) return;
		}

		composerText = '';
		// The message is committed — drop the saved draft so it isn't restored
		// after a reload. cancel() drops the pending write; clearDraft() removes
		// the stored key now (load-bearing: setting composerText='' above re-fires
		// the autosave $effect, but that only re-clears on the next debounced
		// commit, so the explicit clear is what removes it immediately).
		draftWriter.cancel();
		clearDraft(data.conversation.id);
		attachments.clear();
		if (willFanOut) {
			resetCompare();
			splitAttachments = false;
			await fanout.send(text, attachedMediaIds, branches, baseModels);
			return;
		}
		// Single effective branch — collapse to a normal send with that model.
		if (fanoutModels.length >= 1) {
			modelId = baseModels[0].modelId;
			modelKind = baseModels[0].modelKind;
			resetCompare();
		}
		splitAttachments = false;
		await turn.send(text, attachedMediaIds, {
			...(activatedSkillNames.length ? { activatedSkillNames } : {}),
		});
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
		void turn.inFlightSegments;
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
		if (bootstrapped || typeof window === 'undefined' || turn.busy) return;
		const key = pendingFirstMessageKey(convId);
		const pending = window.sessionStorage.getItem(key);
		if (pending) {
			window.sessionStorage.removeItem(key);
			bootstrapped = true;
			let pendingText = pending;
			let pendingMediaIds: string[] = [];
			let pendingFanout: FanoutModel[] | null = null;
			let pendingSplitImageIds: string[] | null = null;
			let pendingActivatedSkillNames: string[] = [];
			try {
				const parsed = JSON.parse(pending) as unknown;
				if (parsed && typeof parsed === 'object' && 'text' in parsed) {
					const rawText = parsed.text;
					pendingText = typeof rawText === 'string' ? rawText : '';
					const ids = (parsed as { attachedMediaIds?: unknown }).attachedMediaIds;
					if (Array.isArray(ids)) {
						pendingMediaIds = ids.filter((s): s is string => typeof s === 'string');
					}
					const fm = (parsed as { fanoutModels?: unknown }).fanoutModels;
					if (Array.isArray(fm) && fm.length > 0) pendingFanout = fm as FanoutModel[];
					const split = (parsed as { splitImageIds?: unknown }).splitImageIds;
					if (Array.isArray(split) && split.length > 0) {
						pendingSplitImageIds = split.filter((s): s is string => typeof s === 'string');
					}
					const asn = (parsed as { activatedSkillNames?: unknown }).activatedSkillNames;
					if (Array.isArray(asn)) {
						pendingActivatedSkillNames = asn.filter((s): s is string => typeof s === 'string');
					}
				}
			} catch {
				// Old format — pending was already plain text.
			}
			// A multi-model and/or split-attachments first message fans out;
			// otherwise it's a plain single send. Branches = the picked models
			// (or the conversation's single model) crossed with the split images.
			const pendingBase: FanoutModel[] = pendingFanout ?? [
				{ modelId, modelKind: modelKind ?? 'chat', displayName: modelDisplayName(modelId) },
			];
			const pendingBranches = expandFanoutBranches(pendingBase, pendingSplitImageIds);
			if (pendingBranches.length >= 2) {
				void fanout.send(pendingText, pendingMediaIds, pendingBranches, pendingBase);
			} else
				void turn.send(
					pendingText,
					pendingMediaIds,
					pendingActivatedSkillNames.length
						? { activatedSkillNames: pendingActivatedSkillNames }
						: {},
				);
		}
	});

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

	// Inline message editing. The bubble for `edit.messageId` re-renders as an
	// in-place editor and the bottom composer hides, so it's unambiguous which
	// message is being edited. See $lib/edit-session.
	const edit = new EditSession({
		generating: () => generating,
		send: (text, mediaIds, editedMessageId) => turn.send(text, mediaIds, { editedMessageId }),
	});
	onDestroy(() => edit.destroy());

	// Restore this conversation's saved composer draft, and close any open
	// inline-edit session, when navigating to a different conversation. Like
	// the in-flight turn state, these are component-local and the /chat/[id]
	// component is reused across conversation switches: without this the
	// previous chat's half-typed text would bleed into the next, and a stale
	// an open edit session (whose target message doesn't exist in the new
	// conversation) would hide the composer with no inline editor to replace
	// it, leaving no way to type. Drafts are per-conversation, so each switch
	// loads its own (usually empty); see $lib/composer-draft. Guarded on a real
	// id change so a same-conversation invalidateAll() can't wipe a draft
	// mid-compose.
	let composerResetConvId: string | undefined;
	$effect(() => {
		const id = data.conversation.id;
		if (id === composerResetConvId) return;
		composerResetConvId = id;
		composerText = loadDraft(id);
		edit.closeForConversationSwitch();
	});

	// Autosave the in-progress follow-up so it survives a reload (e.g. an iOS
	// PWA frozen in the background). Per-conversation key; debounced with a
	// force-flush on page-hide. Cleared when a message is actually sent.
	const draftWriter = createDraftWriter();
	$effect(() => {
		draftWriter.save(data.conversation.id, composerText);
	});
	onDestroy(() => draftWriter.dispose());

	/**
	 * "New chat from this prompt": stash the prompt + its model selection and
	 * navigate to the new-chat composer. Never submits — the user tweaks first.
	 *
	 * The model comes from the prompt's recorded dispatch, not the conversation
	 * row (which goes stale the moment you switch models mid-thread). The
	 * fallback chain covers rows predating `dispatched_models` and OWUI imports:
	 * the active reply's `modelUsed`, then the conversation's model, then
	 * nothing — at which point the new-chat page picks its own default.
	 */
	function reusePrompt(m: ChatMessage) {
		if (generating) return;
		const activeReply = messages.find((x) => x.parentMessageId === m.id);
		const { modelId: derivedModelId, compareSelections } = deriveReuseModels(
			m.dispatchedModels,
			activeReply?.modelUsed ?? data.conversation.modelId,
			(id) => data.models.find((x) => x.id === id),
		);
		// A cart resolves against base models only, so the preset upgrade is a
		// single-model concern.
		const intent: PromptReuseIntent = {
			text: partsToText(m.parts),
			mediaIds: m.parts.filter((p) => p.type === 'image').map((p) => p.mediaId),
			modelId: compareSelections
				? derivedModelId
				: upgradeToPresetModelId(
						derivedModelId,
						data.conversation.customModelId,
						data.customModels ?? [],
					),
			compareSelections,
			disabledFeatures: data.conversation.disabledFeatures,
			private: data.conversation.private,
		};
		try {
			sessionStorage.setItem(PROMPT_REUSE_KEY, JSON.stringify(intent));
		} catch {
			// sessionStorage can throw (private mode, quota, disabled by policy).
			// Navigate anyway: the receiver treats a missing key as "no intent" and
			// opens an ordinary new chat, which beats an onclick that throws and
			// leaves the user on a button that appears to do nothing.
		}
		void goto(resolve('/'));
	}

	/**
	 * Retry an assistant turn — server creates a new assistant sibling
	 * under the same parent user message and re-dispatches. Reuses the
	 * normal streaming pipeline; the retry-specific bits (skip optimistic,
	 * forward `regenerateFromMessageId`) are handled in turn.send.
	 */
	async function retryAssistant(m: ChatMessage) {
		if (generating) return;
		await turn.send('', [], { retryFromMessageId: m.id });
	}

	/** Switch the active branch to a sibling of the given message. Used by
	 * the `‹ N/M ›` arrows. Refetches the conversation on success so the
	 * page renders the new branch, then scrolls the newly-visible sibling
	 * into view — otherwise a shorter new branch's natural scroll-height
	 * clamping leaves the user at the bottom (often far below where they
	 * were when they clicked the arrow), or a longer one strands them
	 * mid-content with no clear orientation. */
	async function selectSibling(targetMessageId: string, dir: 1 | -1 = 1) {
		if (generating) return;
		errorMsg = null;
		// Arm the directional intro before the swap so the new branch's nodes
		// read it as they mount; cleared after they're in (the running
		// transition has already captured `dir`, so clearing can't truncate
		// it). reduce-motion still no-ops inside messageIntro.
		branchSwitchDir = reduceMotion ? null : dir;
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
			const target = document.getElementById(`msg-${targetMessageId}`);
			target?.scrollIntoView({ block: 'center', behavior: 'auto' });
			// Image parts carry no stored dimensions and render lazily, so a
			// freshly-switched-to image branch is ~0px tall at this point — the
			// centering above lands wrong (often at the very top) and the image
			// then loads and grows below the viewport, stranding the user. Re-
			// center once each not-yet-loaded image in the new branch finishes,
			// so a tall result settles where the user is looking. Re-resolving
			// the node by id (rather than closing over `target`) makes a stale
			// load from a since-abandoned rapid switch a safe no-op.
			target?.querySelectorAll('img').forEach((img) => {
				if (img.complete) return;
				img.addEventListener(
					'load',
					() =>
						document
							.getElementById(`msg-${targetMessageId}`)
							?.scrollIntoView({ block: 'center', behavior: 'auto' }),
					{ once: true },
				);
			});
		} catch (e) {
			errorMsg = `Couldn't switch branch: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			branchSwitchDir = null;
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

<svelte:window onoffline={onOffline} ononline={onOnline} />
<svelte:document onvisibilitychange={onVisibilityChange} />

<div class="flex h-full min-w-0">
	<div class="relative flex h-full min-w-0 flex-1 flex-col">
		<ChatHeader {title} private={isPrivate} />

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
				{#each visibleMessages as m (m.id)}
					{#if isCompactionSummary(m)}
						<!-- A compaction summary: collapsed divider, not a bubble. The
						 real messages it stands in for stay visible above/below it.
						 `summary-<id>` (not `msg-<id>`) is the scroll/highlight target a
						 manual compaction jumps to — kept off the `msg-` namespace so
						 bubble-counting logic still skips it. -->
						<div
							id="summary-{m.id}"
							class={[
								'rounded-lg transition-colors duration-1000',
								m.id === highlightedMessageId && 'bg-amber-200/40 dark:bg-amber-500/15',
							]}
						>
							<CompactionSummary
								message={m}
								canUndo={m.id === compaction.activeLeafSummaryId &&
									!turn.busy &&
									!compaction.compacting}
								onUndo={() => compaction.undo()}
							/>
						</div>
					{:else}
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
						{@const merge = mergeFlagsById.get(m.id) ?? {
							mergeWithPrev: false,
							mergeWithNext: false,
						}}
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
						<!--
						Do NOT put `content-visibility: auto` on this wrapper. It was
						tried and reverted — see ROADMAP "Virtualized message list".
						Off-screen rows collapse to their `contain-intrinsic-size`
						placeholder, which makes the scroll container's `scrollHeight`
						an ESTIMATE (measured 20638px against a real 42537px on a
						40-turn thread). Pin-to-bottom here is
						`scrollTop = el.scrollHeight`, so a short estimate scrolls to
						the bottom of a document that doesn't exist, and a row mounting
						collapsed on stream-finalize snaps the view off the reply.
					-->
						<div
							id="msg-{m.id}"
							in:messageIntro={{ streamed: m.id === turn.streamedMessageId }}
							class={[
								'group rounded-lg transition-colors duration-1000',
								mergeWithPrev && 'mt-0!',
								mergeWithNext && 'mb-0!',
								m.id === highlightedMessageId && 'bg-amber-200/40 dark:bg-amber-500/15',
							]}
						>
							{#if m.id === edit.messageId}
								<!--
						Inline editor: replaces the static bubble with an
						editable surface in the same position so it's
						unambiguous WHICH message is being edited. Save creates
						a sibling under the original's parent (preserving the
						original as a branch); Cancel discards.
					-->
								<EditMessageForm
									bind:editText={edit.text}
									attachments={edit.attachments}
									{allowAttachments}
									enterBehavior={data.prefs?.enterBehavior ?? 'send'}
									activeKind={editSnippetKind}
									onSave={() => void edit.save()}
									onCancel={() => edit.cancel()}
								/>
							{:else}
								<MessageBubble
									message={m}
									{toolResultsByCallId}
									{userLabel}
									assistantLabel={assistantLabelFor(m)}
									{mergeWithPrev}
									{mergeWithNext}
									onImageClick={openImageInLightbox}
									{openingLightboxFor}
									{approvalDecisions}
									approvalBusy={turn.approvalSubmitting}
									{onApprovalSelect}
									bottomCanvasCards={canvasCardsByGroupLast.get(m.id) ?? []}
									onOpenCanvas={(artifactId: string | null) => canvas.show(artifactId ?? undefined)}
								/>
							{/if}
							{#if (m.role === 'user' || m.role === 'assistant') && m.id !== edit.messageId && !mergeWithNext}
								<MessageActions
									message={m}
									{generating}
									recentlyCopied={recentlyCopiedId === m.id}
									canCopy={hasCopyableText(m.parts)}
									userSentTokens={m.role === 'user' ? (userSentTokens.get(m.id) ?? null) : null}
									onCopy={() => copyMessage(m)}
									onEdit={() => edit.begin(m)}
									onReuse={() => reusePrompt(m)}
									onRetry={() => retryAssistant(m)}
									onSelectSibling={(id: string, dir: 1 | -1) => selectSibling(id, dir)}
									onDeleteBranch={() => deleteBranch(m)}
								/>
							{/if}
						</div>
					{/if}
				{/each}

				{#if compaction.streaming}
					<CompactionSummaryStreaming text={compaction.streamText} />
				{/if}

				{#if showInFlight}
					{@const last = visibleMessages[visibleMessages.length - 1]}
					{@const fuseWithPrevAssistant =
						!!last && last.role === 'assistant' && last.id !== edit.messageId}
					<div
						class={fuseWithPrevAssistant ? 'mt-0!' : ''}
						in:fade={{ duration: listMounted && !reduceMotion ? 160 : 0 }}
					>
						<InFlightBubble
							blocks={turn.inFlightBlocks}
							{assistantLabel}
							label={inFlightLabel}
							status={turn.inFlightStatus}
							progress={turn.inFlightProgress}
							queued={turn.inFlightQueued}
							{elapsedSeconds}
							onImageClick={openImageInLightbox}
							{openingLightboxFor}
							{approvalDecisions}
							approvalBusy={turn.approvalSubmitting}
							{onApprovalSelect}
							mergeWithPrev={fuseWithPrevAssistant}
							mcpUnavailable={turn.inFlightMcpUnavailable}
							onOpenCanvas={(artifactId: string | null) => canvas.show(artifactId ?? undefined)}
						/>
					</div>
				{/if}
				{#if fanout.comparing}
					<div in:fade={{ duration: listMounted && !reduceMotion ? 160 : 0 }}>
						<!-- Text fan-out: pick one to continue. Media fan-out (keep-many):
					     discard duds + regenerate, no single pick. -->
						<FanoutColumns
							columns={fanout.columns}
							onPick={fanout.isMedia ? undefined : (c: FanoutColumn) => void fanout.pick(c)}
							onDiscard={fanout.isMedia ? (c: FanoutColumn) => void fanout.discard(c) : undefined}
							onRegenerate={fanout.isMedia
								? (c: FanoutColumn) => void fanout.regenerate(c)
								: undefined}
							onImageClick={openImageInLightbox}
							busy={fanout.picking}
						/>
						{#if fanout.columnsSettled}
							<div class="mt-2 flex justify-center">
								<button
									type="button"
									onclick={() => void fanout.dismiss()}
									disabled={fanout.picking}
									class="rounded-lg px-3 py-1.5 text-xs text-fg-muted transition hover:bg-surface-raised disabled:opacity-40"
								>
									{fanout.isMedia ? 'Done' : 'Dismiss comparison'}
								</button>
							</div>
						{/if}
					</div>
				{/if}
				<!--
				Bottom sentinel for IntersectionObserver. Pinned to the very
				end of the message list so the observer can tell when the
				user is scrolled within ~100px of it (see the observeNearBottom
				attachment above).
				1px tall + aria-hidden so it's invisible / inaudible to AT.
			-->
				<div {@attach observeNearBottom} aria-hidden="true" class="h-px"></div>
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
			<div
				class="pointer-events-auto relative mx-auto max-w-3xl"
				bind:clientHeight={composerHeight}
			>
				<ScrollToBottomButton
					visible={!isNearBottom}
					onClick={() => scrollToBottom({ smooth: true })}
				/>
				{#if edit.active}
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
					{#if showBudgetBar}
						<ContextBudgetBar
							{contextTokenCount}
							contextWindow={modelContextWindow}
							onCompact={() => compaction.compact()}
							canCompact={compaction.compactable}
							compacting={compaction.compacting}
							conversationId={convId}
							revision={messages.length}
						/>
					{/if}
					<ChatComposer
						bind:this={composerRef}
						bind:composerText
						bind:modelId
						{errorMsg}
						{attachments}
						{modelKind}
						{disabledFeatures}
						featureCategories={data.featureCategories}
						private={isPrivate}
						models={data.models}
						enabledSkills={data.enabledSkills}
						favoritedIds={data.prefs?.favoriteModels ?? []}
						{allowAttachments}
						{hasValidModel}
						{generating}
						offline={isOffline}
						canStop={((turn.busy || turn.approvalSubmitting) && turn.activeAbort != null) ||
							turn.recoveredInFlight ||
							fanout.streaming}
						enterBehavior={data.prefs?.enterBehavior ?? 'send'}
						bind:compareSelections
						bind:compareMode
						bind:splitAttachments
						modelSets={data.prefs?.modelSets ?? []}
						presetLabel={activePreset?.name ?? null}
						presetModelId={activePresetModelId}
						onSend={() => void send()}
						onStop={stop}
						onFeaturesChange={(next: FeatureCategory[]) => void persistDisabledFeatures(next)}
						onToggleFavorite={(id: string) =>
							void toggleFavoriteModel(data.prefs?.favoriteModels ?? [], id)}
						onSaveModelSet={(name: string, sels: CompareSelection[]) =>
							void saveModelSet(data.prefs?.modelSets ?? [], name, sels)}
						onDeleteModelSet={(id: string) => void deleteModelSet(data.prefs?.modelSets ?? [], id)}
					/>
				{/if}
			</div>
		</div>
	</div>

	<!--
		Canvas pane. Lazy-loaded once the conversation has a canvas (like
		MediaLightbox) so its chunk stays off the chat-route critical path. On
		desktop it docks as a right column and the chat flexes to fill the rest; on
		mobile it's a full-screen overlay. Content is server-rendered HTML carried
		on each canvas_version — no client markdown/highlight stack is pulled in.

		The open/close toggle is an inner {#if} INSIDE the resolved import, not the
		outer gate: Svelte only plays a leave transition when the element is removed
		by a reactive block it coordinates, and tearing down the {#await} wouldn't
		count — the pane would just vanish on close instead of sliding out.
	-->
	{#if canvas.open && canvas.current && CanvasPaneComp}
		{@const CanvasPane = CanvasPaneComp}
		<CanvasPane
			doc={canvas.current}
			docs={canvas.docs}
			changed={canvas.lastChangedVersionId === canvas.current.versionId}
			onClose={() => canvas.hide()}
			onSwitch={(id) => canvas.focus(id)}
			onHighlightSettled={() => canvas.clearChangeFlag()}
		/>
	{/if}
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
		<MediaLightbox
			media={lightbox}
			onClose={() => (lightbox = null)}
			inConversation
			siblings={conversationMedia}
			onNavigate={openImageInLightbox}
		/>
	{/await}
{/if}
