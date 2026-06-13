# Multi-user & administration

GlyphStream is multi-user, sized for small-team / household scale (not SaaS).
The first account — created by the
[setup wizard](authentication.md#first-run-setup) — is the **admin**. Everyone
else joins by an admin-issued **invite**; there is no open registration.

## Roles

There are two roles, `admin` and `user`:

- **`admin`** — everything a user can do, plus the **Administration** panel at
  **Settings → Admin**: manage accounts and issue invites. The setup-wizard
  user is the admin, and an admin can grant the role to others by issuing an
  admin-role invite.
- **`user`** — a normal account, no admin panel.

Role gates **operator capability, not data**. Admins do **not** see other
users' conversations or media — every row is scoped by `user_id` and nothing
in the data layer keys off role. "Admin" is purely the user-management
surface.

## Inviting users

Account creation is invite-only after the first user. From **Settings → Admin
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

## Managing accounts

**Settings → Admin → Users** lists every account with its role, the date it
was created, and who invited it. Per row:

- **Disable / Enable** — disabling sets `users.disabled_at`, which invalidates
  every active session and refuses every login method on that user's next
  request. Re-enabling restores access. Nothing is deleted; this is the
  reversible "revoke access" lever.
- **Delete** — removes the account and cascades its data (conversations, media
  references, credentials). Irreversible.

Two guardrails are enforced by the API, not just hidden in the UI:

- You **can't disable or delete your own account** from the admin panel — that
  would be a mid-session self-lockout footgun.
- You **can't remove the last active admin.** Disabling or deleting the only
  admin is refused, so the instance is never stranded with nobody able to
  reach this panel.

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
