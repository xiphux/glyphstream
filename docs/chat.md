# Chatting

A tour of the chat view: what each part of it does, and the behaviour that
isn't obvious from looking at it. Operator-side settings are linked where they
exist; everything else here works out of the box.

## Conversations

- **Streaming with live markdown.** Replies render as markdown while they
  stream, with syntax-highlighted code; when the reply finishes, the server's
  full-coverage highlight swaps in. Once a reply finishes, every code block
  has a copy button in its corner (on hover with a mouse, always shown on
  touch), which copies the block's raw text.
- **Reasoning blocks.** Thinking models (DeepSeek-R1, the o-series, anything
  that streams reasoning) get a collapsible reasoning block that expands while
  the model is thinking.
- **Branching.** Edit or retry any message and the old version is kept as a
  sibling; move between them with the `‹ N/M ›` arrows. A conversation is a
  tree, not a log, so nothing is lost by trying again.
- **New chat from any prompt.** Reuse a prompt in a fresh conversation — image
  attachments, model (or whole compare set) and all. It lands in the composer
  ready to tweak, never auto-sent.
- **Search and archive.** Full-text search across every conversation (`⌘K`).
  Archive a conversation to clear it from the sidebar without deleting it; the
  Archived page lists them, to reopen, unarchive or delete.
- **Auto-titling** through a small, fast task model of your choice
  ([configuration](configuration.md#auto-titling-task_model)).
- **Canvas** — a side-by-side document the assistant drafts and revises across
  turns, for work that takes several passes ([guide](canvas.md)).
- **Prompt snippets** — reusable prompt pieces inserted with `;`
  ([guide](prompt-snippets.md)).
- **Emoji reactions** — the assistant can tap a single emoji onto your message,
  the way a person does in iMessage. It reads the register: warm, playful
  threads earn one now and then, technical ones rarely or never
  ([details](tools.md#emoji-reactions)).

## The context window

Every turn re-sends the conversation so far, so GlyphStream works to keep that
payload honest and visible.

- **The context bar.** Above the composer, the thread's running size against the
  model's window (`27,725 / 40,960 tokens`), when the window is known — detected
  from llama.cpp / vLLM, or set per endpoint
  ([configuration](configuration.md#context-window-context_window)). Token usage
  and generation speed (tok/s) for each reply are in its info popover.
- **Context breakdown.** Click the bar to see what is filling the window,
  itemised: saved memories, the skills catalog, each tool definition, messages,
  tool results, images. It separates the overhead re-sent on every turn from the
  history compaction can reclaim, so "compacting won't help here" is something
  you can see rather than discover.
- **Compaction.** When a thread fills a small window, the older turns are
  summarised through the conversation's own model and the thread keeps going.
  The real messages stay in the thread (the summary is a collapsed divider);
  only what's sent to the model is trimmed. On by default at 80% of the window,
  because otherwise a thread just grows until the model refuses it. Compact by
  hand from the context bar, or tune the threshold or switch it off in
  Preferences. A compaction can be undone — from the toast or the divider —
  until you send the next message.
- **Bulky tool results are capped on the way to the model**, not in your
  transcript: the model gets the head and tail of an oversized result with the
  middle elided, and you keep the whole thing
  ([configuration](configuration.md#tool-result-size-tools-max_tool_result_chars)).
- **Images are downscaled on the way to the model**, not in storage. An attached
  image rides along on every later turn, so the model gets a 1568px JPEG copy
  while your original is kept untouched for the gallery, downloads and
  image-to-image ([configuration](configuration.md#inlined-image-size-vision)).
- **The model knows what day it is, in your timezone.** Your browser's zone is
  synced to your profile and today's date rides in the system prompt, so
  "last Tuesday" resolves against today rather than the training cutoff.
  `get_current_time` answers in your zone too.

## Memory and recall

- **Per-user memory.** The model can save, update and forget facts about you
  across conversations. Once the store grows large, the most relevant facts
  (recently or often recalled, or freshly saved) stay inlined in full while the
  rest collapse to a compact topic index, which the model reads back on demand
  by id or search — semantic search when an embedding model is configured.
- **Dreaming.** With an optional `[memory_model]`, a scheduled background pass
  tidies the store — merging duplicates, folding superseded facts, distilling
  stale notes. Everything it changes stays reviewable and restorable from
  settings for about 30 days
  ([configuration](configuration.md#memory-consolidation-memory_model)).
- **Conversation recall.** A `search_conversations` tool lets the model search
  your past chats when you refer back to something discussed before, instead of
  guessing ([tools guide](tools.md)).
- Memory and recall share the **Personalization** toggle, which can be switched
  off per conversation like any other feature
  ([feature toggles](tools.md#per-conversation-feature-toggles)).
- **Private chat** is the incognito mode: a conversation that never feeds your
  memories, summaries or recall, with personalization, web and MCP tools sealed
  off. The whole app re-tints while you're in one
  ([details](tools.md#private-chat)).

## Never losing a message

- **Generations survive disconnects.** Leave mid-reply — close the tab, lose
  signal, let iOS suspend the installed app — and the stream recovers when you
  come back.
- **Stop works everywhere.** The Stop button cancels chat, image and video
  generations alike.
- **Draft autosave.** A half-typed prompt is kept per conversation and restored
  after a reload.
- **Offline-aware composer.** In a dead zone, Send disables with an inline
  notice; your message stays in the box and sending re-enables the moment
  you're back online.

## Making it yours

- **Themes.** The Signature frosted-glass look, plus Claude- and ChatGPT-style
  themes; light / dark / system, each with its own motion personality.
- **Personalization.** Structured persona fields (name, about you, custom
  instructions) the model sees, and rotating greetings on the new-chat screen.
- **Start a chat from a URL.** Open the home page with a `#q=` fragment
  (`https://your-host/#q=write%20a%20haiku`) to prefill the composer — handy for
  an iOS share-sheet Shortcut, since iOS won't let an installed web app receive
  shares directly. The fragment keeps even long prompts off the request line.
- **Installable app** with iOS-aware safe areas, push notifications when a long
  generation finishes, and an icon badge for threads waiting on you
  ([guide](notifications.md)).
