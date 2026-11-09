/**
 * Arret propre et recuperation au demarrage.
 *
 * Le defaut couvert ici : un export interrompu (Ctrl-C, plantage) abandonnait
 * des `.slideshot-<uuid>-NNN.png` dans le dossier de l'utilisateur. Ce sont des
 * fichiers caches : personne ne les voit, personne ne les efface.
 *
 * Invariant a ne jamais casser : on ne supprime que les residus portant SON
 * PROPRE exportId. Le dossier appartient a l'utilisateur.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.SLIDESHOT_NO_OPEN = '1';

const { start, stopWork } = await import('../server.js');
const sessions = await import('../lib/sessions.js');
const { activeChildCount } = await import('../lib/poppler.js');
const { sweepTemp, sweepTempSync, tempPrefix, sweepFailureMessage } = await import(
  '../lib/export-job.js'
);

const { PDF_DE_TEST: TEST_PDF, PAGES_DU_PDF_DE_TEST: TEST_PDF_PAGES } = await import('./fixtures/pdf-de-test.js');

let handle;
let origin;
let scratch;

before(async () => {
  assert.ok(fs.existsSync(TEST_PDF), `PDF de test absent : ${TEST_PDF}`);
  handle = await start({ port: 0 });
  origin = handle.url;
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'slide-shot-shutdown-'));
});

after(async () => {
  await handle?.close();
  if (scratch) await fsp.rm(scratch, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function postJson(pathname, body) {
  return fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function openTestPdf() {
  const res = await postJson('/api/open', { path: TEST_PDF });
  assert.equal(res.status, 200);
  return res.json();
}

async function residuesIn(dir) {
  const names = await fsp.readdir(dir);
  return names.filter((n) => n.startsWith('.slideshot-'));
}

/** Un PID libre : `kill(pid, 0)` doit repondre ESRCH, pas EPERM. */
function findDeadPid() {
  for (let pid = 90_000; pid < 99_999; pid += 7) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err?.code === 'ESRCH') return pid;
    }
  }
  throw new Error('aucun PID mort trouve pour le test');
}

/* ------------------------------------------------------------------ */
/* Balayage a l'arret                                                  */
/* ------------------------------------------------------------------ */

describe("arret du serveur — balayage des exports en vol", () => {
  test('un export interrompu ne laisse aucun residu dans dest', async () => {
    const doc = await openTestPdf();
    const dest = path.join(scratch, 'export-interrompu');
    await fsp.mkdir(dest, { recursive: true });

    // Le residu d'un AUTRE export, qui doit survivre a notre menage.
    const foreign = path.join(dest, '.slideshot-un-autre-export-042.png');
    await fsp.writeFile(foreign, 'residu etranger');
    // Et un fichier de l'utilisateur, evidemment intouchable.
    const userFile = path.join(dest, 'photo.png');
    await fsp.writeFile(userFile, 'contenu utilisateur');

    // Un rendu volontairement lourd, pour avoir le temps de couper au milieu.
    const created = await postJson('/api/export', {
      docId: doc.docId,
      pages: Array.from({ length: TEST_PDF_PAGES }, (_, i) => i + 1),
      dest,
      dpi: 600,
      format: 'png',
    });
    assert.equal(created.status, 200);
    const { exportId } = await created.json();

    // Le travail ne demarre qu'a la connexion SSE. On consomme le flux en
    // tache de fond : on ne veut surtout pas se deconnecter, c'est deja teste
    // ailleurs — ici on simule un serveur qu'on arrete pendant l'export.
    const stream = await fetch(`${origin}/api/export/${exportId}/events`);
    const reader = stream.body.getReader();
    const drain = (async () => {
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) return;
        }
      } catch {
        /* le flux se coupe avec le serveur : normal */
      }
    })();

    // On attend que le rendu soit reellement en cours : au moins un residu
    // ecrit ET au moins un pdftoppm vivant.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const residues = await residuesIn(dest);
      if (residues.some((n) => n.startsWith(tempPrefix(exportId))) && activeChildCount() > 0) break;
      assert.ok(Date.now() < deadline, 'le rendu n a jamais demarre');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Rien ne peut changer entre cette lecture et l'appel : `stopWork` prend
    // son instantane des enfants de facon synchrone.
    assert.ok(activeChildCount() > 0, 'un pdftoppm doit etre en vol');
    const result = await stopWork();

    assert.ok(result.killed >= 1, `au moins un pdftoppm devait etre tue (${result.killed})`);
    assert.equal(result.failed, 0, 'le balayage ne doit pas echouer');

    // L'invariant : plus aucun residu de CET export, immediatement.
    const after = await fsp.readdir(dest);
    const own = after.filter((n) => n.startsWith(tempPrefix(exportId)));
    assert.deepEqual(own, [], `residus abandonnes : ${own}`);

    // Le residu d'un autre export et le fichier utilisateur sont intacts.
    assert.equal(fs.existsSync(foreign), true, "le residu d'un autre export doit survivre");
    assert.equal(await fsp.readFile(foreign, 'utf8'), 'residu etranger');
    assert.equal(await fsp.readFile(userFile, 'utf8'), 'contenu utilisateur');

    // Les processus poppler sont bien morts, pas seulement signales.
    assert.equal(activeChildCount(), 0, 'aucun pdftoppm ne doit survivre a l arret');

    await drain;
  });

  test('le balayage d arret n efface que les residus des exports enregistres', async () => {
    const dest = path.join(scratch, 'balayage-cible');
    await fsp.mkdir(dest, { recursive: true });

    const mine = 'export-a-nettoyer';
    const own = [
      path.join(dest, `${tempPrefix(mine)}-001.png`),
      path.join(dest, `${tempPrefix(mine)}-002.png`),
    ];
    const foreign = path.join(dest, '.slideshot-export-d-un-voisin-001.png');
    const userFile = path.join(dest, 'notes.txt');
    for (const p of [...own, foreign, userFile]) await fsp.writeFile(p, 'x');

    sessions.beginActiveExport({ exportId: mine, dest });
    assert.ok(
      sessions.listActiveExports().some((e) => e.exportId === mine && e.dest === dest),
      'l export doit etre enregistre avec son dest',
    );

    const result = await stopWork();
    assert.ok(result.removed >= 2, `au moins 2 residus balayes, obtenu ${result.removed}`);
    assert.equal(result.failed, 0);

    for (const p of own) assert.equal(fs.existsSync(p), false, `${p} devait disparaitre`);
    assert.equal(fs.existsSync(foreign), true, "le residu d'un autre export doit survivre");
    assert.equal(fs.existsSync(userFile), true);
    assert.deepEqual(sessions.listActiveExports(), []);
  });

  test('le journal des exports actifs suit les debuts et les fins', async () => {
    const journal = path.join(sessions.sessionDir(), 'active-exports.jsonl');
    const dest = path.join(scratch, 'journal');
    await fsp.mkdir(dest, { recursive: true });

    sessions.beginActiveExport({ exportId: 'journal-1', dest });
    const written = await fsp.readFile(journal, 'utf8');
    const lines = written.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(
      lines.some((l) => l.exportId === 'journal-1' && l.dest === dest),
      `journal incomplet : ${written}`,
    );

    sessions.endActiveExport('journal-1');
    const cleared = await fsp.readFile(journal, 'utf8');
    assert.equal(cleared.includes('journal-1'), false, "le journal doit oublier l'export termine");
  });
});

/* ------------------------------------------------------------------ */
/* Recuperation au demarrage                                           */
/* ------------------------------------------------------------------ */

describe('recuperation au demarrage', () => {
  test('la session d un PID mort fait balayer les dest journalises', async () => {
    const dest = path.join(scratch, 'recuperation');
    await fsp.mkdir(dest, { recursive: true });

    const exportId = 'export-tue-par-un-sigkill';
    const own = [
      path.join(dest, `${tempPrefix(exportId)}-001.png`),
      path.join(dest, `${tempPrefix(exportId)}-002.png`),
      path.join(dest, `${tempPrefix(exportId)}-003.png`),
    ];
    const foreign = path.join(dest, '.slideshot-encore-un-autre-007.png');
    const userFile = path.join(dest, 'mes-vacances.png');
    for (const p of [...own, foreign, userFile]) await fsp.writeFile(p, 'x');

    // Une session laissee par un processus qui n'existe plus.
    const deadPid = findDeadPid();
    const staleDir = path.join(os.tmpdir(), `slide-shot-${deadPid}`);
    await fsp.rm(staleDir, { recursive: true, force: true });
    await fsp.mkdir(staleDir, { recursive: true });
    await fsp.writeFile(
      path.join(staleDir, 'active-exports.jsonl'),
      `${JSON.stringify({ exportId, dest })}\n` +
        // Une ligne tronquee par l'arret brutal : elle ne doit pas tout invalider.
        '{"exportId":"tronq\n',
      'utf8',
    );

    const recovered = sessions.recoverStaleSessions();

    assert.ok(recovered >= 3, `au moins 3 residus recuperes, obtenu ${recovered}`);
    for (const p of own) assert.equal(fs.existsSync(p), false, `${p} devait etre balaye`);
    assert.equal(fs.existsSync(foreign), true, "le residu d'un autre export doit survivre");
    assert.equal(fs.existsSync(userFile), true, "le fichier de l'utilisateur doit survivre");
    assert.equal(fs.existsSync(staleDir), false, 'la session morte doit etre effacee');
  });

  test('les exports d une session morte sont repris a notre compte', async () => {
    // Un `pdftoppm` orphelin peut survivre au SIGKILL de son serveur et ecrire
    // juste apres le balayage de demarrage. On verifie que l'export recupere
    // est adopte : notre propre arret le rebalaiera.
    const dest = path.join(scratch, 'adoption');
    await fsp.mkdir(dest, { recursive: true });
    const exportId = 'export-adopte';

    const deadPid = findDeadPid();
    const staleDir = path.join(os.tmpdir(), `slide-shot-${deadPid}`);
    await fsp.rm(staleDir, { recursive: true, force: true });
    await fsp.mkdir(staleDir, { recursive: true });
    await fsp.writeFile(
      path.join(staleDir, 'active-exports.jsonl'),
      `${JSON.stringify({ exportId, dest })}\n`,
      'utf8',
    );

    sessions.purgeTmp();
    assert.ok(
      sessions.listActiveExports().some((e) => e.exportId === exportId && e.dest === dest),
      "l'export de la session morte doit etre adopte",
    );

    // Le residu arrive apres coup, comme celui d'un orphelin qui ecrivait encore.
    const late = path.join(dest, `${tempPrefix(exportId)}-013.png`);
    const foreign = path.join(dest, '.slideshot-pas-a-nous-013.png');
    await fsp.writeFile(late, 'ecrit par un orphelin');
    await fsp.writeFile(foreign, 'x');

    await stopWork();
    assert.equal(fs.existsSync(late), false, "le residu tardif doit etre rattrape a l'arret");
    assert.equal(fs.existsSync(foreign), true, "le residu d'un autre export doit survivre");
  });

  test('la session du processus vivant n est jamais touchee', () => {
    const mine = sessions.sessionDir();
    assert.equal(fs.existsSync(mine), true);
    sessions.recoverStaleSessions();
    assert.equal(fs.existsSync(mine), true, 'la session courante ne doit pas etre supprimee');
  });
});

/* ------------------------------------------------------------------ */
/* Echec du nettoyage : jamais avale                                   */
/* ------------------------------------------------------------------ */

describe('sweepTemp — un echec de nettoyage doit se voir', () => {
  test('renvoie failed > 0 quand la suppression est impossible', async () => {
    const dest = path.join(scratch, 'nettoyage-impossible');
    await fsp.mkdir(dest, { recursive: true });
    const exportId = 'export-verrouille';
    await fsp.writeFile(path.join(dest, `${tempPrefix(exportId)}-001.png`), 'x');
    await fsp.writeFile(path.join(dest, `${tempPrefix(exportId)}-002.png`), 'x');

    // Dossier lisible mais non inscriptible : on voit les residus, on ne peut
    // pas les effacer. C'est le cas ou l'echec etait avale silencieusement.
    await fsp.chmod(dest, 0o500);
    let result;
    try {
      result = await sweepTemp(dest, exportId);
    } finally {
      await fsp.chmod(dest, 0o700);
    }

    assert.equal(result.removed, 0);
    assert.equal(result.failed, 2, "l'echec du nettoyage doit etre compte");

    const message = sweepFailureMessage(dest, exportId, result.failed);
    assert.match(message, /Nettoyage incomplet/);
    assert.ok(message.includes(tempPrefix(exportId)), 'le message doit nommer le prefixe a chercher');
    assert.ok(message.includes(dest), 'le message doit nommer le dossier');
  });

  test('un dossier disparu n est pas un echec', async () => {
    const gone = path.join(scratch, 'dossier-inexistant-42');
    assert.deepEqual(await sweepTemp(gone, 'peu-importe'), { removed: 0, failed: 0 });
    assert.deepEqual(sweepTempSync(gone, 'peu-importe'), { removed: 0, failed: 0 });
  });

  test('sweepTempSync ne touche que son propre exportId', async () => {
    const dest = path.join(scratch, 'sweep-sync');
    await fsp.mkdir(dest, { recursive: true });
    const mine = path.join(dest, `${tempPrefix('sync-a')}-001.png`);
    const foreign = path.join(dest, `${tempPrefix('sync-b')}-001.png`);
    await fsp.writeFile(mine, 'x');
    await fsp.writeFile(foreign, 'x');

    assert.deepEqual(sweepTempSync(dest, 'sync-a'), { removed: 1, failed: 0 });
    assert.equal(fs.existsSync(mine), false);
    assert.equal(fs.existsSync(foreign), true);
  });
});

/* ------------------------------------------------------------------ */
/* Le warning remonte jusqu'a l'utilisateur                            */
/* ------------------------------------------------------------------ */

describe("echec de nettoyage remonte jusqu'a l'utilisateur", () => {
  test("des residus qui resistent sont annonces dans le message d'erreur", async () => {
    const { runExportJob } = await import('../lib/export-job.js');
    const { findPoppler } = await import('../lib/poppler.js');
    const { pdftoppm } = findPoppler();
    assert.ok(pdftoppm, 'poppler doit etre installe');

    const dest = path.join(scratch, 'sse-nettoyage-impossible');
    await fsp.mkdir(dest, { recursive: true });
    const exportId = 'export-residus-coriaces';
    const stuck = path.join(dest, `${tempPrefix(exportId)}-001.png`);
    await fsp.writeFile(stuck, 'residu qu on ne pourra pas effacer');

    // Le dossier devient non inscriptible : le rendu echoue ET le balayage
    // n'arrive pas a effacer le residu deja present.
    await fsp.chmod(dest, 0o500);
    let failure = null;
    try {
      await runExportJob(
        {
          exportId,
          pdftoppmPath: pdftoppm,
          pdfPath: TEST_PDF,
          pages: [1, 2],
          dest,
          dpi: 72,
          format: 'png',
          base: 'test',
          pageCount: TEST_PDF_PAGES,
        },
        { emit: () => {} },
      );
    } catch (err) {
      failure = err;
    } finally {
      await fsp.chmod(dest, 0o700);
    }

    assert.ok(failure, 'le rendu devait echouer');
    assert.match(
      failure.message,
      /Nettoyage incomplet/,
      `l'echec du nettoyage doit etre annonce, obtenu : ${failure?.message}`,
    );
    assert.ok(failure.message.includes(tempPrefix(exportId)));
    // Le residu est toujours la : c'est bien qu'on n'a pas menti a l'utilisateur.
    assert.equal(fs.existsSync(stuck), true);
    await fsp.rm(stuck, { force: true });
  });

  test("un nettoyage reussi n'ajoute aucun avertissement parasite", async () => {
    const { runExportJob } = await import('../lib/export-job.js');
    const { findPoppler } = await import('../lib/poppler.js');
    const { pdftoppm } = findPoppler();
    const dest = path.join(scratch, 'sse-nettoyage-ok');
    await fsp.mkdir(dest, { recursive: true });

    const result = await runExportJob(
      {
        exportId: 'export-propre',
        pdftoppmPath: pdftoppm,
        pdfPath: TEST_PDF,
        pages: [1],
        dest,
        dpi: 72,
        format: 'png',
        base: 'test',
        pageCount: TEST_PDF_PAGES,
      },
      { emit: () => {} },
    );

    assert.equal(result.files.length, 1);
    assert.equal(
      result.warnings.some((w) => /Nettoyage incomplet/.test(w)),
      false,
      'aucun avertissement de nettoyage quand tout s est bien passe',
    );
    assert.deepEqual(await residuesIn(dest), []);
  });
});
