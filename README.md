# mailFlow

A desktop mail client for Windows that talks plain IMAP and SMTP. It runs
entirely on your PC: your mail, your passwords and your sign-in tokens never
leave it, except to reach the mail servers you configure.

The interface is in French.

## Features

- **Any IMAP mailbox.** Outlook.com and Microsoft 365 sign in with Microsoft
  (OAuth2, nothing to register). Other providers (o2switch, Hostinger, iCloud,
  Gmail with an app password, …) connect with their usual server settings.
- **Fast list and offline search.** Headers are cached in a local SQLite
  database; an optional indexing pass makes the body of every mail searchable
  offline. A server-side search covers mail that was never downloaded.
- **Safe reading.** Mail HTML is sanitised and shown in a sandboxed frame with
  no scripts. Remote images, fonts and stylesheets (often used to track when
  a mail is opened) stay blocked until you click "Afficher".
- **Writing.** Several messages at once, in floating windows that can be
  moved, resized and minimised; bold, italic, colours, fonts, links,
  attachments.
- **Junk handling.** Block a sender locally; for Microsoft accounts, the mail
  is also reported to Microsoft's junk-mail service.
- **Themes.** Seven skins (mailFlow, Cristal, Classique, Épure, Récif, Arène,
  Papeterie), each in light and dark mode.
- **Stays in the tray.** Closing the window keeps mailFlow running next to the
  clock and notifies you of new mail.

## Install

Download `mailFlow-Setup-<version>.exe` from the
[Releases](../../releases) page and run it. It installs for the current
Windows user only and needs no administrator rights. Uninstall it from
Windows Settings → Apps.

Your data lives in `%APPDATA%\mailFlow`. Account secrets there are encrypted
with a key that Windows protects for your user account.

## Build from source

Node.js 20 or newer.

```powershell
npm install
npm run desktop:dist
```

The installer lands in `desktop/release/`. `npm run dev` runs the API on
port 4100 and the interface on http://localhost:5180 for development; see
`.env.example` for the settings it reads. Packaging details:
[docs/packaging.md](docs/packaging.md). Accounts and OAuth:
[docs/accounts.md](docs/accounts.md).

## Privacy

This program will not transfer any information to other networked systems
unless specifically requested by the user or the person installing or
operating it.

In practice, mailFlow connects only to:

- the IMAP and SMTP servers of the accounts you add;
- Microsoft's or Google's sign-in service, when you connect an account that
  uses it;
- the address of a remote image or stylesheet in a mail, only after you click
  "Afficher" for that mail;
- Microsoft's junk-mail reporting address (`junk@office365.microsoft.com`),
  only when you block a sender of a Microsoft account; the reported mail is
  attached.

There is no telemetry, no analytics and no update check.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io),
certificate by [SignPath Foundation](https://signpath.org).

Releases are built from this repository by GitHub Actions
([.github/workflows/release.yml](.github/workflows/release.yml)); only those
builds are submitted for signing, and each signing request is approved by
hand.

Team roles:

- Committers and reviewers: [Marineau](https://github.com/Marineau)
- Approvers: [Marineau](https://github.com/Marineau)

Releases published before the SignPath subscription was granted are
unsigned.

## Licence

[MIT](LICENSE). Third-party notices for the code bundled in the installer are
written at build time and installed next to the program as
`LICENSES.mailflow.txt`.
