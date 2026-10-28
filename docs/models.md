# Models and comparing them

GlyphStream aggregates the models of every configured endpoint into one picker,
and treats sending one prompt to several of them as an everyday workflow rather
than a special mode. Endpoints themselves are set up in
[configuration](configuration.md#endpoints).

## The picker

- Every endpoint's models in **one searchable picker**, grouped by provider.
- **Favorites**, drag-to-reorder and pinned in the sidebar.
- **Switch per turn.** The model is chosen per message, so a conversation can
  move between models mid-thread.
- Image and video models show what they take and make (`T2I`, `I2I`, `TI2V`) —
  see [images & video](media.md#generating).

## Multi-model compare

- **Fan-out.** Select several models and send one prompt to all of them — text,
  image or video — streaming side by side, each with its own queue state and
  timer. Keep the winner, or keep them all as branches.
- **Split attachments.** Fan N input images across M models for a full
  cross-product comparison grid.
- **Saved model sets.** Name a compare selection you reach for often (your
  go-to image models, say) and re-apply it to a new prompt in one click.

## Custom models

Saved presets of base model + system prompt + parameters, like custom GPTs. A
preset can carry its own defaults for the
[feature toggles](tools.md#per-conversation-feature-toggles) and an optional
avatar shown beside its name above each reply. A preset is copied onto a
conversation when the conversation is created, so editing the preset later
doesn't change chats that already used it.

### Texting reply style

A preset's **Reply style** can be set to **Texting**, for presets meant to feel
like a text conversation. Each paragraph of a reply then shows as its own chat
bubble, as if the other side had sent several texts in a row. Glyphstream tells
the model to write that way, so the preset's system prompt only needs to describe
the character. While a reply is arriving, the text being written shows as a
typing indicator, and appears whole once it's done.

The same preset can play more than one person. A text that starts with a name and
a colon (`Sam: see you there`) shows under that name, with a coloured initial.
The preset's own texts show its avatar, or an initial too if it has none.
Texts with no name come from whoever sent the previous one; each reply starts
with the preset itself. If the model puts the preset's own name in front of a
text, that text shows as the preset's. To keep ordinary sentences from reading as
a speaker, a name counts only at the very start of a text, must be at most three
words and 30 characters, and must be followed by a colon and a space.

This only changes how replies look. Each reply is still stored as one message, so
retrying, editing and branching work as usual. The model also sees its earlier
replies exactly as it wrote them, names included. Like the rest of a preset, the
style is fixed when a conversation is created.

### Photos

A custom model can send photos. Turn on **Can send photos** in the preset (it's
on by default for a texting preset and off for a standard one, like **Can check
in**). Glyphstream then tells the model it can write a paragraph of its own as
`[photo: …]`, describing the picture in full along with its aspect ratio. That
paragraph shows as a photo placeholder with the description and a **Develop**
button — as a text of its own in a texting reply, or in place within a standard
one. Chats without a preset don't send photos, and like the rest of a preset,
the setting is copied into each chat when it starts.

**Develop** opens the same dialog as drawing an avatar, with the description
already filled in. You can edit the prompt, pick a shape (a ratio named in the
description is preselected), and choose an image model. The draw runs in the
background, and the photo appears in place of its placeholder, where it was
sent, when it's done. Developing doesn't change the conversation, so you can develop any
photo at any time: after you've replied, or while another reply is arriving.

Each photo keeps every version you develop. The button on the photo develops it
again, the arrows along its bottom switch between versions, and the bin removes the
one on show (its image goes to Recently deleted, and restoring it puts it back).
Pick several models in the dialog to compare: their versions appear in the
dialog as they finish, and you pick the one to show. The others are kept too.
If a draw fails, the photo says so, with a button to try again.

A photo is shown but never sent back to the model, which already has its
description. To make a character send more or fewer photos, say so in the
preset's prompt ("loves sending selfies").

### Check-ins

A custom model can get back to you on its own. Turn on **Can check in** in the
preset (it's on by default for a texting preset and off for a standard one,
which is more often a tool than a character). Then, when the model says it'll
get back to you later, it ends its reply with `[later 2h: …]`: how long to wait
(up to a day), and a note to itself about what it meant to say. That line isn't
shown. Instead, a note under the reply says when it will check in, with a
**Cancel** link. Chats without a preset never check in.

If the reply is still the latest thing in the thread when the time comes,
Glyphstream sends the model a reminder in your place. The reminder says what
time it is, how long it's been, and what the model meant to do. The model then
writes to you, and you get a notification as if it had reached out on its own.
The reminder shows in the thread as a "checked in" divider, not as a message from
you. A check-in can also be just an emoji, which shows as the model's own text.
If the moment has passed, the model can decline, and the check-in leaves no
trace.

A check-in is called off when you answer, regenerate the reply, or switch to
another branch before it's due. It waits while something else is running in the
conversation, and is dropped if that makes it more than half an hour late (or a
quarter of its delay, for a long one) — after a restart, say. A model can follow
up on its own check-in once; after two in a row with no answer from you, it
stops until you reply. Each conversation has at most one pending check-in.

Like the rest of a preset, the setting is copied into each chat when it starts,
so changing it later doesn't affect chats already under way. For something on a
timetable — a morning summary, say — use a
[scheduled task](scheduled-tasks.md) instead. Operators can turn check-ins off
entirely with `[check_ins] enabled = false`.

## Sharing hardware

- **Per-endpoint concurrency caps** queue requests instead of running your
  single-GPU box out of memory
  ([configuration](configuration.md#limiting-concurrency-max_concurrent)).
- **Endpoints on one GPU can share a queue** and hand the VRAM over — unloading
  the chat model before an image generation starts
  ([configuration](configuration.md#sharing-one-gpu-between-endpoints-resource_group)).
- Queued image and video generations **survive a GlyphStream restart**
  ([details](multi-user.md#restarting-glyphstream-with-generations-queued)), and
  an admin can **pause** an endpoint's queue to restart its backend without
  failing what's waiting ([details](multi-user.md#pausing-a-queue)).

## Model stats

**Settings → Model stats** (admins) shows how much each model is used and how
its output is received. Use it to decide which models are worth keeping,
which matters most for a multi-gigabyte local model.

Models are grouped by endpoint, with endpoints marked `local = true` first
([configuration](configuration.md#endpoints)). Models that did nothing in the
chosen period (30 days, 90 days or all time) are folded into a collapsed
**unused** list per endpoint, longest-idle first. Models the endpoint no longer
offers fold into **no longer offered**. A model configured for a background job
(title, memory, prompt enhancement, embeddings, rerank) is never listed as
unused; it shows its role and how many calls it served instead.

What's counted:

- **Chat:** turns, speed, how often replies were **retried**, failed, cut off
  at the length limit or had their branch deleted, how often a conversation
  **switched away** to another chat model (switching to an image model doesn't
  count), and **picks** in side-by-side comparisons. A stopped reply is told
  apart by what follows it: stopping and then retrying is held against the
  model, stopping and then editing the prompt is not.
- **Images and video:** outputs, average generation time, how many were
  **favorited**, **built on** (used as the input to another generation, or as
  an avatar), **deleted** or failed, and picks in comparisons. Deleting a
  whole conversation with its media isn't counted as rejecting each image, and
  restoring from the trash takes a deletion back.
- **Everyone:** how many people used each model in the period, when it was last
  used, how many have it among their favorites, and which custom presets are
  built on it.

Reactions are shown as a share of the model's own use (retried 8% of its
replies, deleted 30% of its images), never as a running total. A model you've
kept for months has piled up more of everything than one installed last week.
Counting that against it would penalise the models you've been happiest to
keep. Below five events a share shows as a fraction ("2/3"), since a percentage
of three is noise.

Losing a comparison is never held against a model. The others may have been
fine, just not the best fit. What counts against a model is an output someone
deleted. Flags such as **Often retried** or **Well liked** only appear once
there's enough evidence. A model with three replies, all retried, isn't
flagged. **Mixed reception** is the softer warning below **Often deleted** /
**Often retried**: a noticeable share of deletions or retries, worth a look (a
workflow to tweak, a replacement to try) rather than a verdict. A model first
used in the last two weeks is marked **New**, with how many days of data it
has. Its numbers rest on a short history and may still move, and "barely used"
may only mean "only just installed". A flag on a new model still needs the
same evidence as any other.

Stats are counted as things happen, from the version that introduced them.
Earlier usage (turns, generations, favorites) is filled in from history that
still exists. Retries, deletions and picks start at zero, because the old data
can't say why something was deleted.
