/**
 * Test de connexion IMAP + SMTP pour chaque compte du `.env`.
 * Aucun mail n'est lu ni envoyé : on vérifie uniquement l'authentification.
 *
 *   npm run test:connection -w server
 */
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { accounts, PORT } from '../config.js';
import { getAccessToken, hasToken } from '../oauth.js';

if (accounts.length === 0) {
  console.error('Aucun compte dans .env — rien à tester.');
  process.exit(1);
}

let failures = 0;

for (const account of accounts) {
  console.log(`\n── ${account.label} <${account.email}>  [${account.authMode}]`);

  if (account.authMode === 'oauth2' && !hasToken(account.id)) {
    failures += 1;
    console.error(
      '   ✗ Aucun jeton. Démarrez le serveur puis ouvrez :\n' +
        `     http://localhost:${PORT}/api/accounts/${account.id}/oauth`,
    );
    continue;
  }

  let credentials: { user: string; pass?: string; accessToken?: string };
  try {
    credentials =
      account.authMode === 'oauth2'
        ? { user: account.imap.user, accessToken: await getAccessToken(account) }
        : { user: account.imap.user, pass: account.pass };
  } catch (err) {
    failures += 1;
    console.error(`   ✗ Jeton non renouvelable : ${(err as Error).message}`);
    continue;
  }

  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: credentials as never,
    logger: false,
  });

  try {
    await client.connect();
    const boxes = await client.list();
    console.log(`   IMAP  ✓ connecté — ${boxes.length} dossiers`);
    console.log(`         ${boxes.map((b) => b.path).slice(0, 12).join(', ')}`);
    await client.logout();
  } catch (err) {
    failures += 1;
    const message = (err as Error).message;
    console.error(`   IMAP  ✗ ${message}`);
    if (account.authMode === 'password' && /AUTHENTICATIONFAILED|LOGIN failed/i.test(message)) {
      console.error(
        "         → sur outlook.com, le mot de passe d'application ne suffit plus :\n" +
          '           passez le compte en MAIL_x_AUTH=oauth2.',
      );
    }
  }

  try {
    await nodemailer
      .createTransport({
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
        auth:
          account.authMode === 'oauth2'
            ? { type: 'OAuth2', user: account.smtp.user, accessToken: credentials.accessToken }
            : { user: account.smtp.user, pass: account.pass },
      })
      .verify();
    console.log('   SMTP  ✓ authentification acceptée');
  } catch (err) {
    failures += 1;
    console.error(`   SMTP  ✗ ${(err as Error).message}`);
  }
}

console.log(failures === 0 ? '\nTout est bon.\n' : `\n${failures} échec(s).\n`);
process.exit(failures === 0 ? 0 : 1);
