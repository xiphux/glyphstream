/**
 * The draw dialog's workflow, for an avatar portrait or a texting photo: which
 * reply it's drawn onto, which image model draws it, the dialog's editable
 * prompt, the compare cart, and the draws themselves.
 *
 * Both are kept on their reply as versions (POST /photos; a portrait is the
 * one with no marker), not drawn into the thread — so there's nothing to park
 * and nothing to recover: one model closes the dialog and the picture shows on
 * its reply when it lands, and several are a comparison whose results the
 * dialog shows as they land, for the user to pick from. A portrait on show is
 * the conversation's face, which the server sets.
 *
 * Lifted out of the chat page, which hosts it.
 */
import { SvelteMap } from 'svelte/reactivity';
import { consumeChatStream } from './consume-chat-stream.js';
import { errorMessageFromResponse } from './fetch-error.js';
import { expandCompareSelections, type CompareSelection } from './fanout.js';
import { partsToText } from './message-parts.js';
import { extractAvatarPrompt } from './avatar-prompt.js';
import { toast } from './toast.svelte.js';
import { randomUUID } from './uuid.js';
import type { ModelCatalogue } from './model-catalogue.svelte.js';
import type { ChatMessage, MessageImage } from './types/api.js';

/** A picture the dialog is drawing: which reply, and which of its
 *  `[photo: …]` — null for the avatar portrait drawn from it. */
export interface PhotoDraw {
	replyId: string;
	index: number | null;
}

/** A comparison the dialog is showing: its draws, and the versions the
 *  picture already had, so the ones it adds can be told apart. */
export interface PhotoComparison extends PhotoDraw {
	conversationId: string;
	id: string;
	before: ReadonlySet<string>;
	/** Models still drawing, one entry per draw. */
	pending: string[];
	/** What every draw of it sends, but the model — a re-roll sends it again. */
	body: Record<string, unknown>;
}

const PORTRAIT = 'portrait';
const photoKey = (replyId: string, index: number | null) => `${replyId}:${index ?? PORTRAIT}`;

/** What the workflow reads from the host page. Getters, so each read is fresh:
 *  the page reassigns `convId` and `messages` on an in-place navigation. */
export interface AvatarDrawWorkflowDeps {
	/** The conversation currently on screen. */
	convId(): string;
	/** The active branch. */
	messages(): ChatMessage[];
	catalogue: ModelCatalogue;
	/** The user's saved avatar model, if any. */
	savedModelId(): string | null | undefined;
	/** Whether prompt enhancement starts on when the dialog opens. */
	enhanceByDefault(): boolean;
	/** The conversation's own avatar, as the page has it. */
	avatarMediaId(): string | null;
	/** Bring these replies' pictures (and the face) up to date on the page,
	 *  wherever they are in it — a change needs no reload of the window. */
	refreshPhotos(replyIds: string[]): Promise<void>;
}

export class AvatarDrawWorkflow {
	#deps: AvatarDrawWorkflowDeps;

	/** The dialog is up. */
	open = $state(false);
	/**
	 * The dialog's editable prompt. Seeded from the source reply when the dialog
	 * opens, then owned by the user — a model that answers in character before
	 * complying leaves prose to trim, and `extractAvatarPrompt` only removes what
	 * it can identify.
	 */
	prompt = $state('');
	/**
	 * Seeded from the conversation's own setting each time the dialog opens, so
	 * it starts where the rest of the app would put it — but it's the only place
	 * the choice is reachable at all, since the feature toggle is kind-scoped to
	 * image conversations and this is a chat one.
	 */
	enhance = $state(true);
	/**
	 * Picking several image models turns the draw into a comparison: a draw per
	 * model, picked from in the dialog's grid. Kept here (not dialog state)
	 * because the dispatch reads it as the form gives way to the grid.
	 */
	compareSelections = $state<CompareSelection[]>([]);
	compareMode = $state(false);
	/** What the dialog is drawing — a photo, or the avatar portrait (`index`
	 *  null). Set whenever it's open. */
	photo = $state<PhotoDraw | null>(null);
	/** A photo's shape, `W:H` or null for each model's default — bound to the
	 *  dialog's aspect-ratio picker. A portrait is always square. */
	aspectRatio = $state<string | null>(null);
	/** The comparison on show in the dialog, while it's up. */
	photoComparison = $state<PhotoComparison | null>(null);
	/** A single draw is on its way to the server: the dialog's button is spent
	 *  until it's accepted (or refused), so a second click can't start a
	 *  second draw. */
	photoSubmitting = $state(false);
	/** Draws THIS client has under way, by picture — the page also has the
	 *  server's word for it (`ChatMessage.developing`), which a reload keeps. */
	#drawing = new SvelteMap<string, number>();
	/** Versions this tab put on show, by picture, ahead of the page's data —
	 *  see `shownVersion`. A draw of the picture landing supersedes it. */
	#shown = new SvelteMap<string, string>();
	#modelOverride = $state<string | null>(null);

	/** The image models this user can draw with. */
	readonly imageModels = $derived.by(() =>
		this.#deps.catalogue.all.filter((m) => m.kind === 'image'),
	);

	/**
	 * The model they'll draw with now: their saved choice if it still resolves,
	 * else the first available. Re-saved on change (`setModel`), so picking is a
	 * one-time cost.
	 */
	readonly modelId = $derived.by(() => {
		if (this.#modelOverride) return this.#modelOverride;
		const saved = this.#deps.savedModelId();
		if (saved && this.imageModels.some((m) => m.id === saved)) return saved;
		// A saved choice we cannot see YET is not a saved choice we can override.
		// `openDialog` fires `ensureAll()` and opens in the same tick, so until it
		// lands `imageModels` holds only the image models in the first-paint slice —
		// substituting one of those would arm Draw on a model the user never picked,
		// and a click inside that window would generate on it. Empty disables Draw
		// (see generate's guard) for the moment it takes to resolve.
		//
		// Keyed on the load being in flight, NOT on `membership(saved) !== 'no'`: that
		// stays true forever for a saved model whose endpoint is down, and true even
		// once the catalogue is loaded and has simply reclassified the model as
		// non-image — both of which would leave Draw permanently disabled with no
		// fallback, where the old code offered the first available image model.
		if (saved && this.#deps.catalogue.status === 'loading') return '';
		return this.imageModels[0]?.id ?? '';
	});

	/**
	 * The reply the portrait gets drawn from: the most recent assistant message
	 * with text. Right after step 1 that IS the description, which is the whole
	 * sequence — but nothing forces it, so any reply you like can be the source.
	 */
	readonly sourceMessage = $derived.by(() =>
		[...this.#deps.messages()]
			.reverse()
			.find((m) => m.role === 'assistant' && partsToText(m.parts).trim()),
	);

	/**
	 * Whether the source reply already has a portrait, so the header menu's
	 * draw is another version rather than the first.
	 */
	readonly alreadyDrawn = $derived.by(
		() =>
			this.sourceMessage?.images?.some((i) => i.kind === 'portrait' && i.mediaId !== null) ?? false,
	);

	readonly #compareBranches = $derived.by(() =>
		expandCompareSelections(this.compareSelections, (id) => {
			const m = this.imageModels.find((x) => x.id === id);
			return m ? { displayName: m.displayName, modelKind: m.kind } : undefined;
		}),
	);
	readonly #comparing = $derived(this.compareMode && this.#compareBranches.length >= 2);

	/**
	 * What the header avatar says while a portrait is drawing anywhere in the
	 * thread: this tab's draws, and the server's word for the rest (a reload,
	 * another tab). Null when none is.
	 */
	readonly portraitStatus = $derived.by(() => {
		for (const key of this.#drawing.keys()) if (key.endsWith(`:${PORTRAIT}`)) return 'Drawing…';
		const drawing = this.#deps
			.messages()
			.some((m) => m.developing?.some((d) => d.kind === 'portrait'));
		return drawing ? 'Drawing…' : null;
	});

	constructor(deps: AvatarDrawWorkflowDeps) {
		this.#deps = deps;
	}

	/** Open the dialog to draw the avatar from `source` — by default the latest
	 *  reply with text, which right after the header menu's step 1 is the
	 *  description. */
	openDialog(source = this.sourceMessage): void {
		if (!source) return;
		// The dialog renders a model list and picks a default from it, and the
		// catalogue holds neither by default. Fire-and-forget: the dialog is a static
		// import so it opens on the tap regardless, and its picker fills in when this
		// resolves — `loading` is threaded through so the wait is visible.
		void this.#deps.catalogue.ensureAll();
		this.photo = { replyId: source.id, index: null };
		this.photoComparison = null;
		this.prompt = extractAvatarPrompt(partsToText(source.parts));
		this.aspectRatio = null;
		this.#openFresh();
	}

	/**
	 * Open the dialog to develop a texting photo — for the first time, again,
	 * or after a failure: the marker's description is the prompt, already the
	 * thing to draw — no in-character prose to trim, and any aspect ratio the
	 * model wrote into it is picked up by the dialog's ratio picker.
	 */
	openPhotoDialog(photo: PhotoDraw, description: string): void {
		void this.#deps.catalogue.ensureAll();
		this.photo = photo;
		this.photoComparison = null;
		this.prompt = description;
		this.aspectRatio = null;
		this.#openFresh();
	}

	/** Whether this client has a draw of the picture under way. */
	isDeveloping(replyId: string, index: number | null): boolean {
		return (this.#drawing.get(photoKey(replyId, index)) ?? 0) > 0;
	}

	/** Which of a reply's photos this client has draws under way for. */
	developingFor(replyId: string): Set<number> {
		const out = new Set<number>();
		const prefix = `${replyId}:`;
		for (const key of this.#drawing.keys()) {
			const rest = key.startsWith(prefix) ? key.slice(prefix.length) : null;
			if (rest !== null && rest !== PORTRAIT) out.add(Number(rest));
		}
		return out;
	}

	/** Close the dialog. A comparison carries on without it: its results land
	 *  as versions, and the arrows reach them. */
	close(): void {
		this.open = false;
		this.photoComparison = null;
	}

	#openFresh(): void {
		this.enhance = this.#deps.enhanceByDefault();
		// A fresh cart every time. Carrying one over would make the next draw a
		// silent comparison.
		this.compareMode = false;
		this.compareSelections = [];
		this.open = true;
	}

	/**
	 * Close the dialog and drop its staged prompt, on a conversation switch: it
	 * was written against the conversation being left, and pressing Draw would
	 * send the old chat's text with the new chat's source message.
	 */
	reset(): void {
		this.open = false;
		this.prompt = '';
		this.photo = null;
		this.photoComparison = null;
		this.#shown.clear();
	}

	setModel(id: string): void {
		this.#modelOverride = id;
		// Persist as the new default. Fire-and-forget: failing to remember a
		// preference must not block the generation the user is about to run.
		void fetch('/api/user/preferences', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ avatarModelId: id }),
		}).catch(() => {});
	}

	/** Draw what the dialog is open for. */
	generate(): void {
		if (this.photo) this.#developPhoto(this.photo);
	}

	/**
	 * Draw a photo or portrait: one draw per model picked, each kept on the
	 * reply as a version when it lands. One model closes the dialog once the
	 * server has the draw, and the picture shows on its reply when it arrives.
	 * Several are a comparison: the dialog stays up and shows each result as it
	 * lands, for the user to pick from (`showPhoto` with `pick`).
	 *
	 * The server owns the outcome either way — a failure is stored on the photo
	 * and shows there — so all that's left to a live client is pulling results
	 * into view, and saying why a draw it asked for was refused.
	 */
	#developPhoto(photo: PhotoDraw): void {
		if (this.photoSubmitting) return;
		const cid = this.#deps.convId();
		const models = this.#comparing
			? this.#compareBranches.map((b) => b.modelId)
			: this.modelId
				? [this.modelId]
				: [];
		if (models.length === 0) return;
		const reply = this.#deps.messages().find((m) => m.id === photo.replyId);
		const compareId = models.length > 1 ? randomUUID() : null;
		const body = {
			messageId: photo.replyId,
			// A portrait has no marker, and is always square.
			...(photo.index === null
				? { kind: 'portrait' }
				: { index: photo.index, aspectRatio: this.aspectRatio }),
			prompt: this.prompt,
			enhance: this.enhance,
			...(compareId ? { compare: compareId } : {}),
		};
		if (compareId) {
			this.photoComparison = {
				...photo,
				conversationId: cid,
				id: compareId,
				before: new Set(
					(reply?.images ?? []).filter((i) => i.markerIndex === photo.index).map((i) => i.id),
				),
				pending: [...models],
				body,
			};
			this.compareMode = false;
			this.compareSelections = [];
		}
		// A comparison swaps the form for its grid at once; a single draw holds
		// the button until the server has it.
		if (!compareId) this.photoSubmitting = true;
		for (const modelId of models) void this.#developOne(cid, photo, modelId, body, compareId);
	}

	/** Another draw in the comparison on show, from `modelId` — a tile's
	 *  Regenerate. It lands beside the others, and counts with them. */
	developAgainInComparison(modelId: string): void {
		const comparison = this.photoComparison;
		if (!comparison || this.#deps.convId() !== comparison.conversationId) return;
		this.photoComparison = { ...comparison, pending: [...comparison.pending, modelId] };
		void this.#developOne(
			comparison.conversationId,
			{ replyId: comparison.replyId, index: comparison.index },
			modelId,
			comparison.body,
			comparison.id,
		);
	}

	async #developOne(
		cid: string,
		photo: PhotoDraw,
		modelId: string,
		body: Record<string, unknown>,
		compareId: string | null,
	): Promise<void> {
		const key = photoKey(photo.replyId, photo.index);
		this.#drawing.set(key, (this.#drawing.get(key) ?? 0) + 1);
		try {
			const res = await fetch(`/api/conversations/${cid}/photos`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...body, modelId }),
			});
			if (!compareId) this.photoSubmitting = false;
			if (!res.ok || !res.body) throw new Error(await errorMessageFromResponse(res));
			// Accepted. A single draw needs nothing more from the dialog.
			if (!compareId && this.#deps.convId() === cid && this.photo === photo) this.open = false;
			// Every outcome — a version, or a failure kept on the photo — is the
			// server's to store; the stream only says when to look.
			await consumeChatStream(res.body, {});
		} catch (e) {
			// Refused, or the connection went. A refusal is worth saying; a lost
			// connection isn't — the draw carries on, and the photo says so.
			if (this.#deps.convId() === cid && e instanceof Error && !(e instanceof TypeError)) {
				toast.error(e.message);
			}
		} finally {
			if (!compareId) this.photoSubmitting = false;
			// What lands goes on show by the data's rules (a new draw, or a
			// comparison's first result), not by an earlier switch here.
			this.#shown.delete(key);
			const left = (this.#drawing.get(key) ?? 1) - 1;
			if (left > 0) this.#drawing.set(key, left);
			else this.#drawing.delete(key);
			const comparison = this.photoComparison;
			if (comparison?.id === compareId) {
				const at = comparison.pending.indexOf(modelId);
				if (at !== -1) {
					this.photoComparison = {
						...comparison,
						pending: comparison.pending.filter((_, i) => i !== at),
					};
				}
			}
			if (this.#deps.convId() === cid) await this.#deps.refreshPhotos([photo.replyId]);
		}
	}

	/**
	 * The version a picture shows, where this tab has just put one on show and
	 * the page's data may not say so yet. Undefined to go by the data.
	 */
	shownVersion(replyId: string, index: number | null): string | undefined {
		return this.#shown.get(photoKey(replyId, index));
	}

	/**
	 * Put a version of a picture on show — the arrows, or a comparison's pick,
	 * which also counts toward the models' stats and closes the dialog. A
	 * portrait on show is the face, which the server sets.
	 *
	 * The switch shows at once, and the arrows don't reload a photo for it:
	 * nothing else on the page reads which version is on show, and a reload of
	 * this route re-sends the whole window. A pick does (the end of a comparison
	 * whose results may still be landing), and so does a portrait, to pick up
	 * the face — both through the light photo read, not the page's load.
	 */
	async showPhoto(replyId: string, image: MessageImage, pick = false): Promise<void> {
		const cid = this.#deps.convId();
		const key = photoKey(replyId, image.markerIndex);
		const before = this.#shown.get(key);
		this.#shown.set(key, image.id);
		try {
			const res = await fetch(`/api/conversations/${cid}/photos/${image.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ shown: true, ...(pick ? { pick: true } : {}) }),
			});
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			// Not if the user has moved to another chat, where a dialog up now is one
			// they opened there.
			if (pick && this.#deps.convId() === cid) this.close();
		} catch (e) {
			// Back to what was showing, unless a later switch has moved on since.
			if (this.#shown.get(key) === image.id) {
				if (before === undefined) this.#shown.delete(key);
				else this.#shown.set(key, before);
			}
			toast.error(e instanceof Error ? e.message : String(e));
			return;
		}
		if ((pick || image.kind === 'portrait') && this.#deps.convId() === cid) {
			await this.#deps.refreshPhotos([replyId]);
		}
	}

	/**
	 * Move a version's image to the trash, which takes it off the picture
	 * (restoring the image brings it back). Removing the portrait that is the
	 * face moves the face to the version now on show — or, with none left, back
	 * to the preset's.
	 */
	async removePhoto(replyId: string, image: MessageImage): Promise<void> {
		if (!image.mediaId) return;
		const cid = this.#deps.convId();
		const wasFace = image.kind === 'portrait' && image.mediaId === this.#deps.avatarMediaId();
		try {
			const res = await fetch(`/api/media/${image.mediaId}`, { method: 'DELETE' });
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
			return;
		}
		if (this.#deps.convId() !== cid) return;
		await this.#deps.refreshPhotos([replyId]);
		if (!wasFace || this.#deps.convId() !== cid) return;
		const next = this.#deps
			.messages()
			.find((m) => m.id === replyId)
			?.images?.find((i) => i.kind === 'portrait' && i.shown && i.mediaId);
		if (next) {
			await this.showPhoto(replyId, next);
			return;
		}
		try {
			const res = await fetch(`/api/conversations/${cid}/avatar`, { method: 'DELETE' });
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		}
		if (this.#deps.convId() === cid) await this.#deps.refreshPhotos([replyId]);
	}
}
