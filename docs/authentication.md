# Authentication

GlyphStream supports two sign-in methods, used independently or together:

- **GitHub OAuth** — for operators who want SSO via GitHub.
- **Passkeys (WebAuthn)** — for biometric / hardware-key login. A passkey
  ceremony with `userVerification: required` is multi-factor by
  construction; no separate TOTP layer is needed.

Both can be toggled via `GITHUB_LOGIN_ENABLED` / `PASSKEY_LOGIN_ENABLED` in
`.env` (default: both on). At least one must remain enabled — the server
refuses to boot otherwise.

OAuth is **pure authentication against an existing binding** — never an
account-creation path. The first-run setup wizard at `/setup` creates the
operator account and binds the chosen first method (GitHub or passkey). From
then on, additional OAuth providers are linked deliberately from
**Settings → Security**. A GitHub callback for an `external_id` that isn't
already in `oauth_accounts` is refused with `provider_not_bound`; there is
no allowlist, no auto-create.

Revocation is a single column: setting `users.disabled_at` invalidates every
session and refuses every login method at the next request.

## First-run setup

On a fresh install with no users, visiting any page redirects to `/setup`.
Pick a display name (and optionally an email), then either **Continue with
GitHub** or **Set up a passkey**:

- **GitHub** runs a standard OAuth round-trip; the callback creates the user
  and binds the GitHub identity. Requires the OAuth app configuration in the
  next section.
- **Passkey** runs a WebAuthn registration ceremony; the verify step creates
  the user + binds the credential atomically (no orphans on abandon).

`/setup` closes the moment the first user exists — direct visits land on
`/login` instead. The operator can later add a second login method (passkey
on a GitHub-bootstrapped account, or vice versa) from Settings → Security.

For deployments on a long-known subdomain that want defense in depth against
a "first visitor claims the account" race, set `SETUP_TOKEN` in `.env` to a
random value; `/setup` then requires `?token=<value>` to render. The token
has no effect once the first user exists.

## GitHub OAuth setup (optional)

Required only if you want GitHub as one of the sign-in methods. Skip this
whole section if you're going passkey-only.

### 1. Create a GitHub OAuth App

Go to [github.com/settings/developers](https://github.com/settings/developers)
→ **New OAuth App**. Fill in:

| Field                          | Value                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Application name**           | Anything you like (e.g. `GlyphStream`)                                                                                                                              |
| **Homepage URL**               | Your public origin — same value you'll set for `EXTERNAL_BASE_URL`. Examples: `http://localhost:5173` for local dev, `https://glyphstream.example.com` for prod     |
| **Authorization callback URL** | The homepage URL + `/api/auth/github/callback`. E.g. `http://localhost:5173/api/auth/github/callback` or `https://glyphstream.example.com/api/auth/github/callback` |

After creation, click **Generate a new client secret** and capture both:

- **Client ID** → `GITHUB_OAUTH_CLIENT_ID` in `.env`
- **Client secret** → `GITHUB_OAUTH_CLIENT_SECRET` in `.env`

### 2. Wire EXTERNAL_BASE_URL to the same origin

GlyphStream constructs the OAuth callback URL it sends to GitHub as
`${EXTERNAL_BASE_URL}/api/auth/github/callback`. This has to match the
**Authorization callback URL** registered in the GitHub app exactly — scheme
(`http` vs `https`), host, port (when non-default), no trailing slash. A
mismatch surfaces as GitHub's `"redirect_uri is not associated with this
application"` error after the user clicks Sign In.

```
# Local dev
EXTERNAL_BASE_URL=http://localhost:5173

# Production behind a reverse proxy
EXTERNAL_BASE_URL=https://glyphstream.example.com
```

> **Why `EXTERNAL_` instead of `PUBLIC_`?** SvelteKit reserves the `PUBLIC_`
> prefix for env vars exposed to browser code. A `PUBLIC_BASE_URL` would
> silently fail to read server-side and default to `localhost`, which then
> mismatches the OAuth callback in production. The `EXTERNAL_` prefix dodges
> that footgun.

## Passkeys

Once signed in (via the `/setup` wizard or by completing an OAuth ceremony
for an already-bound account), visit **Settings → Security** to bind a
passkey. Each registered passkey appears in the list with a name, "Synced" /
device-type badges, and when it was last used. You can rename or remove
passkeys at any time.

Multiple passkeys per account are supported and recommended — register one
per ecosystem (iCloud Keychain, 1Password / Bitwarden, etc.) so a single
outage doesn't lock you out. The "Add passkey" button respects whichever
authenticator the OS / browser offers, so picking a different provider per
registration is just a matter of accepting the right prompt at the time.

> **Don't change `EXTERNAL_BASE_URL` after passkeys are registered.**
> GlyphStream derives the WebAuthn relying-party ID from its hostname;
> changing the value invalidates every existing credential, and affected
> users have to sign in via another bound method and re-register.

When `PASSKEY_LOGIN_ENABLED=0`, the "Add passkey" button hides but the list
stays visible so existing rows can be pruned.
