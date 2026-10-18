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
- Queued image and video generations **survive a GlyphStream restart**, and an
  admin can **pause** an endpoint's queue to restart its backend without failing
  what's waiting ([multi-user guide](multi-user.md#endpoint-health)).
