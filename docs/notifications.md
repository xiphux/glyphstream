# Notifications

GlyphStream surfaces assistant-message completions in three ways,
depending on where the user actually is when the stream finishes:

| Where the user is                                             | What happens                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Looking at the thread itself, tab visible                     | Nothing extra — the SSE stream is already delivering the message in real time.           |
| In the app, tab visible, but on a different thread or page    | An in-app toast appears with the conversation title and an **Open** action.              |
| Tab not visible — switched apps, locked phone, browser closed | An OS-level notification arrives via Web Push, clickable to navigate back to the thread. |

This table is the per-device arbitration for a push that fires. The
server fires a push on every completion **unless another of your devices
is actively rendering that thread**, in which case it suppresses the push
to _all_ your devices (see [Cross-device suppression](#cross-device-suppression)) —
so the "different thread → toast" and "backgrounded → OS notification"
rows only apply when no other device is already showing the response.

The per-device decision lives in `src/lib/sw/arbiter.ts` (pure function,
unit-tested in `tests/unit/sw-arbiter.test.ts`) and is executed by
`src/service-worker.ts`; the cross-device decision lives on the server in
`src/lib/server/push/notify.ts`.

Each behavior is independently togglable in **Settings → Preferences →
Notifications**.

## The sidebar generating dot

Independently of any of the above, a conversation with a generation
running shows a small pulsing dot next to its title in the sidebar. It
needs no notification permission and no VAPID keys — it's plain UI, so
it works on a fresh install with pushes switched off entirely.

It exists for the case the table doesn't cover well: you kick off a
video, wander to another thread, and the one you left goes visually
inert. Navigating away doesn't cancel anything (the server finishes the
generation regardless of whether a client is still listening), so the
dot is the standing "yes, that's still cooking" marker until it
completes.

Scope, deliberately: the dot tracks generations **running server-side on
one of your own conversations**, and it clears when the generation
finishes — whether or not you ever go back and look. It is not an unread
badge. A durable "there's a response here you haven't seen" mark needs
read state on the conversation row and a way to sync "read" across your
devices; both are noted in `ROADMAP.md`.

On a reload the dot is restored from the server's in-flight registry, so
force-quitting the PWA mid-video and reopening it on another thread
still shows the mark. That registry is keyed by conversation, not by
device — so a fresh load also lights dots for generations you started on
a _different_ device. What no client can do is learn about one
**mid-session**: an already-open page only ever hears that generations
have finished (its poll never adds), so one started elsewhere after this
page loaded stays invisible until the next load. That gap is the missing
standing per-user channel, deferred in `ROADMAP.md`.

## The app icon badge

When an OS notification is raised, the installed app's home-screen icon
also gets the usual count bubble. It shows **how many threads are waiting
on you**, not how many messages: notifications are tagged per
conversation, so a thread that finishes twice before you look at it
replaces its own notification rather than stacking a second one.

The count is derived from the notification tray itself
(`getNotifications()`), not from a tally we keep. That means there's no
separate state to drift out of sync with the notifications you can
actually see, and nothing to persist — the tray belongs to the OS, so it
survives iOS reclaiming the app's process. Where the Badging API is
missing (Firefox, iOS before 16.4, or a browser tab that was never
installed to the home screen) everything else still works; there's just
no badge.

It clears **per conversation, when you open that conversation** — not
when you open the app. Launching GlyphStream to start an unrelated chat
leaves the badge alone, since the question it answers ("did that thing
finish?") hasn't been answered yet. Tapping the notification clears that
thread's share of the count as a side effect of taking you there.
Swiping a notification away without opening it also counts. Where the
browser fires a usable dismissal event, that lands immediately — but
support is uneven (WebKit especially), so the badge is also re-derived
whenever the app comes to the foreground, which is what covers the
platforms that stay silent.

Like the sidebar dot, this is not a durable unread mark — it tracks
notifications that were delivered to _this_ device, so clearing it on
your laptop doesn't clear it on your phone. Cross-device read state is
noted in `ROADMAP.md`.

Implementation: `src/lib/sw/badge.ts` (unit-tested in
`tests/unit/sw-badge.test.ts`), called from the service worker on push
and on notification tap, from the chat route on visit, and from the root
layout when the app returns to the foreground.

## Operator setup

The feature is **off by default** — a fresh GlyphStream install has no
VAPID keys, the settings switch is inert, and pushes simply don't fire.
To enable:

### 1. Generate a VAPID keypair

```sh
npx web-push generate-vapid-keys
```

This prints a `Public Key:` and `Private Key:`. Keep them — you'll need
both. **The public key is fine to keep in version control or expose to
clients; the private key is a secret.**

### 2. Configure `config.toml`

Add a `[notifications]` block:

```toml
[notifications]
vapid_public = "BPI...your-public-key..."
vapid_private_env = "VAPID_PRIVATE_KEY"
vapid_subject = "mailto:admin@example.com"
```

- `vapid_public`: paste the public key directly.
- `vapid_private_env`: the **name** of the env var holding the private
  key — never the key itself. This follows the same `*_env` convention
  used by `[[endpoints]].api_key_env`, so `config.toml` stays safe to
  commit even in private repos.
- `vapid_subject`: a `mailto:` URL push services may use to contact you
  if your pushes misbehave (rate-limit complaints, key rotation requests).
  An `https://` URL works too.

### 3. Set the private key in the host environment

```sh
# .env (or systemd unit, k8s secret, etc.)
VAPID_PRIVATE_KEY=your-private-key-here
```

Restart the Node process. On boot the server reads the config and
initializes `web-push`; the first push triggers VAPID signing.

### Verifying it's working

- Open `/api/push/config` while signed in — should return
  `{ "enabled": true, "vapidPublicKey": "..." }`.
- Open the **Settings → Preferences → Notifications** page — the master
  switch should be enabled (no inline hint).
- Toggle it on. The browser prompts for permission. Grant it. The
  switch persists across reloads.
- Send a message in one thread, navigate to a different page during
  generation. When the stream completes you should see a toast.
- Switch to another app (or lock your phone) before generation
  finishes. You should get an OS notification.

If you see `Push notifications are not configured on this server` in the
settings UI, either the `[notifications]` block is missing or the
private key env var is unset.

## iOS (iPhone / iPad)

iOS Safari has supported Web Push since **iOS 16.4**, but with a critical
constraint: **the PWA must be installed to the Home Screen**. A PWA running
in a normal Safari tab — even with permission granted — will never receive
push.

The flow:

1. Open GlyphStream in Safari (iOS 16.4+).
2. Tap the share sheet → **Add to Home Screen**.
3. Launch GlyphStream from the Home Screen (the icon, not the Safari tab).
4. Go to **Settings → Preferences → Notifications**.
5. Tap the **Enable notifications** switch. iOS prompts for permission.
6. Grant permission.

The settings UI detects when you're on iOS without a Home Screen install
and shows a hint instead of an inert switch.

Permission must be requested inside a user gesture (the tap on the
switch). That's why the master switch's handler — not page load —
calls `requestPermission()`.

## Privacy

Three independent toggles, all per-user:

- **Enable notifications** — master switch. Off by default; user must
  opt in.
- **Show message preview** — whether the notification body includes a
  text snippet from the assistant's reply. Off by default. When off,
  the server **omits the preview from the push payload entirely**, so
  the content never traverses the push service even encrypted. The
  notification body becomes simply "New message".
- **In-app toast for other threads** — whether a toast pops when a
  thread completes while you're in the app but on a different page.
  On by default. Turning this off doesn't affect OS notifications when
  the app is backgrounded.

The settings UI saves each toggle individually (no Save button), so
the trade-off between "side-effecting toggle that needs to be acted on
immediately" and "click Save to apply" is resolved cleanly: each
notification toggle is an immediate action.

## Multi-device

Subscriptions are keyed by the push service's `endpoint` URL — one row
per (user, device). Subscribing on a new device adds a new row;
subscribing on a device that's already subscribed updates the existing
row. Pushes fan out to every subscription a user has.

If a push service returns `404 Gone` or `410 Gone` for an endpoint
(the user revoked permission, uninstalled the PWA, cleared site data,
etc.), the notify pipeline auto-deletes that row so it doesn't keep
trying to send to a dead endpoint.

### Cross-device suppression

If you're **actively watching a conversation on one device** when the
reply lands, your **other** devices stay quiet — no phone buzz while you
watch the response finish on your desktop.

The per-device service worker already silences the device you're looking
at (its own window is visible on that thread), but it can only see its
own windows — it has no idea another device is showing the same thread.
So a chat window heartbeats to the server **while it is actively
rendering a generation** for that conversation — streaming its turn or a
fan-out, or polling a recovered in-flight one — and the notify pipeline
skips **all** pushes for a conversation any of your devices is currently
rendering. That device shows the message in place, so nothing is missed.

The key word is _rendering_, not merely _looking at_. Presence is only
reported by the tab that owns the live stream (the one you submitted
from, or one that recovered an in-flight generation). A tab merely parked
on a thread it didn't generate holds no stream — it would show stale
content until reloaded — so it deliberately does **not** suppress, and
the completion still reaches your other devices. The moment a rendering
window finishes, is backgrounded, switches threads, or closes, it stops
counting — so submitting on the desktop and then walking away (or locking
the screen) still delivers the notification to your phone.

Presence is in-memory and per-user: it writes nothing to the database,
never crosses between users, and evaporates on process restart (a restart
mid-generation simply falls back to firing the push).

**Known limitation:** a tab parked on a conversation it did not generate
does not update live when a _different_ device completes a response — it
shows stale content until you reload or re-open the thread. This is a
property of the streaming model (only the originating tab holds the SSE
stream), independent of notifications; the cross-device rule above is
careful not to suppress a notification such a tab can't act on.

## Troubleshooting

**The master switch is greyed out with no hint shown.**
You're either offline, or the call to `/api/push/config` failed. Reload.

**The master switch says "Push notifications are not configured on this server."**
The `[notifications]` block is missing from `config.toml`, or
`vapid_private_env` references an unset env var. Check the server logs
for `[push] notifications config invalid`.

**On iOS, the switch is greyed out and says "Install to your Home Screen first."**
iOS only delivers push to PWAs launched from the Home Screen. Add the app
to your Home Screen and launch it from there.

**Permission denied — switch greyed out with "blocked in browser settings."**
The user previously denied the permission. Most browsers don't let pages
re-prompt — the user must enable notifications for the site in browser
settings.

**Toast appears but no OS notification, even when switching apps.**
Check that the SW is actually registered: open DevTools → Application →
Service Workers (or the equivalent on Safari/iOS). Production-only by
default: the SW doesn't register in `pnpm dev`. To test the full path
locally, run `pnpm build && pnpm preview`.

**OS notification appears but tapping it doesn't navigate.**
The SW's `notificationclick` handler focuses an existing window if one
exists, else opens a new one at `/chat/{id}`. If the URL doesn't have a
GlyphStream window open, a new tab/PWA window should open. If neither
happens, check the SW console for errors.

## Developer reference

- **Config loader**: `loadNotificationsConfig()` in
  `src/lib/server/endpoints/config.ts`. Returns `null` when the block
  is absent so the rest of the app boots cleanly.
- **VAPID keys exposed to client**: `GET /api/push/config`. The client
  fetches this on demand rather than baking the key into the bundle.
- **Subscription endpoints**: `POST /api/push/subscribe` (upsert),
  `DELETE /api/push/subscribe` (remove). Both auth-gated.
- **Server-side fire**: `notifyConversationComplete()` in
  `src/lib/server/push/notify.ts`. Called from three places — the chat
  relay (`relay.ts:recordAndPersist`), the image path
  (`messages/+server.ts`), and the video relay (`video-relay.ts`).
- **Client-side fire arbiter**: `pickAction()` in
  `src/lib/sw/arbiter.ts`, exercised by the SW's `push` event handler.
- **Cross-device presence**: `src/lib/server/push/presence.ts` (in-memory
  registry, single-process — mirrors the in-flight registry) fed by
  `POST /api/presence`. The chat page publishes the conversation it is
  rendering (its `renderingGeneration` signal) to `src/lib/stream-presence.svelte.ts`;
  the root `+layout.svelte` heartbeats that (while visible) and
  `notifyConversationComplete()` skips the send when
  `isConversationBeingViewed()` is true.
- **Toast surface**: `src/lib/toast.svelte.ts` (singleton, used for
  the archive toast and the message-complete toast).
- **Sidebar generating dot**: `src/lib/generating-conversations.svelte.ts`
  (reactive id set). Marked by the chat page from the same
  `renderingGeneration` signal as presence — but with no unmount cleanup,
  so it survives navigating away; seeded at `(app)` layout mount from the
  layout load's `generatingIds` (`filterInFlight()` over the user's own
  conversation list); retired by the layout's poll of
  `GET /api/conversations?generating=1`, which is clear-only. E2E:
  `tests/e2e/generating-dot.spec.ts`.

## Future work (not shipped in this pass)

- **Completion sounds.** The roadmap pairs notifications with optional
  completion sounds. Sounds are out of scope for this pass — see the
  ROADMAP entry.
- **Per-modality preferences.** Currently the same toggles apply to
  text, image, and video. A future iteration could split them (e.g.
  "only sound for video, since they take longest").
- **Devices UI.** The `push_subscriptions.user_agent` column is
  populated but not surfaced anywhere; a "your devices" listing with
  per-device revoke would build on top of it.
