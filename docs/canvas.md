# Canvas

Canvas is a side-by-side document the assistant edits across turns — for work
that takes several passes (an article, a spec, a config, a plan) where pasting
the whole document back and forth in chat is the friction. The document lives in
its own pane next to the conversation; the model revises it in place instead of
re-emitting it every turn.

## How it works

Two tools drive it, and the model calls them on its own when a task warrants a
document:

- **`create_canvas`** — opens the pane with an initial draft. Available in every
  text chat.
- **`update_canvas`** — edits the open document. Two modes: `str_replace` (a
  targeted find-and-replace of one exact passage) and `rewrite` (replace the
  whole document). The model uses `str_replace` for small changes so a revision
  costs a few tokens rather than re-typing the whole thing.

Each edit is a new **version**; the pane header shows the current version number.
Versions are kept, so the history is preserved even though Phase 1 shows only the
latest.

The document is authoritative on the server. Its current content is handed to the
model once per turn (appended at the end of the request, never mixed into the
cached system prompt) so the model always edits the live state without the
document bloating every turn's payload.

There is **one canvas per conversation** for now. If the model tries to create a
second, it's steered to `update_canvas` (use `rewrite` to start the document
over).

## What you can do

Phase 1 is **view-only** from your side: the assistant creates and edits the
document, and you watch it update live in the pane (a brief highlight marks each
change). Reloading the page restores the pane. Direct editing of the document by
hand is planned for a later phase.

Each time the assistant creates or edits the canvas, a small **canvas card**
(the document's title + version) appears in the conversation. Close the pane with
the ✕ in its header; click any canvas card to reopen it. The pane also reopens
automatically whenever the assistant makes another edit.

## Turning it off

Canvas is **on by default** in text chats. It's a per-conversation
[feature toggle](tools.md#per-conversation-feature-toggles) — switch off
**Canvas** in the conversation's feature menu to drop both canvas tools from that
conversation (useful if you want the leanest possible request payload for a chat
that will never need a document). Canvas tools never appear in image or video
generation conversations.
