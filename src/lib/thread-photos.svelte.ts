/**
 * The photos on a thread's replies, as the chat page shows them: each reply's
 * texting photos and avatar portrait, the version this tab has just put on
 * show ahead of the data, the draws it lost track of, and the conversation's
 * face as the light photo read (`GET …/photos?messages=`) last reported it.
 *
 * A photo's state lives on its reply, which may be above the window a reload
 * would bring back, so a change patches the replies in place
 * (`PhotoStateResponse`) wherever they are on the page. While the data says
 * photos are developing, `watch` keeps asking the server (photo-develop-watch).
 *
 * The page is reused across conversations, so every read is pinned to the
 * conversation it started in and dropped if the page has moved on by the time
 * it lands. The draw dialog (AvatarDrawWorkflow) does the drawing and tells
 * this what changed; the chat page hosts both.
 */
import { SvelteMap } from 'svelte/reactivity';
import { photoMarkers } from './texting-photos.js';
import { watchDevelopingPhotos } from './photo-develop-watch.js';
import type { AvatarDrawWorkflow } from './avatar-draw-workflow.svelte.js';
import type { TextingPhotos } from './texting.js';
import type {
	ChatMessage,
	DevelopingImage,
	MessageImage,
	PhotoStateResponse,
} from './types/api.js';

/** A draw's end waits on a refresh before it stops counting, so a request
 *  stalled on a socket a resume left dead gives up rather than hold
 *  "Developing…" up. */
const REFRESH_TIMEOUT_MS = 15_000;

const PORTRAIT = 'portrait';
const photoKey = (replyId: string, index: number | null) => `${replyId}:${index ?? PORTRAIT}`;

/** What the slots' buttons reach: the draw dialog and its draws. */
export type PhotoDraws = Pick<
	AvatarDrawWorkflow,
	'developingFor' | 'isDeveloping' | 'showPhoto' | 'removePhoto' | 'openDialog' | 'openPhotoDialog'
>;

/** What the thread's photos read from the host page. Getters, so each read is
 *  fresh: the page reassigns `convId` and `messages` on an in-place navigation. */
export interface ThreadPhotosDeps {
	/** The conversation currently on screen. */
	convId(): string;
	/** The active branch. */
	messages(): ChatMessage[];
	setMessages(next: ChatMessage[]): void;
	/** The conversation as the page's load has it: its own avatar, and
	 *  whether its preset sends photos (`[photo: …]`). */
	loaded(): { id: string; avatarMediaId: string | null; photos: boolean };
	/** An image model can draw: the server's word, not the catalogue's
	 *  first-paint slice. */
	hasImageModel(): boolean;
	draws(): PhotoDraws;
}

export class ThreadPhotos {
	#deps: ThreadPhotosDeps;

	/** The face as the light photo read last reported it; a reload of the
	 *  route re-sends the whole window, so the load running again clears it
	 *  (`forgetFace`) with the same answer. */
	#face = $state<{ conversationId: string; mediaId: string | null } | undefined>();
	/** Versions this tab put on show, by picture, ahead of the page's data. A
	 *  draw of the picture landing supersedes it (`forgetShown`). */
	#shown = new SvelteMap<string, string>();
	/** Draws whose streams were lost, by reply and draw, since a refresh here
	 *  last had the server's word on the reply — how many the reply's
	 *  `developing` has to account for. The watch can have that word first; a
	 *  count left high then guesses one draw too many, which the watch's next
	 *  look corrects. Not reactive: only the guess reads it. */
	#lost = new Map<string, number>();

	/** The conversation's own face: the light read's, else the load's. */
	readonly avatarMediaId = $derived.by(() => {
		const loaded = this.#deps.loaded();
		return this.#face && this.#face.conversationId === loaded.id
			? this.#face.mediaId
			: loaded.avatarMediaId;
	});

	constructor(deps: ThreadPhotosDeps) {
		this.#deps = deps;
	}

	/** The page's load ran again: its word on the face outranks the read's. */
	forgetFace(): void {
		this.#face = undefined;
	}

	/** Leaving the conversation: a version put on show here belongs to it. */
	reset(): void {
		this.#shown.clear();
	}

	/**
	 * A reply's texting photos, in a chat whose preset sends them: each one's
	 * developed versions and the draws under way — the server's word (which a
	 * reload keeps) and this tab's own. A photo is kept on its reply, so it can
	 * be developed at any time, whatever else is running.
	 */
	photosFor(m: ChatMessage, assistantLabel: string): TextingPhotos | undefined {
		if (!this.#deps.loaded().photos || m.role !== 'assistant') return undefined;
		const versions = new Map<number, MessageImage[]>();
		for (const image of m.images ?? []) {
			if (image.kind !== 'photo' || image.markerIndex === null) continue;
			const list = versions.get(image.markerIndex);
			if (list) list.push(image);
			else versions.set(image.markerIndex, [image]);
		}
		for (const [index, list] of versions) versions.set(index, this.#withShown(m.id, index, list));
		const draws = this.#deps.draws();
		const developing = draws.developingFor(m.id);
		for (const d of m.developing ?? []) if (d.markerIndex !== null) developing.add(d.markerIndex);
		return {
			versions,
			developing,
			...this.#developable((index: number) => this.#developPhoto(m, index, assistantLabel)),
			onShow: (image: MessageImage) => void draws.showPhoto(m.id, image),
			onRemove: (image: MessageImage) => void draws.removePhoto(m.id, image),
		};
	}

	/** The avatar portraits drawn from a reply — any reply, in any chat — as
	 *  one picture at the end of it, wherever there are some or one is drawing. */
	portraitFor(m: ChatMessage): TextingPhotos | undefined {
		if (m.role !== 'assistant') return undefined;
		const draws = this.#deps.draws();
		const versions = (m.images ?? []).filter((i) => i.kind === 'portrait');
		const developing =
			draws.isDeveloping(m.id, null) || !!m.developing?.some((d) => d.kind === 'portrait');
		if (versions.length === 0 && !developing) return undefined;
		return {
			versions: new Map([[0, this.#withShown(m.id, null, versions)]]),
			developing: new Set(developing ? [0] : []),
			...this.#developable(() => draws.openDialog(m)),
			onShow: (image: MessageImage) => void draws.showPhoto(m.id, image),
			onRemove: (image: MessageImage) => void draws.removePhoto(m.id, image),
		};
	}

	/** A picture's versions, with the one this tab just put on show marked so. */
	#withShown(replyId: string, index: number | null, list: MessageImage[]): MessageImage[] {
		const shown = this.#shown.get(photoKey(replyId, index));
		if (!shown || !list.some((v) => v.id === shown && v.mediaId)) return list;
		return list.map((v) => (v.shown === (v.id === shown) ? v : { ...v, shown: v.id === shown }));
	}

	/** Develop on offer where an image model can do it; otherwise the picture
	 *  says why not. */
	#developable(onDevelop: TextingPhotos['onDevelop']) {
		return this.#deps.hasImageModel() ? { onDevelop } : { noImageModel: true };
	}

	#developPhoto(reply: ChatMessage, index: number, assistantLabel: string): void {
		const marker = photoMarkers(reply, assistantLabel).find((p) => p.index === index);
		if (!marker) return;
		this.#deps.draws().openPhotoDialog({ replyId: reply.id, index }, marker.description);
	}

	/**
	 * The version a picture shows, where this tab has just put one on show and
	 * the page's data may not say so yet. Undefined to go by the data.
	 */
	shownVersion(replyId: string, index: number | null): string | undefined {
		return this.#shown.get(photoKey(replyId, index));
	}

	/** Show a version at once, ahead of the server; returns the undo, which
	 *  restores what was showing unless a later switch has moved on since. */
	showAhead(replyId: string, index: number | null, imageId: string): () => void {
		const key = photoKey(replyId, index);
		const before = this.#shown.get(key);
		this.#shown.set(key, imageId);
		return () => {
			if (this.#shown.get(key) !== imageId) return;
			if (before === undefined) this.#shown.delete(key);
			else this.#shown.set(key, before);
		};
	}

	/** Go by the data again for a picture — a draw of it has landed, and goes
	 *  on show by the data's rules, not by an earlier switch here. */
	forgetShown(replyId: string, index: number | null): void {
		this.#shown.delete(photoKey(replyId, index));
	}

	/** Patch the replies the state names, and the face. */
	apply(state: PhotoStateResponse): void {
		this.#face = { conversationId: this.#deps.convId(), mediaId: state.avatarMediaId };
		this.#deps.setMessages(
			this.#deps.messages().map((m) => {
				if (!Object.hasOwn(state.replies, m.id)) return m;
				const { images, developing } = state.replies[m.id];
				return {
					...m,
					images: images.length ? images : undefined,
					developing: developing.length ? developing : undefined,
				};
			}),
		);
	}

	/** Bring these replies' pictures (and the face) up to date. False when the
	 *  server couldn't be asked, or the page has moved to another conversation. */
	async refresh(replyIds: string[]): Promise<boolean> {
		const conversationId = this.#deps.convId();
		try {
			const res = await fetch(
				`/api/conversations/${conversationId}/photos?messages=${replyIds.join(',')}`,
				{ signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) },
			);
			if (!res.ok) return false;
			const state = (await res.json()) as PhotoStateResponse;
			// The body is read after the headers: the reader can have moved on
			// during either wait.
			if (this.#deps.convId() !== conversationId) return false;
			this.apply(state);
			return true;
		} catch {
			// The develop watch, or the next look at the photo, catches up.
			return false;
		}
	}

	/**
	 * A draw on the reply has ended: the server's word on it — the result, or a
	 * draw it's still making — before the caller stops counting it as its own,
	 * so the picture goes from developing straight to that with no gap. `lost`
	 * is the draw when its stream ended without the server's last word; with no
	 * word to be had either, it stays counted on the reply until the watch gets
	 * one.
	 */
	async drawEnded(replyId: string, lost: DevelopingImage | null): Promise<void> {
		const conversationId = this.#deps.convId();
		const fresh = await this.refresh([replyId]);
		if (fresh) this.#forgetLost(replyId);
		else if (lost && this.#deps.convId() === conversationId) this.#assumeLost(replyId, lost);
	}

	/**
	 * Count a lost draw on its reply — unless the reply already lists one for
	 * it. The server's last word often does (a suspended PWA loses every stream
	 * at once, after earlier results' refreshes listed the rest), and a guess on
	 * top would show the draw twice. Counted per draw, so two lost draws of one
	 * model need two entries.
	 */
	#assumeLost(replyId: string, draw: DevelopingImage): void {
		const key = `${replyId}|${draw.kind}|${draw.markerIndex}|${draw.modelId}|${draw.compareId}`;
		const lost = (this.#lost.get(key) ?? 0) + 1;
		this.#lost.set(key, lost);
		const reply = this.#deps.messages().find((m) => m.id === replyId);
		const listed = (reply?.developing ?? []).filter(
			(d) =>
				d.kind === draw.kind &&
				d.markerIndex === draw.markerIndex &&
				d.modelId === draw.modelId &&
				d.compareId === draw.compareId,
		).length;
		if (listed < lost) this.assumeDeveloping(replyId, draw);
	}

	/** The server's word on a reply has replaced whatever was guessed on it. */
	#forgetLost(replyId: string): void {
		for (const key of this.#lost.keys()) {
			if (key.startsWith(`${replyId}|`)) this.#lost.delete(key);
		}
	}

	/** Count a draw as still out on its reply, so the watch asks the server
	 *  about it — whose answer then replaces the guess. */
	assumeDeveloping(replyId: string, draw: DevelopingImage): void {
		this.#deps.setMessages(
			this.#deps
				.messages()
				.map((m) => (m.id === replyId ? { ...m, developing: [...(m.developing ?? []), draw] } : m)),
		);
	}

	/**
	 * Watch the replies the data says have photos developing, until they land —
	 * this tab may hold no stream that will say so. For an `$effect` to call,
	 * so it re-arms as the data changes; returns the stop, or nothing while no
	 * photo is developing.
	 */
	watch(): (() => void) | undefined {
		const replies = this.#deps.messages().filter((m) => m.developing?.length);
		if (replies.length === 0) return undefined;
		const conversationId = this.#deps.convId();
		return watchDevelopingPhotos({
			conversationId,
			replyIds: replies.map((m) => m.id),
			expected: replies.reduce((n, m) => n + (m.developing?.length ?? 0), 0),
			apply: (state) => {
				if (this.#deps.convId() === conversationId) this.apply(state);
			},
		});
	}
}
