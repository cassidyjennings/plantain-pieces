# Google sign-in setup

The "Continue with Google" button on the Profile screen upgrades a guest into a real account
via `supabase.auth.linkIdentity()`. Everything in the app and the Supabase config is already
wired and **enabled** — the flow redirects to the real Google consent screen. The **only**
thing left is to plug in OAuth credentials from your own Google Cloud account (these are
account-specific; they can't be shared or created for you).

Once you paste the credentials below and restart the stack, sign-in works end to end. Guest
progress (stats, achievements, dictionaries) carries over automatically because the identity
links to the **same** `profiles.id`.

> Apple Sign In is intentionally not offered — it requires a paid Apple Developer account.
> `[auth.external.apple]` is disabled in `config.toml`.

## How the wiring works

- `supabase/config.toml` has `[auth.external.google]` with `enabled = true` and
  `client_id`/`secret` read from `env(...)`.
- The Supabase CLI substitutes those `env(...)` refs from a **`.env` file at the repo root**
  (gitignored). Copy `.env.example` → `.env` and fill it in.
- The OAuth callback is `http://127.0.0.1:54321/auth/v1/callback` (local). After sign-in the
  browser returns to `/profile` (allow-listed in `additional_redirect_urls`).
- A DB trigger (`handle_identity_linked`, migration `20260719000003`) flips `is_guest = false`
  when a non-anonymous identity is linked.

```
cp .env.example .env      # then edit .env with the values below
npm run db:start          # restart so the CLI picks up the new env values
```

Any time you change `.env`, restart: `npx supabase stop && npm run db:start`.

---

## Google (≈5 minutes)

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) → create (or pick) a
   project.
2. **APIs & Services → OAuth consent screen**: configure it (External, add your email as a
   test user). You don't need verification for local/testing.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized redirect URIs**: add
     `http://127.0.0.1:54321/auth/v1/callback`
     (for production add `https://<your-project-ref>.supabase.co/auth/v1/callback`).
4. Copy the **Client ID** and **Client secret** into `.env`:
   ```
   SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=<client id>.apps.googleusercontent.com
   SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=<client secret>
   ```
5. `npm run db:start`. Click **Continue with Google** — you should reach Google's consent
   screen and return signed in.

---

## Production notes

- Set the same env vars in your deployment (Cloudflare Pages/Workers env, or the Supabase
  dashboard → Authentication → Providers if you're on hosted Supabase).
- Add the production callback URL (`https://<ref>.supabase.co/auth/v1/callback`) to Google's
  authorized redirect URIs, and add your production site URL to `additional_redirect_urls` /
  `site_url`.
- Guests use `sessionStorage` (per-tab) by design; a linked account still needs a re-login per
  new tab/device, which restores the same profile. Cross-tab session persistence for accounts
  is a known follow-up.
