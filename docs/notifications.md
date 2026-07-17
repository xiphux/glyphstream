# Notifications

GlyphStream surfaces assistant-message completions in three ways,
depending on where the user actually is when the stream finishes:

| Where the user is                                             | What happens                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Looking at the thread itself, tab visible                     | Nothing extra — the SSE stream is already delivering the message in real time.           |
| In the app, tab visible, but on a different thread or page    | An in-app toast appears with the conversation title and an **Open** action.              |
| Tab not visible — switched apps, locked phone, browser closed | An OS-level notification arrives via Web Push, clickable to navigate back to the thread. |

The decision lives in `src/lib/sw/arbiter.ts` (pure function, unit-tested
in `tests/unit/sw-arbiter.test.ts`) and is executed by
`src/service-worker.ts`. The server unconditionally fires a push on every
completion; the SW arbitrates per-client based on visibility.

Each behavior is independently togglable in **Settings → Preferences →
Notifications**.

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
own windows — it has no idea another device is watching. So each open
chat window heartbeats "I'm viewing this conversation" to the server
while it's foregrounded, and the notify pipeline skips **all** pushes for
a conversation any of your devices is currently viewing. That viewer
already receives the message over its live stream, so nothing is missed.

The moment a window is backgrounded, switches threads, or closes, it
stops counting as "viewing" — so submitting on the desktop and then
walking away (or locking the screen) still delivers the notification to
your phone. Presence is in-memory and per-user; it writes nothing to the
database and never crosses between users.

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
  `POST /api/presence`. The root `+layout.svelte` heartbeats the current
  chat route + visibility; `notifyConversationComplete()` skips the send
  when `isConversationBeingViewed()` is true.
- **Toast surface**: `src/lib/toast.svelte.ts` (singleton, used for
  the archive toast and the message-complete toast).

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
