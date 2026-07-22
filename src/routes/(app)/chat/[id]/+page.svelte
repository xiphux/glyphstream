<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { goto, invalidateAll } from '$app/navigation';
	import { observeSentinel } from '$lib/observe-sentinel';
	import { FanoutController } from '$lib/fanout-controller.svelte';
	import { ChatTurnController } from '$lib/chat-turn-controller.svelte';
	import { preferredFirstName } from '$lib/greeting';
	import { ensureLiveMarkdown, renderLiveMarkdown } from '$lib/markdown-live';
	import { ensureLiveHighlighter } from '$lib/markdown-live-shiki.svelte';
	import { consumeChatStream } from '$lib/consume-chat-stream';
	import { buildApprovalDecisionsSnapshot, type ApprovalAction } from '$lib/approval-workflow';
	import { errorMessageFromResponse } from '$lib/fetch-error';
	import { toggleFavoriteModel } from '$lib/favorite-models';
	import { imageAttachment } from '$lib/model-capabilities';
	import { saveModelSet, deleteModelSet } from '$lib/model-sets';
	import { pendingFirstMessageKey } from '$lib/pending-first-message';
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
	import { privateView } from '$lib/private-chat.svelte';
	import { streamPresence } from '$lib/stream-presence.svelte';
	import EditMessageForm from '$lib/components/chat/EditMessageForm.svelte';
	import InFlightBubble from '$lib/components/chat/InFlightBubble.svelte';
	import MessageActions from '$lib/components/chat/MessageActions.svelte';
	import MessageBubble from '$lib/components/chat/MessageBubble.svelte';
	import ScrollToBottomButton from '$lib/components/chat/ScrollToBottomButton.svelte';
	import {
		assistantLabelForMessage,
		buildRenderedConversation,
		computeMergeFlags,
		messageToBlocks,
		parseCanvasAck,
		splitCanvasCards,
		type RenderBlock,
	} from '$lib/chat-render';
	import {
		compactionWorthwhile,
		displayContextTokens,
		isCompactionSummary,
		shouldAutoCompact,
	} from '$lib/chat-compaction';
	import CompactionSummary from '$lib/components/chat/CompactionSummary.svelte';
	import CompactionSummaryStreaming from '$lib/components/chat/CompactionSummaryStreaming.svelte';
	import ContextBudgetBar from '$lib/components/chat/ContextBudgetBar.svelte';
	import { AttachmentStore, attachmentsAllowedFor } from '$lib/attachments.svelte';
	import { stripSkillCommand } from '$lib/skill-command';
	import FanoutColumns from '$lib/components/chat/FanoutColumns.svelte';
	import {
		expandCompareSelections,
		expandFanoutBranches,
		type CompareSelection,
		type FanoutModel,
	} from '$lib/fanout';
	import { toast } from '$lib/toast.svelte';
	import { clearTitlePending, markTitlePending } from '$lib/title-pending.svelte';
	import type { ConversationMediaRef, MediaListItem } from '$lib/server/db/queries/media';
	import type { ChatMessage, FeatureCategory, MessagePart, ModelKind } from '$lib/types/api';

	let { data } = $props();

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
	// svelte-ignore state_referenced_locally
	let messages = $state<ChatMessage[]>(data.conversation.messages);
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
				docs: import('$lib/types/api').CanvasVersion[];
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
	// close isn't undone. Null so the first conversation counts.
	let canvasAutoOpenedConvId: string | null = null;

	$effect(() => {
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
		// Auto-open the canvas beside the conversation on entry — but only on a
		// wide viewport. On a small screen the pane is a full-screen overlay, so
		// auto-opening would replace the conversation you just entered with a wall
		// of document; there the inline card opens it on demand. This runs in an
		// $effect (client-only), so window.matchMedia is safe.
		//
		// untrack the canvas reads: `hydrate` above already ran synchronously this
		// tick, so `canvas.docs` is current here — but WITHOUT untrack, reading
		// `canvas.docs.length` would make `canvas.docs` a dependency of this whole
		// effect. A mid-turn `create_canvas`/`update_canvas` mutates `canvas.docs`,
		// which would then re-fire this effect and reset `messages` back to the
		// (pre-turn) load data, making the user's just-sent prompt bubble vanish
		// until the end-of-turn invalidateAll.
		untrack(() => {
			if (canvas.docs.length > 0 && canvasAutoOpenedConvId !== data.conversation.id) {
				canvasAutoOpenedConvId = data.conversation.id;
				if (window.matchMedia('(min-width: 768px)').matches) canvas.show();
			}
		});
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
		setApprovalError: (m) => (approvalError = m),
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
			map.set(m.id, computeMergeFlags(visibleMessages, i, editingMessageId, turn.inFlightOpen));
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
	// The approval-prompt's inline error, written by the controller's resume path.
	let approvalError = $state<string | null>(null);
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

	// --- manual compaction -------------------------------------------------
	// Summarize older history through the conversation's own model, then refetch.
	// Auto-compaction (the preference) reuses the same server engine just-in-time
	// on the next send. Disabled while a turn is in flight or there's too little
	// history to fold.
	let compacting = $state(false);
	// Not while a fan-out comparison is parked: compaction advances the active
	// leaf, which resolves/abandons the parked fan-out (appendMessage nulls
	// fanoutParentMessageId), silently dropping the compare grid. The sibling
	// branches survive in the tree, but the comparison view would be lost.
	// `$derived.by` (not a bare expression) so the `fanout` reference sits in a
	// closure — `fanout` is constructed further down, and a direct expression
	// would be a use-before-declaration.
	// `compactable` gates the Compact button on `compactionWorthwhile`, not just
	// the structural `canCompact`: compaction only shrinks history, so when the
	// foldable history is tiny (the dominant cost being system prompt + tools +
	// memories) the button stays disabled rather than running for ~no benefit.
	const compactable = $derived.by(
		() => !turn.busy && !compacting && !fanout.comparing && compactionWorthwhile(messages),
	);

	// The context-budget bar (readout + Compact) lives just above the composer.
	// Show it once the conversation is actually doing something worth measuring —
	// a known size or an existing summary — so a fresh chat stays clean. Hidden
	// for non-chat kinds and during a fan-out comparison (where a single budget
	// number isn't meaningful and compaction is blocked). `$derived.by` for the
	// `fanout` forward-reference, as with `compactable`.
	const showBudgetBar = $derived.by(
		() =>
			modelKind !== 'image' &&
			modelKind !== 'video' &&
			!fanout.comparing &&
			(contextTokenCount > 0 || messages.some(isCompactionSummary)),
	);

	// Live summary text while a manual compaction streams. `compactionStreaming`
	// gates the in-flight summary block; it settles back to false once the
	// persisted collapsed divider lands (or on error/cancel).
	let compactionStreaming = $state(false);
	let compactionStreamText = $state('');

	// Outcome of a compaction attempt, so the auto path can tell "freed up space /
	// nothing to free" (proceed) from "the summarization failed" (ask the user
	// before sending the full context). `error` carries the upstream message.
	type CompactionOutcome =
		{ status: 'compacted' } | { status: 'noop' } | { status: 'error'; error: string };

	// `silent` (the auto path) suppresses ALL user-facing feedback — error toasts
	// AND the success toast/scroll below. The user never asked for an auto
	// compaction and we immediately proceed to the message they actually sent, so
	// yanking the view up to the new summary would be disorienting; a manual
	// click, by contrast, gets confirmation + a scroll to where the summary landed.
	// The auto path handles failure itself (a confirm dialog in maybeAutoCompact)
	// off the returned outcome instead.
	async function compactConversation(opts: { silent?: boolean } = {}): Promise<CompactionOutcome> {
		if (compacting || turn.busy || fanout.comparing) return { status: 'noop' };
		compacting = true;
		compactionStreaming = false;
		compactionStreamText = '';
		let errored: string | null = null;
		let doneSummaryId: string | null = null;
		try {
			const res = await fetch(`/api/conversations/${data.conversation.id}/compact?stream=1`, {
				method: 'POST',
				headers: { Accept: 'text/event-stream' },
			});
			if (!res.ok || !res.body) {
				// 409 = nothing worth compacting yet — not a failure on the auto path.
				if (res.status === 409) {
					if (!opts.silent) toast.error('Not enough conversation history to compact yet.');
					return { status: 'noop' };
				}
				if (!opts.silent) toast.error("Couldn't compact this conversation.");
				return { status: 'error', error: "Couldn't reach the model to compact." };
			}
			await consumeChatStream(res.body, {
				onCompactionStart: () => {
					compactionStreaming = true;
				},
				onCompactionText: (chunk) => {
					compactionStreamText += chunk;
				},
				onCompactionDone: async (summaryMessage) => {
					doneSummaryId = summaryMessage.id;
					await invalidateAll();
				},
				onError: (msg) => {
					errored = msg;
				},
			});
			if (errored) {
				if (!opts.silent) toast.error(errored);
				return { status: 'error', error: errored };
			}
			if (doneSummaryId && !opts.silent) {
				// Confirm the (manual) action: it succeeded even though the token
				// number barely moves and the divider lands up-thread. Scroll to +
				// briefly highlight the new summary so the result is visible. The
				// Undo action covers an accidental tap — it's reversible while the
				// summary is still the leaf.
				toast.success('Conversation compacted', {
					action: { label: 'Undo', handler: undoCompaction },
				});
				await tick();
				const el = document.getElementById(`summary-${doneSummaryId}`);
				if (el) {
					el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
					highlightedMessageId = doneSummaryId;
					setTimeout(() => {
						if (highlightedMessageId === doneSummaryId) highlightedMessageId = null;
					}, 1500);
				}
			}
			return doneSummaryId ? { status: 'compacted' } : { status: 'noop' };
		} catch {
			if (!opts.silent) toast.error("Couldn't compact this conversation.");
			return { status: 'error', error: "Couldn't compact this conversation." };
		} finally {
			compacting = false;
			compactionStreaming = false;
			compactionStreamText = '';
		}
	}

	// Undo the most recent compaction (the "Undo" toast action + the divider's
	// restore control). Valid only while the summary is still the active leaf;
	// the server 409s once a later turn has been sent. Reverts the leaf so the
	// full history serializes again — the summary row stays in the tree.
	async function undoCompaction() {
		if (compacting || turn.busy || fanout.comparing) return;
		let res: Response;
		try {
			res = await fetch(`/api/conversations/${data.conversation.id}/compact`, {
				method: 'DELETE',
			});
		} catch {
			toast.error("Couldn't undo the compaction.");
			return;
		}
		if (!res.ok) {
			// 409 = the summary is no longer the active leaf: either a later turn was
			// sent, or a prior undo already landed (e.g. its refresh failed and this
			// is a retry). Either way there's nothing to revert — stay neutral rather
			// than asserting a message was sent.
			toast.error(
				res.status === 409
					? 'Nothing to undo — the summary is no longer the latest message.'
					: "Couldn't undo the compaction.",
			);
			return;
		}
		// The server commits the revert before replying, so by here the undo has
		// durably succeeded. Report success independently of the view refresh: if
		// invalidateAll fails (a transient load re-fetch error), the undo still
		// happened — ask for a reload instead of falsely claiming it failed.
		try {
			await invalidateAll();
			toast.success('Compaction undone');
		} catch {
			toast.info('Compaction undone — reload to refresh the view.');
		}
	}

	// The active-leaf compaction summary, if any — i.e. a summary with nothing
	// sent after it, so it can still be undone. Drives the divider's restore
	// control (`canUndo`). Null once a later turn advances the leaf past it.
	const activeLeafSummaryId = $derived.by(() => {
		const leaf = messages[messages.length - 1];
		return leaf && isCompactionSummary(leaf) ? leaf.id : null;
	});

	// Just-in-time auto-compaction, run on the client right before a plain send:
	// if the conversation has crossed the user's threshold of the model's window,
	// compact first (streaming the summary for live feedback) so the next message
	// continues with reclaimed space. Triggering here (vs. server-side mid-send) is
	// what lets the summary stream instead of the send hanging on a spinner.
	//
	// Returns whether the caller should go ahead with the send. A success or a
	// no-op (nothing worth compacting) → true. A *failure*, though, isn't silently
	// swallowed: sending the full un-compacted context can push the conversation
	// past the window, so we ask the user whether to send anyway or hold off and
	// deal with it (e.g. retry, or compact manually) — false means they backed out.
	async function maybeAutoCompact(): Promise<boolean> {
		if (!data.prefs?.autoCompactionEnabled || compacting || turn.busy || fanout.comparing)
			return true;
		if (
			!shouldAutoCompact({
				branch: messages,
				enabled: true,
				contextWindow: modelContextWindow,
				threshold: data.prefs.autoCompactionThreshold ?? 80,
			})
		) {
			return true;
		}
		const result = await compactConversation({ silent: true });
		if (result.status !== 'error') return true;
		return confirmDialog.ask({
			title: 'Context could not be compacted',
			message:
				`Automatic compaction failed: ${result.error} Send your message anyway with the ` +
				'full conversation? That may exceed the model’s context limit.',
			confirmLabel: 'Send anyway',
		});
	}

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
	$effect(() => {
		void data.conversation.id;
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
	let conversationMedia = $state<ConversationMediaRef[]>([]);
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
	$effect(() =>
		observeSentinel(scrollContainer, bottomSentinel, (v) => (isNearBottom = v), {
			rootMargin: '0px 0px 100px 0px',
		}),
	);

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
	// the existing error handling. Seeded + kept current in the $effect below.
	let isOffline = $state(false);

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

	// Visibility-change + connectivity listeners: tracks interruptions
	// during in-flight sends, and re-invalidates on return so any work
	// that completed in the background (the most common case for
	// image/video generation, where the server keeps generating even
	// after the client's fetch dies) shows up immediately rather than
	// only after the user navigates away and back to force a refetch.
	$effect(() => {
		if (typeof document === 'undefined') return;
		isOffline = !navigator.onLine;
		function onVisibilityChange() {
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
		document.addEventListener('visibilitychange', onVisibilityChange);
		window.addEventListener('offline', onOffline);
		window.addEventListener('online', onOnline);
		return () => {
			document.removeEventListener('visibilitychange', onVisibilityChange);
			window.removeEventListener('offline', onOffline);
			window.removeEventListener('online', onOnline);
		};
	});

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
	// connection), the controller polls the lightweight conversation endpoint so
	// the "Generating…" bubble resolves the moment the generation finishes — even
	// if the user just stays in the app. invalidateAll() is too heavy to poll (it
	// re-fetches every endpoint's model list); the GET endpoint is DB-only.
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
		if ((!text && attachments.items.length === 0) || generating || compacting) return;
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
		// Editing: send the new message as a sibling under the same parent
		// as the original. The original stays in the DB as an alt branch.
		const editParent = editingParentId;
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

		// Plain continuation sends only: an edit resend (editParent) parents off an
		// earlier message, so compacting at the leaf would orphan onto the wrong
		// branch; fan-out is a fresh comparison turn. Run BEFORE the composer is
		// cleared so that if compaction fails and the user backs out, their typed
		// message + attachments are still intact rather than discarded.
		if (!editParent && !willFanOut) {
			const proceed = await maybeAutoCompact();
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
		editingMessageId = null;
		editingParentId = null;
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
			...(editParent ? { parentMessageId: editParent } : {}),
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
					pendingText = String((parsed as { text: unknown }).text ?? '');
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

	// Restore this conversation's saved composer draft, and close any open
	// inline-edit session, when navigating to a different conversation. Like
	// the in-flight turn state, these are component-local and the /chat/[id]
	// component is reused across conversation switches: without this the
	// previous chat's half-typed text would bleed into the next, and a stale
	// `editingMessageId` (whose target message doesn't exist in the new
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
		editingMessageId = null;
		editingParentId = null;
		editText = '';
		editAttachments.clear();
	});

	// Autosave the in-progress follow-up so it survives a reload (e.g. an iOS
	// PWA frozen in the background). Per-conversation key; debounced with a
	// force-flush on page-hide. Cleared when a message is actually sent.
	const draftWriter = createDraftWriter();
	$effect(() => {
		draftWriter.save(data.conversation.id, composerText);
	});
	onDestroy(() => draftWriter.dispose());

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
		void goto('/');
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
		// Snapshot then reset state — turn.send does its own UI work
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
		await turn.send(text, attachedMediaIds, { editedMessageId: editedId });
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
								canUndo={m.id === activeLeafSummaryId && !turn.busy && !compacting}
								onUndo={undoCompaction}
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
						Off-screen render skipping (`content-visibility: auto`). The
						whole active branch is a flat, non-virtualized list, so a long
						code-heavy conversation piles up expensive layout/paint work
						(server `content_html` is 5-20x the source for shiki blocks).
						This lets the browser skip layout+paint for messages outside
						the viewport while keeping every node in the DOM — so
						getElementById deep-links, branch-switch re-centering, Ctrl-F
						find-in-page, and the scrollHeight pin-to-bottom all keep
						working unchanged (scrollIntoView/find force a skipped row to
						render). `contain-intrinsic-size: auto 150px` reserves a
						placeholder height so the scrollbar is roughly right before a
						row is first seen, and the `auto` keyword makes the browser
						remember each row's *real* height once rendered, so estimates
						stop mattering for the rest of the session. Progressive
						enhancement: browsers without support just render everything
						as before. See ROADMAP "Virtualized message list" for the
						heavier windowing tiers this defers.
					-->
						<div
							id="msg-{m.id}"
							in:messageIntro={{ streamed: m.id === turn.streamedMessageId }}
							class={[
								'group rounded-lg transition-colors duration-1000',
								'[content-visibility:auto] [contain-intrinsic-size:auto_150px]',
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
									assistantLabel={assistantLabelFor(m)}
									{mergeWithPrev}
									{mergeWithNext}
									onImageClick={openImageInLightbox}
									{openingLightboxFor}
									{approvalDecisions}
									approvalBusy={turn.approvalSubmitting}
									{onApprovalSelect}
									bottomCanvasCards={canvasCardsByGroupLast.get(m.id) ?? []}
									onOpenCanvas={(artifactId) => canvas.show(artifactId ?? undefined)}
								/>
							{/if}
							{#if (m.role === 'user' || m.role === 'assistant') && m.id !== editingMessageId && !mergeWithNext}
								<MessageActions
									message={m}
									{generating}
									recentlyCopied={recentlyCopiedId === m.id}
									canCopy={hasCopyableText(m)}
									userSentTokens={m.role === 'user' ? (userSentTokens.get(m.id) ?? null) : null}
									onCopy={() => copyMessage(m)}
									onEdit={() => beginEdit(m)}
									onReuse={() => reusePrompt(m)}
									onRetry={() => retryAssistant(m)}
									onSelectSibling={(id, dir) => selectSibling(id, dir)}
									onDeleteBranch={() => deleteBranch(m)}
								/>
							{/if}
						</div>
					{/if}
				{/each}

				{#if compactionStreaming}
					<CompactionSummaryStreaming text={compactionStreamText} />
				{/if}

				{#if showInFlight}
					{@const last = visibleMessages[visibleMessages.length - 1]}
					{@const fuseWithPrevAssistant =
						!!last && last.role === 'assistant' && last.id !== editingMessageId}
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
							onOpenCanvas={(artifactId) => canvas.show(artifactId ?? undefined)}
						/>
					</div>
				{/if}
				{#if fanout.comparing}
					<div in:fade={{ duration: listMounted && !reduceMotion ? 160 : 0 }}>
						<!-- Text fan-out: pick one to continue. Media fan-out (keep-many):
					     discard duds + regenerate, no single pick. -->
						<FanoutColumns
							columns={fanout.columns}
							onPick={fanout.isMedia ? undefined : (c) => void fanout.pick(c)}
							onDiscard={fanout.isMedia ? (c) => void fanout.discard(c) : undefined}
							onRegenerate={fanout.isMedia ? (c) => void fanout.regenerate(c) : undefined}
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
			<div
				class="pointer-events-auto relative mx-auto max-w-3xl"
				bind:clientHeight={composerHeight}
			>
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
					{#if showBudgetBar}
						<ContextBudgetBar
							{contextTokenCount}
							contextWindow={modelContextWindow}
							onCompact={compactConversation}
							canCompact={compactable}
							{compacting}
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
						onFeaturesChange={(next) => void persistDisabledFeatures(next)}
						onToggleFavorite={(id) =>
							void toggleFavoriteModel(data.prefs?.favoriteModels ?? [], id)}
						onSaveModelSet={(name, sels) =>
							void saveModelSet(data.prefs?.modelSets ?? [], name, sels)}
						onDeleteModelSet={(id) => void deleteModelSet(data.prefs?.modelSets ?? [], id)}
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
