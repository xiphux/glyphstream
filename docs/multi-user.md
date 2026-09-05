# Multi-user & administration

GlyphStream is multi-user, sized for small-team / household scale (not SaaS).
The first account — created by the
[setup wizard](authentication.md#first-run-setup) — is the **admin**. Everyone
else joins by an admin-issued **invite**; there is no open registration.

## Roles

There are two roles, `admin` and `user`:

- **`admin`** — everything a user can do, plus the two **Administration** pages
  in the account menu: **Users** (manage accounts, issue invites) and
  **Endpoints** (read-only health + activity). The setup-wizard user is the
  admin, and an admin can grant the role to others by issuing an admin-role
  invite.
- **`user`** — a normal account; the Administration section of the menu isn't
  rendered, and both pages return 403.

Role gates **operator capability, not data**. Admins do **not** see other
users' conversations or media — every row is scoped by `user_id` and nothing
in the data layer keys off role. That holds for the Endpoints page too: it
reports what each backend is doing (model, kind of work, elapsed, queue depth)
and deliberately carries no conversation id, user id, or prompt.

## Inviting users

Account creation is invite-only after the first user. From **Settings → Users
→ Invite a user**:

1. Pick the **Role** (User or Admin). GlyphStream mints a single-use invite
   valid for **7 days**.
2. The **`/join/<token>` link is shown once** — copy it and send it to the
   person out of band. Only the token's hash is stored, so the link can't be
   re-displayed; if you lose it, revoke the invite and issue a new one.
3. The invitee opens the link and completes **GitHub OAuth or a passkey**
   registration. That creates their account, binds the login method, and
   consumes the invite — all in one atomic step.

Outstanding invites appear under **Pending invites** with their role and
expiry date; **Revoke** deletes one before it's redeemed. Redeemed invites
vanish from the list (they're deleted on use, so every row shown is still
pending).

Properties worth knowing:

- **Single-use.** Redemption deletes the invite, so a double-click or a
  forwarded-link race resolves to exactly one account — the loser sees an
  "already used" error, with no half-created user left behind.
- **Expiring.** A 7-day window from the UI (the API accepts a custom TTL up
  to 30 days). An expired or already-redeemed link lands on an "invalid or
  expired invite" page.
- **No extra OAuth setup.** The `/join` GitHub flow reuses login's callback
  URL — if GitHub OAuth already works for sign-in, invites work too. No new
  GitHub App or redirect URI to register.
- **Only redeemable while the issuer is an active admin.** Redemption checks
  the issuing admin's current state, so disabling an admin also makes every
  invite they issued stop working — including admin-role ones. Re-enabling
  them re-arms those invites. This matters when you disable a compromised
  admin: the outstanding links they created are revoked with the account,
  rather than staying live until they expire.

## Managing accounts

**Settings → Users** lists every account with its role, the date it was
created, and who invited it. Per row:

- **Disable / Enable** — disabling sets `users.disabled_at`, which invalidates
  every active session, refuses every login method on that user's next
  request, and (for an admin) makes any invite they issued unredeemable.
  Re-enabling restores all three. Nothing is deleted; this is the reversible
  "revoke access" lever.
- **Delete** — removes the account and cascades its data (conversations, media
  references, credentials). Irreversible.

Two guardrails are enforced by the API, not just hidden in the UI:

- You **can't disable or delete your own account** from the admin panel — that
  would be a mid-session self-lockout footgun.
- You **can't remove the last active admin.** Disabling or deleting the only
  admin is refused, so the instance is never stranded with nobody able to
  reach this panel.

## Endpoint health

**Settings → Endpoints** is a read-only diagnostic view of the backends in
[`config.toml`](configuration.md). It answers the questions the config file
can't:

- **Reachable / Degraded / Unreachable**, and how many models each endpoint
  advertises, split by kind. _Degraded_ means the last `/v1/models` probe
  failed but an earlier one succeeded — the model list on screen is stale, and
  generations may well still work. Reachability is whatever ordinary traffic
  last observed (the model list is cached for 60s); **Recheck** forces a probe
  now.
- **What each endpoint is generating right now**, with the model id and an
  elapsed timer. This covers _all_ work that holds an endpoint's concurrency
  slot, not just chat turns: prompt enhancement, auto-titling, compaction,
  memory summarization and dreaming all appear under their own labels. That's
  the point of the view — on a `max_concurrent = 1` box, a background sweep is
  indistinguishable from a hang unless something names it.
- **How deep the queue is.** Requests past the cap queue FIFO, so a handful of
  multi-model fan-outs against a single-GPU endpoint shows here as a line of
  waiting entries, each labelled with the model it will run.

Endpoints that share a **`resource_group`** are drawn as one unit, because
they share one gate: one capacity, one queue, and — while a handover is
freeing VRAM — one _"Freeing GPU memory…"_ banner. The member marked _model
presumed resident_ is the one that last held the group's slot, i.e. whose
model the next handover will try to unload. A group's cap is the **minimum**
`max_concurrent` across its members, which is why an endpoint configured for 4
can sit at a limit of 1.

The page polls every three seconds while it's open and pauses while the tab is
in the background. Polling reads in-process state only — it costs no upstream
requests regardless of how many endpoints are configured. The page _load_ is
separate: it re-runs when the app's data is invalidated — returning to the tab,
or navigating — and refreshes the shared model cache if it has passed its
60-second TTL. So an open tab can produce a reachability probe per endpoint, but
at most once a minute and only when something actually invalidates; nothing
re-probes on a timer, and a tab genuinely left untouched produces none. That is
the same cache every other page shares, not traffic this view invents.

Editing endpoints from this page is not supported: they live in `config.toml`
and are read at startup. See [Configuration](configuration.md#endpoints).

## Upgrading a pre-multi-user install

Older single-user installs had one operator and no role column. The upgrade
migration adds `users.role` defaulting to `user`, so an existing database
momentarily has **zero admins** — and `/setup` is closed once any user exists,
leaving no in-app way to mint one.

GlyphStream self-heals: on the first authenticated request after the upgrade,
if there are users but no admin, the **earliest-created user (the original
operator) is promoted to admin** automatically. It's idempotent and a no-op
once an admin exists, so there's nothing to do by hand — just sign in.

## Per-user integrations

In a multi-user deployment, MCP servers can authenticate under **each user's
own token** (e.g. a personal email server) instead of one shared
container-wide credential — see
[per-user authentication](mcp.md#authentication) in the MCP guide. Per-user
memory and personalization are likewise scoped to each account.
