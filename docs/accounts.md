# Mail accounts

mailFlow talks plain IMAP + SMTP. Any provider that accepts those works; the
only question is how it logs in.

## What works

| Provider | Login | Status |
|---|---|---|
| Outlook.com / Hotmail / Live | OAuth2, Microsoft (PKCE public client) | In daily use since 2026-07-31 |
| Microsoft 365 work/school | OAuth2, tenant `common` | Untested; the tenant admin may have to consent |
| Gmail | OAuth2, Google (added 2026-11-18) | Code written, never run against Google |
| Gmail | App password (needs 2-step verification) | Untested |
| o2switch, Hostinger, iCloud, any IMAP host | Password | Generic path; no account of these tested in mailFlow |

Outlook.com refuses passwords, app passwords included (basic auth off since
2024-09-16).

## Two sources of accounts

- **`.env`** (`MAIL_1_*`, `MAIL_2_*`…): read at startup, read-only from the
  interface. See `.env.example`.
- **The interface** (« Comptes » button in the top bar, or the welcome screen
  when no account exists): stored in `server/data/accounts.json`, loaded at
  startup after `.env` and pushed into the same `accounts` array
  (`server/src/accountStore.ts`). Adding or removing one takes effect at once,
  without a restart.

Secrets of interface accounts (IMAP/SMTP password, Google client secret) are
sealed with AES-256-GCM (`server/src/secretBox.ts`). The key is
`MAILFLOW_SECRET_KEY` (32 bytes, base64) when set, else `server/data/secret.key`
generated on first use. With the default, the key sits next to the data: this
protects `accounts.json` copied on its own, not someone who reads the whole
data folder. OAuth refresh tokens stay in `server/data/tokens.json`, in clear,
as before.

The packaged Windows app does better on both (`docs/packaging.md` §7): it
keeps the key outside the data folder, encrypted by Windows for the user's
account, and passes it as `MAILFLOW_SECRET_KEY`. Whenever the key comes from
that variable, `tokens.json` is sealed with it as well (`keyIsExternal` in
`secretBox.ts`).

A password account is tested (IMAP login + SMTP verify) before it is saved.
An OAuth account is saved unauthorized; the form then opens the consent in a
popup (in the system browser for the packaged app) and polls `/api/accounts`
until the account reports `authorized`.

Removing an interface account closes its connections, forgets its token and
deletes its whole local cache (headers, bodies, FTS rows, index state,
senders, blocked senders, folders, attachment files). Nothing is deleted on
the mail server.

## API

| Route | Does |
|---|---|
| `GET /api/accounts` | `id, label, email, authMode, provider, source, authorized`. Never a secret. |
| `GET /api/account-setup` | Default OAuth client ids, whether a Google secret is configured, the redirect URI. |
| `POST /api/accounts/test` | Tries a password account's logins, saves nothing. |
| `POST /api/accounts` | Validates, tests (password), saves, starts the first sync. |
| `DELETE /api/accounts/:id` | Interface accounts only. |
| `GET /api/accounts/:id/oauth` | Starts the consent (Microsoft or Google). |
| `GET /api/oauth/callback` | Where the provider returns. The only route open without the session cookie when `MAILFLOW_SESSION_TOKEN` is set (`server/src/session.ts`). |

## Registering the OAuth apps

Redirect URI for both: `http://localhost:4100/api/oauth/callback`
(`PUBLIC_URL` changes the origin).

This is the developer's job, done once for mailFlow, not something a user of
the installed app does: the Windows app ships the Microsoft client id
(`docs/packaging.md` §8). No Google application is shipped; Gmail users of the
installed app go through an app password.

**Microsoft Entra**: public client (no secret), the redirect URI above, scopes
`IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`. Its client id is reused
for interface accounts (`MS_OAUTH_CLIENT_ID`, or the first Microsoft account in
`.env`), and written into the Windows app at build time by the same rule.
Microsoft ignores the port of this loopback address (checked 2026-11-18 at the
authorize step).

**Google Cloud** (free):
1. Create a project, enable the Gmail API.
2. OAuth consent screen: External, add your address as a test user.
3. Credentials → OAuth client ID → **Web application**, authorised redirect
   URI as above.
4. Put the id and secret in `.env` (`GOOGLE_OAUTH_CLIENT_ID`,
   `GOOGLE_OAUTH_CLIENT_SECRET`), or paste them in the add form, which then
   stores them with the account.

Scope requested: `https://mail.google.com/` (the only one that covers IMAP and
SMTP over XOAUTH2). Google classes it as restricted. While the app stays in
« Testing », refresh tokens expire after 7 days: the account falls back to
« autorisation en attente » weekly. Publishing it without verification should
lift that for personal use behind an « unverified app » warning; this has not
been checked.

Gmail, like Exchange, files mail sent through its SMTP into Sent itself, so
mailFlow skips its own APPEND copy for it (`serverFilesSentMail` in
`config.ts`).
