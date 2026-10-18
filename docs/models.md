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
flagged. A model first counted in the last two weeks is marked **New**, with
how many days of data it has. Its numbers rest on a short history and may still
move, and "barely used" may only mean "only just installed". A flag on a new
model still needs the same evidence as any other.

Stats are counted as things happen, from the version that introduced them.
Earlier usage (turns, generations, favorites) is filled in from history that
still exists. Retries, deletions and picks start at zero, because the old data
can't say why something was deleted.
