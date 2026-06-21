# Authentication

GlyphStream supports several sign-in methods, used independently or together:

- **GitHub OAuth** — SSO via GitHub.
- **Google OAuth** — SSO via a Google account.
- **Generic OIDC** — any standards-compliant OpenID Connect provider
  (Authentik, Keycloak, Authelia, Pocket ID, Google Workspace, Microsoft
  Entra, …) configured by its issuer URL. The button label is operator-set.
- **Passkeys (WebAuthn)** — for biometric / hardware-key login. A passkey
  ceremony with `userVerification: required` is multi-factor by
  construction; no separate TOTP layer is needed.

Each is toggled via its `*_LOGIN_ENABLED` flag in `.env` — `GITHUB_LOGIN_ENABLED`
(default on), `GOOGLE_LOGIN_ENABLED` (default off), `OIDC_LOGIN_ENABLED`
(default off), `PASSKEY_LOGIN_ENABLED` (default on). At least one must remain
enabled — the server refuses to boot otherwise. An OAuth provider's button only
appears when its flag is on **and** its credentials are configured, so a
flagged-on-but-unconfigured provider never shows a button that would fail.

Sign-in from the login page is **pure authentication against an existing
binding** — never an account-creation path. An OAuth callback for an
`external_id` that isn't already in `oauth_accounts` is refused with
`provider_not_bound`; there is no open registration and no allowlist.

Accounts are created in exactly two places: the first-run setup wizard at
`/setup`, which creates the instance **admin**, and redemption of an
admin-issued invite at `/join/<token>` — see
[Multi-user & administration](multi-user.md). Both bind the chosen method
(any OAuth provider or a passkey) at creation; afterward, additional methods
are linked deliberately from **Settings → Security**.

Revocation is a single column: setting `users.disabled_at` (toggled from
**Settings → Admin** — see [managing accounts](multi-user.md#managing-accounts))
invalidates every session and refuses every login method at the next request.

## First-run setup

On a fresh install with no users, visiting any page redirects to `/setup`.
Pick a display name (and optionally an email), then continue with any enabled
OAuth provider or set up a passkey:

- **An OAuth provider** runs a standard OAuth round-trip; the callback creates
  the user and binds that identity. Requires the provider's configuration in
  the sections below.
- **Passkey** runs a WebAuthn registration ceremony; the verify step creates
  the user + binds the credential atomically (no orphans on abandon).

`/setup` closes the moment the first user exists — direct visits land on
`/login` instead. This first account is the instance **admin**; everyone else
joins through an admin-issued invite (see
[Multi-user & administration](multi-user.md)). The operator can later add more
login methods (a second provider, or a passkey) from Settings → Security.

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

> **GitHub keeps its own callback path.** For back-compat, GitHub's callback
> stays at `/api/auth/github/callback` (existing OAuth apps need no change).
> The newer providers below use `/api/auth/oauth/<provider>/callback`.

## Google OAuth setup (optional)

Required only if you want Google as a sign-in method.

1. In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   → **Create credentials → OAuth client ID → Web application**.
2. Under **Authorized redirect URIs**, add
   `${EXTERNAL_BASE_URL}/api/auth/oauth/google/callback` — e.g.
   `http://localhost:5173/api/auth/oauth/google/callback` for local dev or
   `https://glyphstream.example.com/api/auth/oauth/google/callback` for prod.
   It must match exactly (scheme, host, port, no trailing slash).
3. Capture the credentials into `.env` and enable the button:
   - **Client ID** → `GOOGLE_OAUTH_CLIENT_ID`
   - **Client secret** → `GOOGLE_OAUTH_CLIENT_SECRET`
   - `GOOGLE_LOGIN_ENABLED=1`

Google uses PKCE automatically; no extra configuration is needed.

## Generic OIDC setup (optional)

Point GlyphStream at any OpenID Connect provider via its issuer URL. The
issuer's discovery document (`<issuer>/.well-known/openid-configuration`) is
fetched at runtime to locate the authorization and token endpoints, so you
only supply the issuer — not individual endpoints.

1. Register a new OAuth/OIDC client in your IdP (Authentik, Keycloak,
   Authelia, Pocket ID, etc.) as a **confidential** client using the
   **authorization code** flow with **PKCE**.
2. Set its redirect URI to
   `${EXTERNAL_BASE_URL}/api/auth/oauth/oidc/callback` (exact match).
3. Configure `.env`:
   - `OIDC_ISSUER` — the issuer base URL, e.g. `https://auth.example.com`
   - `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`
   - `OIDC_LOGIN_ENABLED=1`
   - `OIDC_DISPLAY_NAME` — the button label (default `SSO`); set it to your
     IdP's name, e.g. `Authentik` or `Company SSO`
   - `OIDC_SCOPES` — space-separated, defaults to `openid profile email`
     (`openid` is mandatory)

The user's `sub` claim is the stable binding key; `preferred_username`,
`email`, and `name` populate the display snapshot when present.

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
