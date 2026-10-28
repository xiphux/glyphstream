# Changelog

What changed for people using Glyphstream, newest first.

Internal work — refactors, tests, dependency bumps, CI — is deliberately absent,
and so is any fix to a problem that never reached a release. See
[`docs/`](docs/) for how a feature actually works; entries here only say that it
arrived.

## Unreleased

### Changed

- A texting reply shows a typing indicator while each text is being written, and the text appears whole once it's done, instead of filling in word by word.
- A texting preset with no avatar shows a coloured initial beside its texts, as other speakers do.

## v0.51.0

### Added

- Custom models can check in on you: when one says it'll get back to you later, it sets a reminder, and if you haven't replied by then it reaches out, with a notification. On by default for texting presets; a per-preset setting for the rest. Operators can switch it off server-wide with `[check_ins] enabled = false`.

## v0.50.0

### Added

- Custom models can use a texting reply style: each paragraph of a reply arrives as its own chat bubble, and a `Name:` prefix lets one preset play several people in a group chat.
- In a texting chat the model can send photos: each one shows as a placeholder you develop with one or more image models, picking the best if you compared several.

### Fixed

- Opening a canvas after the model updated it could show the previous version until the page was reloaded.

## v0.49.1

### Added

- Code blocks in replies have a copy button, so a raw version of something can be copied without selecting it by hand.

### Changed

- A schedule's model is now chosen with the same searchable, per-provider picker as the chat box, instead of one long dropdown.

### Fixed

- Over plain http on a local address (e.g. `http://192.168.x.x`), toasts, attachments and sending a message no longer fail with "crypto.randomUUID is not a function".
- An instance served over plain http without a proxy no longer refuses every change with a 403. Set `EXTERNAL_BASE_URL` to the exact address browsers use; `ORIGIN` is no longer needed (it stopped being read in v0.45.0).

## v0.49.0

### Added

- **Scheduled tasks** (Settings → Scheduled tasks): prompts that run on their own
  — daily, on chosen weekdays, or every few hours — each as a new conversation,
  with a notification when a run finishes, needs your approval, or fails. Each
  schedule decides which MCP tools its runs may use unasked, must ask about, or
  never see; runs wait behind people chatting. Operators can tune or turn it off
  with `[scheduled_tasks]`.

### Security

- Turning off a feature for a conversation (web access, an MCP server — or a
  Private chat, which turns them off for you) now also stops the model calling
  its tools by name. Before, a tool it had seen used earlier in the chat could
  still run.

## v0.48.1

### Added

- Model stats: a softer **Mixed reception** flag for models whose outputs are
  deleted (or replies retried) noticeably often, short of **Often deleted** /
  **Often retried**.

### Fixed

- Swiping through images in the lightbox on iOS no longer lands on a black
  slide while the next image loads: the images either side now load ahead.
- Swiping during a fan-out discard in the lightbox can no longer leave it
  stuck on a deleted image with swiping disabled until it's reopened.

## v0.48.0

### Changed

- The lightbox loads a copy of each image sized to your screen instead of the
  full original, so swiping through results on a phone is much faster on mobile
  data. Download and Share still give the original.
- Streaming replies are compressed and batched, using much less mobile data;
  `COMPRESS_STREAMS=0` turns the compression off.
- Pages and API data are now compressed by GlyphStream by default; set
  `COMPRESS_DYNAMIC=0` to leave it to your proxy.
- Less mobile data for auto-attached image previews, code-interpreter charts,
  the model list, and multi-model comparisons waiting on results.

### Fixed

- Uploaded photos and older generated images no longer make a conversation jump
  as they load: the thread reserves each image's space from its real size.

## v0.47.1

### Changed

- Flicking through the lightbox now updates the favorite star while the image is
  still sliding in, instead of once it stops.

### Fixed

- A compare grid cell still generating shows its Favorite button, and after
  switching away and back its Regenerate button, disabled like the others
  instead of leaving a gap where they go.

## v0.47.0

### Added

- Gallery search results can be sorted newest-first as well as by relevance.
- Images in a multi-model compare grid can be starred right from the grid.

### Changed

- The image viewer's actions now sit on one row, with shorter labels on phones, so swiping between images no longer makes the view jump in height. Regenerating an enhanced image offers the original or the enhanced prompt from one menu.
- Swiping through a fresh compare grid in the image viewer now offers the grid's own actions as one row of larger buttons — star, regenerate another variation, the avatar pick, and delete — with star and delete at opposite ends instead of side by side in the corner.

### Fixed

- Gallery search results that match equally well now come newest-first instead of in arbitrary order.

- Restoring an item from the Recently deleted viewer could close the viewer instead of moving on to the next item.

## v0.46.1

### Fixed

- Models that meant to react often typed the emoji at the top of their reply
  instead, so no reaction appeared. They now add it as a reaction.
- A shared GPU is now freed before the first job after Glyphstream starts and
  after a paused queue is resumed, so a model left loaded through a restart, or
  loaded from outside Glyphstream during a pause, no longer crashes it (with
  `release = "llama-cpp-router"` on a `resource_group` member).

## v0.46.0

### Added

- Settings → Model stats (admins): how much each model is used and how its
  output is received (retries, favorites, deletions, comparison picks), grouped
  by endpoint with unused models folded away, to help decide which models to
  keep. Mark your own hardware with `local = true` on an endpoint to list it
  first. See `docs/models.md`.

### Changed

- Settings → Endpoints collapses each endpoint's queued work behind its count,
  so a long queue no longer makes the page a long scroll. Click to expand.

### Fixed

- A quick swipe in the lightbox no longer overshoots onto the image after the
  next one and slides back; it stops on the next image.
- A comparison down to a single column reads "Comparing 1 variation" (or
  "1 model") instead of "1 variations".

## v0.45.4

### Added

- The Docker image can run under a uid other than 1000 (compose
  `user: "10001:1000"`), so a host account that is uid 1000 can't signal the
  server by accident. See `docs/deployment.md`.

### Fixed

- Stopping the server while image or video generations are queued no longer
  leaves it running but unreachable. The queue now waits for the next start, and
  the process exits once whatever is already generating finishes, or a minute
  after its connections have closed if that takes longer.
- Gallery captions no longer show the top of a third line below the "…".

## v0.45.3

### Fixed

- Permanently deleting an image while its thumbnail or resized copy was still
  being generated could leave that copy on disk with nothing pointing at it.
- A quick swipe in the lightbox could stop partway onto the following image
  instead of landing on the next one.

## v0.45.2

### Fixed

- Swiping through the lightbox now switches the model, prompt and favorite star
  partway through the swipe instead of after it lands, and the image no longer
  resizes as prompts of different lengths come and go. Tapping the star or
  delete just after a swipe could act on the image you'd swiped away from.
- Closing a chat's image preview while it was still loading the next image no
  longer reopens it a moment later.

## v0.45.1

### Changed

- `LOG_LEVEL` now applies to every server log line, so `warn` or `error`
  quiets the routine ones; it used to only switch debug output on.
- When an action fails, the error now says why (the server's own reason) in
  more places, rather than just "Server returned 500".
- Gallery thumbnails and video posters are WebP, about a fifth smaller than the
  JPEGs they replace, and a transparent image's thumbnail keeps its
  transparency. Existing thumbnails convert as they're viewed; nothing needs
  doing on upgrade.

### Fixed

- An avatar draw accepted after you'd switched chats no longer closes the
  avatar dialog you had opened in the new one.

## v0.45.0

### Breaking

- **The Docker image runs as uid 1000, not root.** Before starting it on an
  existing install, give uid 1000 everything the old container wrote — `./data`,
  plus any separate `MEDIA_DIR` / `DERIVED_DIR` mount, which on NFS means
  changing ownership on the server ([details](docs/deployment.md)). The server
  logs which directory it can't write.
- **The server refuses to start when `AUTH_SECRET` is missing or shorter than
  32 characters** (and `MCP_SECRET_KEY`, when set), naming the problem. If you
  have to replace a short `AUTH_SECRET` and haven't set `MCP_SECRET_KEY`, users
  re-enter their per-user MCP tokens, which were encrypted with the old one.

### Added

- iPhone photos in HEIC format can be attached. They're converted to JPEG on
  upload, so they show in every browser and reach vision models as an image
  they can read. They used to upload but show as a broken image. Outside the
  Docker image this needs ffmpeg 7.1 or newer on `PATH`; without it, HEIC
  uploads are refused.
- An optional cap on how many generations one non-admin user can have queued
  (`[limits] max_queued_generations_per_user`). Off by default; admins are
  never capped.

### Security

- Python in the code interpreter is now held to a memory ceiling (1 GB per
  interpreter by default, `python_memory_mb` under `[code_interpreter]`). A
  script that asks for more gets Python's `MemoryError` instead of taking memory
  the server and your models need. The old `worker_memory_mb` setting never
  bounded Python itself.
- Text fields now have generous size limits (2 million characters for a
  message, 200,000 for a system prompt or custom instructions, and so on), so
  one account can't store multi-megabyte values that are re-sent to the model
  on every turn. Nothing typed or pasted in normal use comes near them.
- Images over 100 megapixels are no longer decoded for thumbnails or for
  sending to vision models. A small crafted file could otherwise claim a size
  that took around a gigabyte of memory to open. Ordinary photos and panoramas
  are well under the limit.
- The Python code interpreter now runs as a separate, locked-down process. Code
  it runs can no longer see the server's environment variables or files,
  start other programs, or open network connections of its own; its web
  requests go through the server's network policy as before.
- On a server reached over plain http (by IP address or LAN name rather than
  `localhost`), sign-in cookies are now actually cleared when they should be.
  Signing out left the dead session cookie behind, and the one-time cookies
  used during passkey and GitHub/Google/OIDC sign-in outlived the step that
  used them.
- An image URL returned by a model server is now checked by where it actually
  points. A URL starting with `//` or an upper-case `HTTP://` used to skip the
  check, so a misbehaving server could make Glyphstream fetch an internal
  address with the endpoint's API key attached.
- Web pages read by the model, Python's web requests and media URLs from a
  model server can no longer be steered to an internal address by a domain
  whose DNS answer changes between the safety check and the connection.
- The same internal-address check now recognises IPv6 addresses that wrap an
  IPv4 address (IPv4-mapped, NAT64 and 6to4). A domain pointing at, say,
  `64:ff9b::a9fe:a9fe` could reach the cloud metadata service on a NAT64
  network.
- When a model server can't be reached, only admins now see the error's
  detail, which can include the server's internal address. Everyone else sees
  that the server couldn't be reached, as they already did for a broken
  config file.

### Changed

- Long conversations open much faster. A chat loads its newest ~40 messages and
  fetches older ones as you scroll up, instead of the whole thread at once (a
  200-turn thread was an 8 MB page). Search results and links to an older
  message load back to it.
- Images in a chat load as a display-sized copy (at most 1280 px, WebP, keeping
  transparency) instead of the full original: a 10 MB image arrives as about
  200 KB. Opening an image still shows the original.
- Dragging a document (PDF, CSV, spreadsheet, text) onto the message box now
  attaches it, the same as choosing it with the attach button. Only images used
  to be accepted by drag-and-drop.
- A tool result over a million characters (a Python script printing in a
  loop, an MCP server dumping a huge response) is kept in the conversation as
  its beginning and end, with the middle dropped and marked.
- The server uses about 50 MB less memory. Code highlighting now loads each
  language the first time a reply uses it, instead of all of them at startup.
- Thumbnails and video posters are made as soon as an image or video is
  generated, so the gallery and finished videos show them without a wait on
  first view.
- Newly generated images hold their space in the chat while they load, so a
  long thread no longer jumps as images appear. The small source-image chip in
  a comparison column loads a thumbnail instead of the full image.
- Chats with generated images load faster, and the database grows less, on
  image servers that return pictures inline (`b64_json`). Each image was being
  stored twice and read back on every load.

### Fixed

- A message no longer goes out without an attachment that failed to upload.
  Send stays disabled, saying why, until you remove the failed attachment.
- A file attachment of exactly the 25 MB maximum now uploads. The Docker
  image's request size limit left no room for the upload's own framing, so a
  file at the cap was refused with a confusing "must be multipart" error. An
  upload over a server's limit now says so. If you set `BODY_SIZE_LIMIT`
  yourself, `.env.example` has the new value.
- The gallery shows a renamed or deleted chat's images under their new
  grouping right away, rather than up to half a minute later.
- Pressing Enter while the "Context could not be compacted" prompt is open no
  longer retries the compaction and opens a second prompt behind the first.
- Pressing Escape in the image viewer's "Set as avatar" menu now closes just
  the menu. It used to close the image viewer as well.
- Switching light/dark mode or theme no longer occasionally flips back a
  moment later, when the app refreshed in the background at the same time.
- An Open WebUI chat whose last-viewed reply had been deleted now imports with
  its messages showing, instead of as an empty conversation.
- Finishing first-run setup in two tabs at once no longer shows an error page
  in the second. It goes to sign-in, since the first tab already created the
  admin account.
- Memories and image prompts are now indexed for search on embedding servers
  that return vectors without an `index` field. Before, nothing was ever
  indexed on those servers, and no error explained why.
- Opening an invite link in a browser whose session is app-locked now asks you
  to unlock, instead of offering to create a new account over it.
- Python code that contains a line of three backticks now shows in full in
  its tool block. The code used to stop at that line, with the rest shown as
  formatted text.
- Switching conversations from the sidebar now shows the new conversation's
  feature toggles (web access, personalization, …). It kept showing the
  previous conversation's, and changing one saved that list onto the new
  conversation.
- An image preview left open when search (or a notification) took you to
  another conversation now closes instead of staying over the new one.
- "New chat from this prompt" on a comparison you just sent now brings all of
  its models along. It only did after reloading the page.
- Picking a winner in a model comparison (or pressing Done) and then quickly
  opening another conversation no longer shows the comparison, its error, or
  the picked model in the conversation you opened.
- The gallery loads its contents once when opened, instead of twice.
- An image or video generation that failed before reaching the model server
  (for example, its source image could not be read) now leaves an error in the
  conversation. It used to disappear, most visibly from comparison grids.
- A file attached at the moment the background cleanup removed it as
  abandoned could leave its conversation unable to send. Cleanup now claims a
  file before deleting it, so the attach is refused instead.
- Photos taken in portrait on a phone now get upright thumbnails, and are sent
  to vision models upright. (Thumbnails already made before this change keep
  their old orientation.)
- An image attached just before sending is either sent or held until it is
  ready; it no longer goes missing from that message and then turns up
  attached to the next one.
- After switching away from a conversation while it was replying, coming back
  to the tab no longer re-downloads the whole conversation every time, only
  the first time.
- When approving a tool call failed, the page no longer retries the approval
  on its own in a tight loop (hundreds of requests a second). The error shows
  and the buttons wait for you, as they do after you press Stop.
- Picking a search result in another conversation now scrolls to and
  highlights the matching message, as it already did when opening the app from
  a link.
- Stopping a reply while the Python interpreter was still preparing could
  leave that conversation's interpreter stuck until the server restarted, and
  enough of them would stop new interpreters from starting.
- A Python interpreter that crashed while starting up now fails the call right
  away instead of leaving it waiting for the full tool timeout.
- An image or video generation whose request to the model server timed out
  now shows the error and keeps it in the conversation. It used to end as if
  you had pressed Stop, leaving nothing behind (and, for prompt enhancement,
  cancelling the generation instead of falling back to your original prompt).
- When the model server stalls or drops the connection part-way through a
  reply, the part you already saw is now kept, with the error shown under it.
  It used to be thrown away and replaced by two error messages.
- When the model server reports an error part-way through a streamed reply,
  that error is now shown. The reply used to end silently, sometimes as an
  empty message.
- Model servers that number streamed tool calls loosely (reusing an index, or
  leaving it out) no longer have separate tool calls merged into one or
  dropped.
- Approving a tool call from two tabs at once, or a request that repeated the
  approval, no longer runs the tool twice.
- Approving a tool call from an MCP server you connected with your own token
  works after the server has restarted. It used to fail as an unknown tool and
  the approval was lost.
- An MCP server that connects but then fails to list its tools no longer
  leaves a stray process (or open connection) behind on every retry.
- Compacting a conversation while a message is sent to it from another tab or
  device no longer hides that message. The compaction now stops and asks you
  to try again.
- Stopping a retry before it produced anything (or a retry that failed before
  starting) no longer hides the reply you were retrying. It used to vanish from
  the thread, and the next message was attached in the wrong place.
- Deleting the reply you are viewing, when there are several, now moves you to
  the newest remaining one (as switching to that message would), not the
  oldest.
- Deleting a long conversation, or discarding branches of a comparison, no
  longer stalls the server for seconds when there are many conversations
  (3.8 s down to 24 ms for a 1,500-message thread among 40,000 conversations).

## v0.44.1

### Fixed

- **Refresh** on the "A new version is available" banner now always reloads
  onto the new version. In a session where the app was first opened before it
  had finished installing offline support, it used to dismiss the banner and
  leave the old version running.

## v0.44.0

### Added

- **Recently deleted** in the gallery's toolbar. Images and videos
  you delete — from the gallery, by deleting a branch or a multi-model cell, or
  along with a conversation — stay there for 30 days before they're gone for
  good, and can be viewed full size, restored to the gallery, or deleted forever.

### Fixed

- The sidebar's conversation list now scrolls to show the conversation you have
  open, instead of starting at the top after unlocking the app or reopening it.

## v0.43.0

### Changed

- On phones, a **New chat** button now sits at the top right of every
  conversation, so starting a new chat no longer means opening the menu first.
  Tapping the GlyphStream title does the same, as it already did on desktop.
- In-app notifications now appear at the top of the screen instead of the bottom,
  so they no longer cover the message box while you're typing. On touch screens,
  swipe one up to dismiss it.

### Fixed

- The help text for **In-app toast for other threads** now says what turning it
  off does: you get a system notification instead of an in-app one.

## v0.42.0

### Added

- Admins can pause an endpoint's queue from **Settings → Endpoints**: the current
  generation finishes, queued ones wait (shown as _Paused_) instead of failing
  against a backend that's restarting, and the pause survives a GlyphStream restart.
- Queued and in-progress image and video generations survive a GlyphStream
  restart: they go back in line in their original order when it comes back up,
  and a video still rendering on the bridge is picked up where it left off.

### Fixed

- Switching conversations opens the new one at its latest message, rather than at
  wherever the previous one was scrolled to — or, when it has an open comparison
  grid, at the top of the grid.
- Typing in the gallery search box no longer loses characters when a search finishes mid-word.

## v0.41.2

### Changed

- On phones, the gallery's Favorites filter is a star button in the toolbar next to
  search, instead of being tucked inside the filter panel. At every size it now
  matches the other toolbar buttons until turned on, when its star fills in.

### Fixed

- On iPhone, opening search for the first time after launching the app focuses the
  search box and raises the keyboard, and tapping into the box in portrait no longer
  zooms the page.
- Tapping a completion notification while app lock is engaged opens that conversation
  once you unlock, instead of the home screen.

## v0.41.1

### Fixed

- An avatar comparison reopened after a reload (or after iOS closed the app in the
  background) keeps its Regenerate buttons, re-rolling each portrait from the prompt
  that drew it.

## v0.41.0

### Added

- App lock: an optional setting in Settings → Security that asks for your
  passkey (Face ID on an iPhone) when you come back to the installed app after
  it has been away for 1, 5, 15 or 60 minutes. Turning it on asks your other
  signed-in devices for your passkey once; while it's on, signing in with a
  linked account also asks for it, and notifications don't show message
  previews.

### Fixed

- Reactions now actually happen. The model almost never reacted on its own; it
  now does in warm or playful conversation, and still stays out of technical work.
- A reaction from a reasoning model no longer leaves a second, empty-looking
  Reasoning toggle above the reply.

## v0.40.2

### Changed

- The Docker image is about 50 MB smaller unpacked, and about 13 MB smaller to
  pull. Nothing it runs has changed; `npx` is still there for stdio MCP servers.

### Fixed

- The code interpreter (`run_python`) works again in the Docker image. Since
  v0.31.0 every call failed before running any Python, because the image
  couldn't find the interpreter's worker.

## v0.40.1

### Added

- The debug panel reports whether iOS found a colour to paint the status bar
  with when the app launched, and which element it read it from.

### Fixed

- On iPhone, the installed app's status bar on iOS 26 and 27 is opaque from the
  moment it cold-launches. It used to come up translucent, with the blur
  reaching down far enough to smear the app's own title row, and only snap
  opaque once the sidebar had been opened. Unchanged for now on iPad, and on
  iPhone held in landscape.

## v0.40.0

### Added

- The composer follows an aspect ratio named in the prompt itself, so asking for
  a wide banner sets the shape without touching the picker.
- The debug panel reports viewport units and safe-area insets.

### Fixed

- The send button is no longer pushed out of the composer on narrow phones. The
  aspect-ratio glyph collapses to make room instead, keeping the model name
  readable.
- The installed app fills the viewport again on iOS 27, and its status bar takes
  the colour of the surface behind it rather than blurring over it.

## v0.39.0

### Added

- **Aspect ratios for image and video generation.** Pick a shape in the
  composer, including a Default that defers to whatever each model prefers. The
  choice follows a conversation across fan-out branches and edit resends, and
  every generation records the shape it was rendered at.
- **Favorites.** Star a picture from the lightbox and filter the gallery down to
  what you have starred. Also exposed over the media API.
- Delete a single fan-out variation from the lightbox and move straight to the
  next one. It stays deleted across an app resume.

### Fixed

- Regenerating an image uses the model that produced it rather than the current
  default.
- The lightbox metadata line names the endpoint an image came from.
- A fan-out branch that has not reached the gate yet shows "Starting…" instead
  of appearing stalled.
- After deleting a batch from the lightbox, it lands on the image its slot
  actually shows.
- Memory recall breaks ties by insertion order, so the same query returns the
  same results instead of reshuffling.
- Deleting a user now stops their in-flight generations and unlinks their media
  files.
- A generation whose conversation was deleted mid-stream stops quietly instead
  of erroring.
- Repeated tool-approval resumes no longer accumulate duplicate tool entries.
- The skills and snippets buttons in settings use the correct accent colour.

## v0.38.3

### Fixed

- A duplicate-key conflict is recognised by SQLite's error code rather than by
  matching its error text, so it keeps being handled correctly when that text
  changes.

## v0.38.2

### Added

- **Video thumbnails in the gallery**, so a video is no longer a blank tile.
  AV1 is decoded through libdav1d, which ffmpeg's built-in decoder cannot
  handle.
- New videos are stored with their index at the front, so playback starts
  immediately instead of after the whole file has downloaded. A one-shot script
  backfills videos stored before this.

### Fixed

- A video in the lightbox is laid out at its own size rather than at the
  poster's 512px.
- A recovered turn no longer flashes back to "Queued" as it finishes.
- Time spent queued is no longer counted as generation time.

## v0.38.1

### Fixed

- Reasoning markup no longer leaks into conversation titles or enhanced
  prompts, including when a model emits a closing tag without an opening one.

## v0.38.0

### Added

- The prompt enhancer leaves a prompt alone when it is already written in the
  form the model wants, such as a comma-separated booru tag list, instead of
  rewriting it into prose.
- Work waiting on an earlier step is shown as blocked before it reaches the
  queue, rather than appearing to be doing nothing.
- Derived assets (thumbnails, remuxes) can be stored outside `MEDIA_DIR`, via
  `DERIVED_DIR`.

### Fixed

- A notification marked private is no longer headed with the app name.
- Existence checks no longer block the media read paths.

## v0.37.1

### Fixed

- A resume that iOS delivers as `pageshow` counts as the app being looked at,
  so it no longer sends a notification for something already on screen.
- The reaction tool's instructions no longer imply that reacting costs the
  reply.

## v0.37.0

### Added

- **Reactions.** The model can tapback a message, drawn on the user's own
  bubble, without spending a round-trip on it.
- **Per-user feature toggles**, so each account gets its own defaults for
  optional features.
- **An admin endpoint health and activity view**, showing each endpoint's state
  and what is occupying its concurrency slots, with per-endpoint rechecks that
  don't freeze the others.
- A queued conversation is drawn differently from one actively generating.

### Fixed

- Tapping a notification that cold-launches the installed app now opens the
  right conversation. Notifications also carry a neutral title for cached
  service workers instead of none.
- A toast's description is rendered rather than silently dropped.
- Tool answers are matched to calls within their own turn instead of against a
  global set, so a branch no longer sends tool calls it never answered — which
  upstream rejected as a malformed payload.
- Compaction repairs orphaned tool calls in its own summary payload too.

## v0.36.2

### Fixed

- The preferences page verifies a push subscription after creating it instead
  of assuming it worked, and says so when a device is not actually subscribed
  although the preference reads as on.

## v0.36.1

### Fixed

- A recovered fan-out grid comes back in its original order rather than in
  completion order, and the lightbox swipes through it in the same order the
  grid shows.

## v0.36.0

### Added

- An avatar can be drawn by several models at once and the face picked from the
  results.

## v0.35.6

### Fixed

- URL-driven notices and verification links are cleared through the router, so
  the page follows them properly instead of shallow-routing around them.
- The mobile drawer closes on navigation rather than on any state change, and a
  background refresh no longer reads as one.

## v0.35.5

### Changed

- The database is memory-mapped in full, and the debug panel reports the memory
  the host actually took.

## v0.35.4

### Changed

- The model catalogue is fetched on demand rather than shipped in the
  first-paint payload, which makes the app start faster. While it is arriving
  the picker says "loading" instead of "no matches".

### Fixed

- A generated portrait is applied server-side, so a phone that locks mid-draw
  no longer loses it.

## v0.35.3

### Changed

- Layout data only needed after the first interaction is kept off the initial
  paint.

## v0.35.2

### Added

- The debug panel times database work and names the worker actually handling a
  request.

## v0.35.1

### Added

- The client bundle is served from Cache Storage, cache-first, so a repeat
  launch does not wait on the network.
- The debug panel reports resident memory.

### Fixed

- The avatar menu's buttons are centred like every other button.

## v0.35.0

### Added

- **Conversation and preset avatars.** Ask the model to describe an avatar for
  a conversation and generate a portrait from it, re-roll it as a comparable
  sibling, or set any gallery image as a preset's avatar. Presets can also have
  an avatar uploaded and managed from settings, and it appears beside the name
  in the bubble. The avatar itself is the control in the header, generation runs
  in the background, and a per-conversation avatar overrides the preset's.
- The bubble avatar is larger and opens in the lightbox.
- Display-only images, which are rendered in the conversation but never sent
  upstream.
- Endpoints that share a GPU now share one queue, and a shared GPU is freed
  before being handed to another endpoint. A generation waiting on that handover
  says so instead of appearing stuck.
- The debug panel reports how long the server sat idle before a request, the
  longest event-loop stall during it, and whether iOS had a launch image for the
  device.

### Fixed

- The chat route no longer overflows nginx's header buffer; the `Link` header is
  trimmed to fit rather than dropped.
- A failed GPU handover reports what it actually did.
- Deleting a conversation counts its avatar in the media it offers to remove.

## v0.34.6

### Added

- The debug panel breaks server-side rendering down by phase and reports server
  uptime.

### Changed

- MCP boot handshakes no longer sit on the first render's critical path.

### Fixed

- The app no longer offers to refresh onto the build already on screen.

## v0.34.5

### Added

- A stats-for-nerds debug panel, behind the version number in the sidebar.

### Fixed

- iOS shows a real launch image instead of about five seconds of white.
- The update prompt fires again after a deploy.
- Browser chrome is tinted on the sign-in pages too.

## v0.34.4

### Added

- The installed app badges its icon for unread replies, and clears the
  notification tray when you visit.

## v0.34.3

### Fixed

- Controls that appear on hover are reachable on touch devices.
- A failed fan-out branch becomes a real column that can be discarded, rather
  than a dead slot.
- Flipping the OS colour scheme no longer overwrites an explicit theme choice.

## v0.34.2

### Fixed

- A tool-approval resume that fails is surfaced instead of being swallowed.
- The two GitHub profile fetches during sign-in are bounded by a timeout.
- The last hard-coded palette colours moved onto theme tokens, so they follow
  the selected theme.

## v0.34.1

### Fixed

- A comment in the page template was swallowing SvelteKit's head output.

## v0.34.0

### Added

- **A signed-in device list**, with per-session revocation.
- The unauthenticated sign-in surface is rate limited.
- A `multimodal-script` prompt style, for MiniMax H3 video.
- Conversations still generating are dotted in the sidebar.

### Security

- Three cross-user access gaps closed, in MCP, model listing and push.
- First-run setup requires a token, minting one if none is configured, so a
  fresh deployment cannot be claimed by whoever reaches it first.
- Session cookies are re-issued on renewal and capped by an absolute lifetime,
  and the `Secure` flag is derived from `EXTERNAL_BASE_URL`.
- An invite issued by an admin who is no longer active is refused.
- Media responses carry their own CSP, and MIME types are compared by essence so
  a parameter cannot smuggle an SVG past the check.
- The code interpreter bounds file mounts per call and pool slots per user.

### Changed

- A broad performance pass: fewer round-trips after each turn, indexed gallery
  and search queries, windowed lightbox slides, memoised markdown highlighting,
  deduplicated thumbnail generation, compression moved off the event loop, and a
  smaller service-worker precache.

### Fixed

- The canvas auto-opens again on a fresh mount.
- Rapid arrow presses in the lightbox are no longer dropped.
- A tool-using turn stays recoverable while its tools are still running.
- MCP settings report live reachability, and the Retry button is hidden when the
  API would refuse it.

## v0.33.1

### Fixed

- An unrecognised video job status is surfaced rather than swallowed, and the
  provider's own status names no longer leak into fan-out labels.
- Entering a conversation scrolls to the bottom again. (The off-screen paint
  optimisation added in v0.32.2 broke it and has been reverted.)

## v0.33.0

### Added

- **Prompt snippets** — reusable prompt fragments inserted at the caret, managed
  from a settings library with modality quick-filters.

### Fixed

- The account name in the sidebar clears the iOS corner curve, and the mobile
  drawer stays open when the account menu opens.

## v0.32.3

### Fixed

- A truncated memory summary or overview is rejected rather than stored, so a
  cut-off fold cannot become the remembered version.

## v0.32.2

### Added

- The gallery grid is virtualised and pages in on demand, so a large library
  scrolls without loading all of it.

## v0.32.1

### Security

- Fetching media from another host re-validates every redirect hop, closing an
  SSRF path where a redirect could reach an address the first request could not.
- Upstream media trust and redirect credential-forwarding are decided by full
  origin rather than by hostname, so a different scheme or port is no longer
  treated as the same peer.

### Fixed

- A stalled upstream chat stream is aborted by an idle watchdog instead of
  hanging, and that watchdog no longer bounds time-to-first-token.
- A genuine chat-turn failure persists a durable error message rather than
  vanishing on reload.
- A fan-out branch that ends without a terminal event settles instead of
  spinning.
- A video job that hits a permanent polling error gives up instead of holding
  its slot for twenty minutes.
- Canvas edits no longer wipe the user message just sent.
- The non-streaming send path can be cancelled.
- Web-push sends have an HTTP timeout.
- The code-interpreter worker is terminated when Pyodide fails to start.
- Deleting a passkey counts real sign-in bindings, and only enabled providers
  count as a viable sign-in method, so the last one cannot be removed by
  accident.

## v0.32.0

### Added

- Model modality pills and image-required gating are driven by the capabilities
  the bridge reports, rather than guessed.

## v0.31.4

### Fixed

- The installed app on iOS no longer opens with a gap at the top on a cold
  launch, and the shell fills the screen in standalone mode.

## v0.31.3

### Fixed

- The installed app on iOS recovers its height if the viewport settles late
  after launch.

## v0.31.2

### Fixed

- The installed app on iOS sizes its shell from the real window height in
  standalone mode.

## v0.31.1

### Added

- A push notification is suppressed on other devices while you are watching the
  thread it belongs to.
- Sensitive topics are kept at a categorical level in memory overviews.

## v0.31.0

### Added

- **Document canvas.** A collaborative document the model can write into,
  several per conversation, each with a name, in a pane that slides in and out
  like the sidebar.
- Sending is blocked while offline, so a message is no longer lost when there is
  no connection.

### Fixed

- A preset's default feature toggles are filtered by its base model's kind.

## v0.30.3

### Added

- **A context breakdown**, itemising what is actually filling the context
  window.
- Auto-compaction is on by default.
- The model is told today's date, in your timezone.
- Oversized tool results are capped on the way upstream, and images are
  downscaled before being inlined into a request.

### Changed

- The built-in tool definitions are about 525 tokens smaller per request.

### Fixed

- The context breakdown was never reporting the upstream's own token count.
- The mobile sidebar drawer slides instead of popping.
- A zero-scoring keyword ranking no longer drowns out the semantic half of
  retrieval.
- The timezone preference is persisted.
- An empty model response during a memory pass fails that pass instead of
  erasing the conversation-topics map.

## v0.30.2

### Added

- The conversation-topics map has a configurable size, defaulting to 2500.

### Fixed

- Memory summaries are no longer cut mid-sentence, and an over-window rejection
  is recovered from rather than dropped.
- The private-chat toggle label no longer reflows when switched.

## v0.30.1

### Fixed

- Workers are drained on shutdown, so a restart stops cleanly instead of being
  killed.
- A video job is cancelled upstream when its polling budget expires.
- A conversation whose media has been hard-deleted shows `[Image deleted]`
  instead of failing with a server error.
- The code interpreter honours `call_timeout_seconds` beyond the 120s default,
  and a worker is no longer evicted mid-call.
- Parallel tool calls all stay on the branch.
- The tool approval path gets the same timeout as the direct one.
- Video uploads stream to disk instead of being buffered whole.
- One unprocessable conversation no longer wedges the whole memory sweep.
- The sidebar list is capped at 150 recent conversations.

## v0.30.0

### Added

- Start a new chat from an existing prompt.

## v0.29.0

### Added

- **Private chat.** An incognito mode with its own toggle, tint, badge and
  sidebar marker, a private greeting, and a control in the mobile top bar.
  Private conversations are sealed at request time and excluded from memory,
  search and title generation.
- **Conversation search for the model**, via a `search_conversations` tool, with
  a per-conversation summary pass indexed into it and a bounded topic map
  included in the prompt for orientation.

### Fixed

- Notifications for a deleted conversation are retracted.

## v0.28.3

### Fixed

- The new-chat aura no longer produces a scaling artefact in the installed iOS
  app.

## v0.28.2

### Added

- Memories can hold richer prose rather than only atomic facts, and memories
  retired by consolidation can be recovered from the UI.
- The conversation list refreshes when the app resumes.

### Fixed

- Regenerating inside a fan-out is folded into the aggregate completion
  notification rather than notifying separately.

## v0.28.1

### Added

- On mobile the new-chat composer is anchored to the bottom, with a soft accent
  aura behind it.

### Fixed

- Media-column controls in a fan-out are pinned to the bottom of the card.

## v0.28.0

### Added

- Prompt enhancement for video models.
- Feature toggles that do not apply to a model's kind are hidden rather than
  shown inert.

## v0.27.2

### Fixed

- A lapsed push subscription is reconciled when the app loads, instead of
  silently staying dead.

## v0.27.1

### Changed

- A skill's `SKILL.md` body may be up to 64 KiB, raised from 16 KiB.
- Superseded skill activations are removed from the upstream payload.

## v0.27.0

### Added

- **Memory consolidation.** A background worker periodically merges and retires
  saved memories, configurable through `[memory_model]` with its own schedule
  window. The store gains a topic index, frequency and recency tiering, and
  soft-deletion so a consolidated memory can be brought back.

## v0.26.3

### Added

- The most recent compaction can be undone, from a toast or the divider it
  leaves behind.
- A compaction summary is budgeted against the window's free space.

### Fixed

- A blank summary from the model is reported instead of quietly sending the full
  context anyway.
- The scroll-to-bottom button has more clearance on mobile, and the compaction
  divider's label fits on narrow screens.

## v0.26.2

### Fixed

- A stack of prompts in the gallery is labelled with the original prompt rather
  than the leader's enhanced one.

## v0.26.1

### Fixed

- Feature toggles and the composer follow the compare set rather than only the
  base model, so the two can no longer disagree about which kind is active.

## v0.26.0

### Added

- **Prompt enhancement for image models**, optional and driven by a language
  model, with a `json` prompt style for models that want structured input. On
  regenerate you are offered the original prompt as well as the enhanced one.
- A compact, model-aware feature-toggles menu.

### Fixed

- Stopping during enhancement stops the generation instead of being swallowed.
- The "Enhancing prompt…" status appears and clears correctly.

## v0.25.1

### Added

- Composer drafts autosave, scoped to the session and wiped on sign-out along
  with all other session-scoped client state.

## v0.25.0

### Added

- **Conversation compaction**, manual or just-in-time, with the summary streamed
  as it is written. The context-window budget is shown above the composer, and
  a manual run is confirmed first and offered only when there is enough history
  to be worth it.

### Fixed

- Focusing gallery search on iOS no longer zooms the page or shifts the toolbar.

## v0.24.1

### Added

- The gallery toolbar is compact and responsive: on mobile the kind and model
  filters collapse into a popover and the header stays on one row.
- Purpose-built raster icons for push notifications and for the iOS install and
  splash screens.

### Fixed

- Sticky date headers sit flush to the top of the scroll area, below the
  timeline rail.

## v0.24.0

### Added

- **Gallery search**, keyword-ranked with FTS5 and fused with semantic search
  over prompts.
- Media can be filtered by the model that made it, grouped by date, and jumped
  through with a timeline rail.
- MCP servers can be marked `post_only`, skipping the server-to-client event
  stream.
- An inline notice when an enabled MCP server is unavailable.

### Fixed

- Per-user MCP connections no longer stall the chat send path.
- Clearing gallery search no longer crashes on duplicate date sections, and
  unrelated semantic matches are floored out.

## v0.23.2

### Fixed

- Gallery scroll position is captured before drilling into a stack, so returning
  lands where you left.

## v0.23.1

### Fixed

- Scroll position is restored when leaving a stack, and the per-turn picker
  shows a custom preset's name.

## v0.23.0

### Added

- **Google and generic OIDC sign-in**, alongside the existing providers.
- Related media is stacked into expandable cards in the gallery, and drilling
  into one always shows the complete conversation's worth.

## v0.22.1

### Fixed

- A finished media result in a fan-out can be discarded while a sibling is still
  generating, and a failed media branch recovers after a client disconnect
  rather than being stranded.

## v0.22.0

### Added

- Web search surfaces direct answers and infoboxes, supports freshness filters,
  and de-duplicates results.
- `fetch_url` returns section breadcrumbs for multi-hop reading, and selects
  relevant sections with a cross-encoder reranker.

## v0.21.0

### Added

- Memory recall is backed by embeddings rather than keyword matching alone.
- The composer can be prefilled from a `#q=` URL fragment.

### Fixed

- An unreadable config file degrades the embeddings setting to off instead of
  failing.

## v0.20.1

### Changed

- The deferred-tool hint lists the tool names available, and explains how to
  refine a search.

## v0.20.0

### Added

- **Deferred tool loading.** Tools are fetched on demand through `search_tools`
  instead of all being sent upstream, which keeps a large MCP surface from
  filling the context window.

## v0.19.0

### Added

- **Multi-user accounts.** An admin role, invites with a `/join` onboarding
  page, an admin UI, and conversation data scoped per user.
- Per-user MCP credentials, via `auth = "per_user"`. Servers a user has not
  configured are hidden from the composer's capability list.
- Saved multi-model sets in the model picker.

## v0.18.3

### Added

- The gallery loads on scroll instead of behind a "Load more" button.

### Changed

- SQLite is now Node's built-in `node:sqlite` rather than better-sqlite3, so the
  image needs no native build toolchain.

### Fixed

- The installed app checks for updates when brought to the foreground, not only
  on a cold start.
- A failed gallery delete no longer blocks further paging.

## v0.18.2

### Added

- Swipe and arrow-key navigation in the media lightbox.

### Changed

- The lightbox's "used in conversations" display is simpler.

## v0.18.1

### Changed

- Re-rolling an image or video adds a sibling rather than replacing the
  original, and runs per column so the rest of the grid keeps going.

## v0.18.0

### Added

- `fetch_url` selects relevant sections with hybrid retrieval rather than
  returning the whole page.

### Fixed

- Keyword search tokenises Unicode correctly.

## v0.17.0

### Added

- **Agent skills.** On-disk skill bundles with progressive disclosure, explicit
  activation through a `/skill-name` slash command, and the ability to run a
  skill's Python in the Pyodide sandbox. Activations are rendered as their own
  affordance rather than as a raw tool envelope.
- File attachments are surfaced to the upstream model.
- Generation speed in tokens per second, in the message info popover.
- More varied new-chat greetings, and motion for list reordering and branch
  switching.

### Fixed

- Selecting a branch no longer bumps its recency or scrolls a tall image out of
  view.

## v0.16.2

### Changed

- A multi-model fan-out sends one aggregate notification instead of one per
  branch, and its branches queue and start in the order they were selected.

## v0.16.1

### Added

- Streaming fan-out image branches, with a queued badge and a per-branch timer.

### Fixed

- A live fan-out survives a benign tab switch, and a recovered grid keeps its
  queued badge and timer, labelled by model rather than "Generating…".
- Regenerating inside a fan-out deletes the replaced sibling instead of leaking
  its media file.
- Concurrent fan-out branches are capped at 32 per conversation.

## v0.16.0

### Added

- **Multi-model fan-out.** Send one prompt to several models at once and compare
  the results, for text, images and video. Selection lives in the model picker,
  image results are laid out as a grid, and a fan-out survives a disconnect —
  including an iOS app suspend.
- **Split attachments**, which expand an attachment across the selected models
  as a cross-product, with each result column showing the input it used.
- A per-endpoint concurrency gate, with `max_concurrent` documented.

### Fixed

- The hidden scroll-to-bottom button no longer swallows clicks.

## v0.15.2

### Changed

- Saving media uses the system share sheet on touch devices, which works around
  the installed iOS app's inability to download, and saved files get a readable
  filename.

## v0.15.1

### Fixed

- Videos play inline on iOS instead of taking over the screen.

## v0.15.0

### Added

- **Passkey sign-in**, as a peer of GitHub OAuth rather than an add-on to it,
  with sign-in methods no longer tied to a GitHub identity.
- A `/setup` wizard, and management of linked OAuth accounts.

### Changed

- The account menu, search modal and lightbox are loaded on demand, so they no
  longer weigh on first paint.

## v0.14.1

### Fixed

- An MCP HTTP server that answers "Session not found" is reconnected
  automatically, with a manual retry button if that fails.

## v0.14.0

### Added

- Optional compression of dynamic responses, preferring zstd, then Brotli, then
  gzip.

## v0.13.0

### Added

- **A Python code interpreter**, running in a server-side Pyodide sandbox via a
  `run_python` tool, with files passed in and out and syntax-highlighted code
  rendered as it streams. Configured under `[code_interpreter]`.
- Non-image file attachments, end to end.
- Media produced by a tool appears as a preview inside the tool block.

### Security

- A Content-Security-Policy, plus `nosniff`, `Referrer-Policy` and
  `X-Frame-Options` on every response.
- SVG uploads are refused, since they can carry executable script, and
  non-audiovisual media is forced to download rather than render.
- State-mutating `/api/*` calls require a same-origin `Fetch-Site` or `Origin`.
- URLs returned by an upstream are checked against the SSRF policy, and push
  endpoints pointing at private or non-HTTP addresses are refused.
- Code-interpreter file round-trips are size-bounded and their filenames
  sanitised.

### Fixed

- Tool execution is capped by a wall-clock timeout, MCP's tool listing is bound
  by the per-server timeout, and the video status poll backs off to a 3s cap.

## v0.12.0

### Added

- **MCP support.** Servers configured in `config.toml`, their tools bridged into
  the existing registry, per-tool-call approval for untrusted tools with the
  prompt embedded inline in the conversation, and `/settings/mcp` and
  `/settings/permissions` pages for managing and pre-trusting them.
- **Per-user memory.**
- Per-custom-model default feature toggles.

### Fixed

- The composer and Stop button stay visible during an MCP approval and the
  resume that follows.

## v0.11.0

### Added

- Full-text search across conversations.
- Multi-select and bulk delete in the gallery.
- A Personalization toggle, with the persona re-derived at request time.

## v0.10.3

### Changed

- The user's message bubble carries the theme accent, and the sidebar reads as
  its own surface.

## v0.10.2

### Changed

- Glass opacity is chosen from the device's blur capability, probed via WebGL,
  so panels stay readable where the GPU cannot blur.

## v0.10.1

### Changed

- Glass panels are more opaque, so they remain readable without GPU blur.

## v0.10.0

### Added

- **Themes.** A Signature theme with frosted glass and motion, plus flat Claude
  and ChatGPT themes and a switcher, built on semantic design tokens.
- A light/dark/system colour-scheme override, with the installed app's theme
  colour following the active theme.

### Changed

- Preferences save automatically; the Save button is gone.

### Fixed

- The assistant bubble no longer re-fades when a stream finalises.

## v0.9.0

### Added

- **Web search and page fetching.** A `web_search` tool backed by SearxNG and a
  `fetch_url` tool with an SSRF guard, extracting article text with Readability,
  configured under `[search]`.
- **Per-conversation feature toggles**, enforced server-side, so a tool category
  can be turned off for one conversation.

## v0.8.0

### Added

- **Tool calling.** Native tool calls in the upstream request, parsed from the
  stream, executed and looped until the model stops asking, and rendered folded
  inline in the assistant bubble with a running badge.
- Reasoning segments are shown, and expand while streaming.

### Fixed

- The in-flight bubble survives a reload, adjacent assistant bubbles merge, and
  in-flight content is ordered chronologically.
- Retry traverses a multi-iteration tool chain back to the user message.

## v0.7.4

### Changed

- A new chat starts on your top favourite model.

## v0.7.3

### Fixed

- A long-running generation is recovered after iOS suspends the app.
- Tapping a favourite closes the mobile drawer.

## v0.7.2

### Added

- Sidebar favourites can be reordered by dragging.

## v0.7.1

### Changed

- The favourites list is height-capped and scrollable, with scroll-edge fades on
  it and on recents.

## v0.7.0

### Added

- **Model favourites**, pinned in the sidebar and given their own section in the
  picker.
- Conversation token usage is shown in the chat UI.

### Fixed

- The model list no longer hangs once a minute, and several quadratic renders
  were removed.
- Generated titles no longer read as cliffhangers.

## v0.6.2

### Added

- A confirmation dialog for deletes, replacing the browser's own.

### Changed

- The composer is focused on entering a conversation and on a new chat.

## v0.6.1

### Fixed

- Chat state no longer leaks between conversations when navigating.
- A push notification no longer fires for the thread being watched.
- The in-flight generation indicator is recovered after a suspension, the
  composer is released as soon as a response completes, and the sidebar title
  shows a spinner while it is being generated.

## v0.6.0

### Added

- **Push notifications** when a conversation finishes, configured under
  `[notifications]`, with a settings section for subscribing per device.
- Conversation titles are generated automatically by a task model, and can be
  renamed by hand.

### Fixed

- A generated title is no longer dropped when the task model takes more than
  five seconds.

## v0.5.1

### Fixed

- Editing a message branches the conversation again instead of silently
  appending.

## v0.5.0

### Added

- Start a new conversation straight from the gallery lightbox, with the full
  prompt stored on the media row so it can be regenerated.
- In-conversation images open in the same lightbox as the gallery.
- Deleting a conversation asks whether to delete its media, and archiving is
  confirmed with an undo toast.
- The gallery grid is served resized thumbnails.

### Fixed

- An in-flight generation is recovered after iOS suspends the app, and across a
  network handoff.
- Editing the conversation's first message branches properly.
- A stale auto-attachment is dropped when the active branch changes.

## v0.4.0

### Added

- **User preferences**, reached from the identity dropdown: three structured
  personalization fields in place of a single system-prompt box, your name used
  in greetings and message labels, Enter-key behaviour, and an option to hide
  the greeting.
- The app version is shown beside the sidebar title.

## v0.3.5

### Added

- A "delete branch" action, for clearing up alternative branches.

### Fixed

- The viewport anchors to the new sibling after a branch switch, and the old
  branch's tail is trimmed once an edit starts streaming.
- The chat view no longer scrolls sideways on mobile, the gallery lightbox
  respects iOS safe-area insets, and the mobile sidebar stays open while a
  conversation's overflow menu is.

## v0.3.4

### Fixed

- The model picker clears the iOS status bar, and sidebar links give continuous
  feedback from tap until the page renders.

## v0.3.3

### Added

- A prompt to refresh when a new version has been installed in the background.

### Fixed

- Image uploads are no longer rejected for size: the body limit is raised to
  25 MiB and client-side resizing retries until it reaches a workable size.

## v0.3.2

### Changed

- Image attachments are resized in the browser before upload.

## v0.3.1

### Fixed

- iOS Safari no longer zooms the viewport when an input is focused, and the
  mobile top bar and sidebar header respect safe-area insets.

## v0.3.0

### Added

- A per-turn model picker in the composer, with bridge models grouped by their
  upstream provider.
- The lightbox lists the conversations a piece of media appears in.

## v0.2.1

### Changed

- `PUBLIC_BASE_URL` is now `EXTERNAL_BASE_URL`.

### Fixed

- 4xx responses are no longer logged as errors.

## v0.2.0

### Added

- **Image attachments**, from the picker, drag-and-drop or paste, wired into
  vision chat, image-to-image edits and video input. The last generated image is
  attached automatically on an image-to-image follow-up.
- **Edit, retry and branch navigation** in the message action bar, with editing
  done inline on the bubble and `‹ N/M ›` arrows to move between branches.
- Conversation archiving, from the overflow menu.
- An importer for Open WebUI conversations, preserving their tree shape and
  reasoning blocks.

### Fixed

- Upstream error messages are shown to the user rather than swallowed.

## v0.1.0

First release: a self-hosted chat UI in front of OpenAI-compatible endpoints.

### Added

- Streaming chat across multiple configured endpoints, with an aggregated model
  list, per-provider reasoning normalisers, live markdown rendering and
  syntax-highlighted code.
- Tree-shaped conversations, so a conversation can branch.
- Image and video generation, with poll-based progress for video and an
  elapsed-time label in the in-flight bubble.
- A media gallery, with a purger for abandoned uploads.
- A Stop button, cancelling chat, image and video work.
- GitHub OAuth sign-in against a closed allowlist.
