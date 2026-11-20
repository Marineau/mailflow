/**
 * État réel du cache et de l'index de recherche.
 *
 *   npm run diagnose -w server -- [terme]
 */
import { db } from '../db.js';

const term = process.argv[2] ?? 'devis';

const folders = db
  .prepare(
    `SELECT account, folder,
            COUNT(*)                                   AS total,
            SUM(CASE WHEN snippet IS NULL THEN 1 ELSE 0 END) AS sans_corps,
            MIN(date) AS plus_ancien,
            MAX(date) AS plus_recent
     FROM messages GROUP BY account, folder ORDER BY total DESC`,
  )
  .all() as Record<string, number | string>[];

console.log('\n── En-têtes en base');
for (const row of folders) {
  const oldest = new Date(row.plus_ancien as number).toISOString().slice(0, 10);
  const newest = new Date(row.plus_recent as number).toISOString().slice(0, 10);
  console.log(
    `   ${String(row.folder).padEnd(28)} ${String(row.total).padStart(6)} mails  ` +
      `${String((row.total as number) - (row.sans_corps as number)).padStart(6)} indexés  ` +
      `${oldest} → ${newest}`,
  );
}

const fts = db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get() as { n: number };
console.log(`\n── Index plein texte : ${fts.n} documents`);

const state = db.prepare('SELECT * FROM index_state ORDER BY folder').all() as Record<
  string,
  unknown
>[];
console.log('\n── Avancement de l’indexation');
if (state.length === 0) console.log('   (aucune indexation lancée)');
for (const row of state) {
  console.log(
    `   ${String(row.folder).padEnd(28)} phase=${row.phase}  ` +
      `en-têtes ${row.headers_done}/${row.headers_total}  corps ${row.bodies_done}/${row.bodies_total}` +
      (row.error ? `  erreur: ${row.error}` : ''),
  );
}

console.log(`\n── Recherche locale de « ${term} »`);
const hits = db
  .prepare(
    `SELECT m.folder, m.date, m.subject FROM messages_fts f
     JOIN messages m ON m.account = f.account AND m.folder = f.folder AND m.uid = f.uid
     WHERE messages_fts MATCH ? ORDER BY m.date DESC LIMIT 15`,
  )
  .all(`"${term}"*`) as { folder: string; date: number; subject: string }[];

console.log(`   ${hits.length} résultat(s)`);
for (const hit of hits) {
  console.log(`   ${new Date(hit.date).toISOString().slice(0, 10)}  ${hit.subject}`);
}
console.log('');
