import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.SLIDESHOT_NO_OPEN = '1';

const { start } = await import('../server.js');
// Meme instance de module que celle du serveur : on peut inspecter et truquer
// l'etat des documents pour tester les chemins d'erreur.
const sessions = await import('../lib/sessions.js');

const TEST_PDF = '/Users/Tim/Desktop/all/dev/perso/2020-Scrum-Guide-French.pdf';
const TEST_PDF_PAGES = 15;
const TEST_PDF_BASE = '2020-Scrum-Guide-French';

let handle;
let origin;
let scratch;

before(async () => {
  assert.ok(fs.existsSync(TEST_PDF), `PDF de test absent : ${TEST_PDF}`);
  handle = await start({ port: 0 });
  origin = handle.url;
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'slide-shot-test-'));
});

after(async () => {
  await handle?.close();
  if (scratch) await fsp.rm(scratch, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function api(pathname, options) {
  return fetch(`${origin}${pathname}`, options);
}

function postJson(pathname, body) {
  return api(pathname, {
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

/**
 * Requete HTTP brute. `fetch` interdit de fixer `Host` et `Origin` (ce sont des
 * en-tetes proteges), or c'est exactement ce qu'on doit tester : un attaquant,
 * lui, n'a pas cette contrainte.
 */
function rawRequest({ method = 'GET', path: pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: handle.port, method, path: pathname, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Consomme un flux SSE jusqu'a `done` ou `error`. */
async function consumeSse(pathname, { timeoutMs = 120_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await api(pathname, { signal: controller.signal });
    assert.equal(res.status, 200, `statut SSE inattendu : ${res.status}`);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');

    const events = [];
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
        }
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

async function runExport(body, { timeoutMs } = {}) {
  const res = await postJson('/api/export', body);
  assert.equal(res.status, 200, `export refuse : ${await res.clone().text()}`);
  const { exportId } = await res.json();
  assert.ok(exportId, 'exportId manquant');
  return consumeSse(`/api/export/${exportId}/events`, { timeoutMs });
}

/* ------------------------------------------------------------------ */
/* Sante et statique                                                   */
/* ------------------------------------------------------------------ */

describe('/api/health', () => {
  test('renvoie les chemins de poppler', async () => {
    const res = await api('/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.ok, 'boolean');
    assert.ok('pdftoppm' in body && 'pdfinfo' in body);
    assert.equal(body.ok, Boolean(body.pdftoppm && body.pdfinfo));
    assert.equal(body.ok, true, 'poppler doit etre installe pour la suite des tests');
  });
});

describe('statique', () => {
  test('sert /lib/pages.js en text/javascript', async () => {
    const res = await api('/lib/pages.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/javascript/);
    const body = await res.text();
    assert.match(body, /export function parsePageSpec/);
  });

  test('refuse la traversee de chemin encodee', async () => {
    for (const target of [
      '/lib/%2e%2e/package.json',
      '/%2e%2e/package.json',
      '/public/%2e%2e/%2e%2e/etc/passwd',
      '/lib/sessions.js',
      '/server.js',
      '/package.json',
    ]) {
      const res = await api(target);
      assert.equal(res.status, 404, `${target} ne doit pas etre servi`);
      const body = await res.text();
      assert.doesNotMatch(body, /slide-shot"/, `${target} a fuite du contenu`);
    }
  });

  test('methode inconnue sur une route existante -> 405', async () => {
    const res = await api('/api/health', { method: 'POST' });
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.equal(typeof body.error, 'string');
  });
});

/* ------------------------------------------------------------------ */
/* Garde d'origine : Host et Origin                                    */
/* ------------------------------------------------------------------ */

describe("garde d'origine", () => {
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const openBody = JSON.stringify({ path: TEST_PDF });

  test('Host etranger -> 403, sans effet de bord', async () => {
    // Le scenario du DNS rebinding : la requete arrive bien sur 127.0.0.1,
    // mais avec le nom de l'attaquant dans Host.
    const res = await rawRequest({
      method: 'POST',
      path: '/api/open',
      headers: { ...jsonHeaders, Host: 'attaquant.example' },
      body: openBody,
    });
    assert.equal(res.status, 403);
    assert.equal(typeof JSON.parse(res.text).error, 'string');
    // Le document n'a pas ete ouvert : aucun dialogue, aucun rendu declenche.
    assert.doesNotMatch(res.text, /docId/);
  });

  test('Host sans port ou avec le mauvais port -> 403', async () => {
    for (const host of ['127.0.0.1', 'localhost', `127.0.0.1:${handle.port + 1}`, 'slide-shot.local']) {
      const res = await rawRequest({ path: '/api/health', headers: { Host: host } });
      assert.equal(res.status, 403, `Host ${host} devait etre refuse`);
    }
  });

  test('Origin etranger -> 403', async () => {
    for (const origin of ['https://evil.example', 'http://evil.example', 'null', 'http://127.0.0.1:1']) {
      const res = await rawRequest({
        method: 'POST',
        path: '/api/open',
        headers: { ...jsonHeaders, Origin: origin },
        body: openBody,
      });
      assert.equal(res.status, 403, `Origin ${origin} devait etre refuse`);
    }
  });

  test('absence d Origin -> accepte (EventSource, curl, fetch same-origin)', async () => {
    const res = await rawRequest({ path: '/api/health' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).ok, true);

    const opened = await rawRequest({
      method: 'POST',
      path: '/api/open',
      headers: jsonHeaders,
      body: openBody,
    });
    assert.equal(opened.status, 200);
  });

  test('localhost:<port> et 127.0.0.1:<port> -> acceptes', async () => {
    for (const host of [`localhost:${handle.port}`, `127.0.0.1:${handle.port}`]) {
      const res = await rawRequest({ path: '/api/health', headers: { Host: host } });
      assert.equal(res.status, 200, `Host ${host} devait etre accepte`);
    }
    for (const origin of [`http://localhost:${handle.port}`, `http://127.0.0.1:${handle.port}`]) {
      const res = await rawRequest({
        method: 'POST',
        path: '/api/open',
        headers: { ...jsonHeaders, Origin: origin },
        body: openBody,
      });
      assert.equal(res.status, 200, `Origin ${origin} devait etre accepte`);
    }
  });

  test('aucun en-tete CORS n est emis', async () => {
    const res = await api('/api/health');
    assert.equal(res.status, 200);
    await res.json();
    for (const header of [
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-allow-methods',
      'access-control-allow-headers',
    ]) {
      assert.equal(res.headers.get(header), null, `${header} ne doit jamais etre emis`);
    }
  });

  test('la garde passe avant le routage : meme une route inconnue est refusee', async () => {
    const res = await rawRequest({ path: '/route-inconnue', headers: { Host: 'evil.example' } });
    assert.equal(res.status, 403);
  });
});

/* ------------------------------------------------------------------ */
/* Ouverture de document                                               */
/* ------------------------------------------------------------------ */

describe('/api/open', () => {
  test('ouvre le PDF de test', async () => {
    const body = await openTestPdf();
    assert.equal(body.pageCount, TEST_PDF_PAGES);
    assert.equal(body.base, TEST_PDF_BASE);
    assert.equal(body.name, '2020-Scrum-Guide-French.pdf');
    assert.equal(typeof body.docId, 'string');
    assert.ok(body.docId.length > 10);
  });

  test('chemin inexistant -> 400', async () => {
    const res = await postJson('/api/open', { path: '/tmp/il-n-existe-pas-42.pdf' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, 'string');
    assert.ok(body.error.length > 0);
  });

  test('chemin manquant -> 400', async () => {
    const res = await postJson('/api/open', {});
    assert.equal(res.status, 400);
    assert.equal(typeof (await res.json()).error, 'string');
  });

  test('fichier non-PDF -> 400', async () => {
    const notPdf = path.join(scratch, 'pas-un-pdf.pdf');
    await fsp.writeFile(notPdf, 'Bonjour, je ne suis pas un PDF.\n');
    const res = await postJson('/api/open', { path: notPdf });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /PDF/);
  });

  test('dossier au lieu d un fichier -> 400', async () => {
    const res = await postJson('/api/open', { path: scratch });
    assert.equal(res.status, 400);
  });
});

/* ------------------------------------------------------------------ */
/* Upload                                                              */
/* ------------------------------------------------------------------ */

describe('/api/upload', () => {
  test('accepte un vrai PDF et decode le nom accentue', async () => {
    const bytes = await fsp.readFile(TEST_PDF);
    const res = await api('/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'x-filename': encodeURIComponent('Présentation été 2024.pdf'),
      },
      body: bytes,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pageCount, TEST_PDF_PAGES);
    assert.equal(body.name, 'Présentation été 2024.pdf');
    assert.equal(body.base, 'Présentation été 2024');
  });

  test('corps non-PDF -> 400', async () => {
    const res = await api('/api/upload', {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent('faux.pdf') },
      body: Buffer.from('ceci est du texte, pas un PDF'),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /PDF/);
  });

  test('corps vide -> 400', async () => {
    const res = await api('/api/upload', {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent('vide.pdf') },
      body: Buffer.alloc(0),
    });
    assert.equal(res.status, 400);
    assert.equal(typeof (await res.json()).error, 'string');
  });
});

/* ------------------------------------------------------------------ */
/* Miniatures                                                          */
/* ------------------------------------------------------------------ */

describe('/api/thumb', () => {
  test('sert une miniature JPEG', async () => {
    const doc = await openTestPdf();
    const res = await api(`/api/thumb/${doc.docId}/1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.match(res.headers.get('cache-control') ?? '', /immutable/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.length > 500, 'miniature vide');
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
  });

  test('docId inconnu -> 404', async () => {
    const res = await api('/api/thumb/inconnu/1');
    assert.equal(res.status, 404);
  });

  test('page hors bornes -> 404', async () => {
    const doc = await openTestPdf();
    const res = await api(`/api/thumb/${doc.docId}/999`);
    assert.equal(res.status, 404);
  });

  test('echec du rendu -> 500 avec le vrai message, pas un 404 muet', async () => {
    const doc = await openTestPdf();
    const stored = sessions.getDocument(doc.docId);
    assert.ok(stored, 'le document doit etre enregistre');
    // On simule l'echec de la passe miniatures : c'est exactement ce que fait
    // startThumbnails quand pdftoppm sort en erreur.
    stored.thumbError = new Error('pdftoppm a rendu le code 1 : Permission denied');
    stored.thumbsDone = true;

    const res = await api(`/api/thumb/${doc.docId}/1`);
    assert.equal(res.status, 500, 'un 404 laisserait 180 images cassees sans explication');
    const body = await res.json();
    assert.match(body.error, /miniatures/i);
    assert.match(body.error, /Permission denied/, 'le message reel doit atteindre le frontend');
    assert.doesNotMatch(body.error, /Erreur interne du serveur/);
  });

  test('echec du rendu : toutes les pages repondent 500, pas seulement la premiere', async () => {
    const doc = await openTestPdf();
    const stored = sessions.getDocument(doc.docId);
    stored.thumbError = new Error('rendu interrompu');
    stored.thumbsDone = true;
    for (const page of [1, 2, TEST_PDF_PAGES]) {
      const res = await api(`/api/thumb/${doc.docId}/${page}`);
      assert.equal(res.status, 500, `page ${page}`);
      await res.json();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Validation de l'export                                              */
/* ------------------------------------------------------------------ */

describe('/api/export — validation', () => {
  test('pages vides -> 400', async () => {
    const doc = await openTestPdf();
    const res = await postJson('/api/export', { docId: doc.docId, pages: [], dest: scratch });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /page/i);
  });

  test('dest inexistant -> 400', async () => {
    const doc = await openTestPdf();
    const res = await postJson('/api/export', {
      docId: doc.docId,
      pages: [1],
      dest: path.join(scratch, 'dossier-absent'),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /destination/i);
  });

  test('dest qui est un fichier -> 400', async () => {
    const doc = await openTestPdf();
    const file = path.join(scratch, 'destination.txt');
    await fsp.writeFile(file, 'x');
    const res = await postJson('/api/export', { docId: doc.docId, pages: [1], dest: file });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /dossier/i);
  });

  test('dest non inscriptible -> 400', async () => {
    const doc = await openTestPdf();
    const locked = path.join(scratch, 'verrouille');
    await fsp.mkdir(locked, { recursive: true });
    await fsp.chmod(locked, 0o500);
    try {
      const res = await postJson('/api/export', { docId: doc.docId, pages: [1], dest: locked });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /écriture/);
    } finally {
      await fsp.chmod(locked, 0o700);
    }
  });

  test('docId inconnu -> 400', async () => {
    const res = await postJson('/api/export', {
      docId: 'ce-docid-n-existe-pas',
      pages: [1],
      dest: scratch,
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Document/);
  });

  test('exportId inconnu sur le flux SSE -> 404', async () => {
    const res = await api('/api/export/inconnu/events');
    assert.equal(res.status, 404);
    await res.text();
  });
});

/* ------------------------------------------------------------------ */
/* Export de bout en bout                                              */
/* ------------------------------------------------------------------ */

describe('export complet', () => {
  test('exporte 1, 3 et 5 puis resiste a un second passage', async () => {
    const doc = await openTestPdf();
    const dest = path.join(scratch, 'export-e2e');
    await fsp.mkdir(dest, { recursive: true });

    const pages = [1, 3, 5];
    // 15 pages -> padWidth = 2
    const expected = [
      `${TEST_PDF_BASE}-slide-01.png`,
      `${TEST_PDF_BASE}-slide-03.png`,
      `${TEST_PDF_BASE}-slide-05.png`,
    ];

    const events = await runExport({ docId: doc.docId, pages, dest, dpi: 150, format: 'png' });

    const done = events.find((e) => e.type === 'done');
    const failure = events.find((e) => e.type === 'error');
    assert.equal(failure, undefined, `erreur SSE : ${failure?.message}`);
    assert.ok(done, 'evenement done absent');
    assert.equal(done.files.length, 3);
    assert.ok(Array.isArray(done.warnings));

    // Progression : monotone, exacte, terminee a total.
    const progress = events.filter((e) => e.type === 'progress');
    assert.equal(progress.length, pages.length);
    let previous = 0;
    for (const event of progress) {
      assert.equal(event.total, pages.length);
      assert.ok(event.done > previous, 'la progression doit etre strictement croissante');
      previous = event.done;
      assert.ok(pages.includes(event.page));
    }
    assert.equal(previous, pages.length);

    // Noms exacts sur le disque.
    const written = (await fsp.readdir(dest)).sort();
    assert.deepEqual(written, expected);
    assert.deepEqual(done.files.map((f) => path.basename(f)).sort(), expected);

    // Aucun residu, et des PNG non vides.
    assert.equal(written.filter((n) => n.startsWith('.slideshot-')).length, 0);
    const firstPass = new Map();
    for (const name of expected) {
      const bytes = await fsp.readFile(path.join(dest, name));
      assert.ok(bytes.length > 1000, `${name} est vide`);
      assert.equal(bytes.subarray(0, 8).toString('latin1'), '\x89PNG\r\n\x1a\n');
      firstPass.set(name, bytes);
    }

    // --- Second passage vers le meme dossier : rien n'est ecrase. -----
    const events2 = await runExport({ docId: doc.docId, pages, dest, dpi: 150, format: 'png' });
    const done2 = events2.find((e) => e.type === 'done');
    assert.ok(done2, 'evenement done absent au second passage');
    assert.equal(done2.files.length, 3);

    const expected2 = expected.map((n) => n.replace(/\.png$/, '-2.png'));
    assert.deepEqual(done2.files.map((f) => path.basename(f)).sort(), expected2.slice().sort());

    const after = (await fsp.readdir(dest)).sort();
    assert.deepEqual(after, [...expected, ...expected2].sort());
    assert.equal(after.filter((n) => n.startsWith('.slideshot-')).length, 0);

    // Les fichiers du premier passage sont intacts, octet pour octet.
    for (const [name, bytes] of firstPass) {
      const current = await fsp.readFile(path.join(dest, name));
      assert.ok(bytes.equals(current), `${name} a ete ecrase`);
    }
    // Le second passage a bien produit des images.
    for (const name of expected2) {
      const bytes = await fsp.readFile(path.join(dest, name));
      assert.ok(bytes.length > 1000, `${name} est vide`);
    }

    assert.ok(done2.warnings.some((w) => /renomm/i.test(w)), 'warning de collision attendu');
  });

  test('un export ne peut etre consomme qu une fois', async () => {
    const doc = await openTestPdf();
    const dest = path.join(scratch, 'export-unique');
    await fsp.mkdir(dest, { recursive: true });
    const res = await postJson('/api/export', {
      docId: doc.docId,
      pages: [2],
      dest,
      dpi: 100,
    });
    const { exportId } = await res.json();
    const events = await consumeSse(`/api/export/${exportId}/events`);
    assert.ok(events.some((e) => e.type === 'done'));

    const again = await api(`/api/export/${exportId}/events`);
    assert.equal(again.status, 404);
    await again.text();
  });

  test('ne balaie que les residus de son propre exportId', async () => {
    const doc = await openTestPdf();
    const dest = path.join(scratch, 'export-residus');
    await fsp.mkdir(dest, { recursive: true });

    // Un fichier de l'utilisateur, et le residu d'un AUTRE export.
    const userFile = path.join(dest, 'photo-de-vacances.png');
    const otherResidue = path.join(dest, '.slideshot-un-autre-export-01.png');
    await fsp.writeFile(userFile, 'contenu utilisateur');
    await fsp.writeFile(otherResidue, 'residu etranger');

    const res = await postJson('/api/export', { docId: doc.docId, pages: [2], dest, dpi: 100 });
    const { exportId } = await res.json();

    // Un residu de CET export, laisse par un plantage anterieur.
    const ownResidue = path.join(dest, `.slideshot-${exportId}-999.png`);
    await fsp.writeFile(ownResidue, 'residu a nettoyer');

    const events = await consumeSse(`/api/export/${exportId}/events`);
    assert.ok(events.some((e) => e.type === 'done'));

    assert.equal(fs.existsSync(ownResidue), false, 'le residu de cet export doit disparaitre');
    assert.equal(fs.existsSync(otherResidue), true, "le residu d'un autre export ne doit pas etre touche");
    assert.equal(await fsp.readFile(userFile, 'utf8'), 'contenu utilisateur');
  });

  test('un echec en cours de rendu emet error et ne laisse aucun residu', async () => {
    const doc = await openTestPdf();
    const dest = path.join(scratch, 'export-echec');
    await fsp.mkdir(dest, { recursive: true });

    const res = await postJson('/api/export', { docId: doc.docId, pages: [1, 2, 3], dest, dpi: 100 });
    assert.equal(res.status, 200);
    const { exportId } = await res.json();

    // La destination devient non inscriptible entre la validation et le rendu.
    await fsp.chmod(dest, 0o500);
    let events;
    try {
      events = await consumeSse(`/api/export/${exportId}/events`);
    } finally {
      await fsp.chmod(dest, 0o700);
    }

    const failure = events.find((e) => e.type === 'error');
    assert.ok(failure, `evenement error attendu, recu : ${JSON.stringify(events)}`);
    assert.equal(typeof failure.message, 'string');
    assert.ok(failure.message.length > 0);
    assert.equal(events.some((e) => e.type === 'done'), false);

    const written = await fsp.readdir(dest);
    assert.deepEqual(written, [], `le dossier doit rester propre, trouve : ${written}`);

    // Le serveur survit a l'echec.
    const health = await api('/api/health');
    assert.equal(health.status, 200);
    await health.json();
  });

  test('deconnexion du client SSE : le travail s arrete et nettoie', async () => {
    const doc = await openTestPdf();
    const dest = path.join(scratch, 'export-abandon');
    await fsp.mkdir(dest, { recursive: true });

    const res = await postJson('/api/export', {
      docId: doc.docId,
      pages: Array.from({ length: TEST_PDF_PAGES }, (_, i) => i + 1),
      dest,
      dpi: 150,
    });
    const { exportId } = await res.json();

    const controller = new AbortController();
    const stream = await api(`/api/export/${exportId}/events`, { signal: controller.signal });
    // On coupe la connexion des le premier signe de vie.
    controller.abort();
    await stream.body.cancel().catch(() => {});

    // Le lot en vol se termine, puis le balayage passe : le dossier finit propre.
    const deadline = Date.now() + 30_000;
    let stableFor = 0;
    for (;;) {
      const names = await fsp.readdir(dest);
      const residue = names.filter((n) => n.startsWith('.slideshot-'));
      if (residue.length === 0) stableFor += 1;
      else stableFor = 0;
      if (stableFor >= 4) break;
      assert.ok(Date.now() < deadline, `residus persistants : ${residue}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const health = await api('/api/health');
    assert.equal(health.status, 200);
    await health.json();
  });

  test('exporte plusieurs lots en parallele sans perdre de page', async () => {
    const doc = await openTestPdf();
    const dest = path.join(scratch, 'export-lots');
    await fsp.mkdir(dest, { recursive: true });

    const pages = Array.from({ length: TEST_PDF_PAGES }, (_, i) => i + 1);
    const events = await runExport({ docId: doc.docId, pages, dest, dpi: 72, format: 'png' });

    const done = events.find((e) => e.type === 'done');
    assert.ok(done, `done absent : ${JSON.stringify(events.slice(-2))}`);
    assert.equal(done.files.length, TEST_PDF_PAGES);

    const progress = events.filter((e) => e.type === 'progress');
    assert.equal(progress.length, TEST_PDF_PAGES);
    assert.deepEqual(
      progress.map((e) => e.done),
      pages,
      'la progression doit rester monotone malgre les lots paralleles',
    );
    assert.deepEqual(
      progress.map((e) => e.page).sort((a, b) => a - b),
      pages,
    );

    const written = (await fsp.readdir(dest)).sort();
    assert.equal(written.length, TEST_PDF_PAGES);
    assert.equal(written[0], `${TEST_PDF_BASE}-slide-01.png`);
    assert.equal(written.at(-1), `${TEST_PDF_BASE}-slide-15.png`);
    assert.equal(written.filter((n) => n.startsWith('.slideshot-')).length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Messages d'erreur 5xx : ce qui atteint l'utilisateur                */
/*                                                                     */
/* Les 5xx sont masquees derriere « Erreur interne du serveur. » : sans */
/* cela une trace ou un chemin interne partirait au navigateur. Mais    */
/* certains 5xx portent un message ECRIT POUR L'UTILISATEUR — au        */
/* premier chef celui qui explique comment installer poppler, qui vise  */
/* exactement le scenario de ce projet : le dossier est transmis a      */
/* quelqu'un qui ne l'a pas. Ceux-la doivent passer tels quels.         */
/* ------------------------------------------------------------------ */

describe('erreurs 5xx — message utilisateur contre message generique', () => {
  let sansPoppler;
  let sansPopplerOrigin;
  let sansPopplerDir;

  /**
   * Un vrai serveur, demarre comme sur la machine de quelqu'un qui n'a pas
   * poppler. On ne peut pas y arriver par le PATH seul : `findPoppler` se
   * rabat sur /opt/homebrew/bin, /usr/local/bin et /usr/bin. On copie donc le
   * projet dans un dossier temporaire ou `lib/poppler.js` reexporte le vrai
   * module a une exception pres : `findPoppler` ne trouve rien.
   *
   * Le PATH du serveur enfant ne contient qu'un faux `open` qui echoue, et
   * pas d'`osascript` : cela donne les deux cas a distinguer, sans truquage
   * de l'etat interne — un message redige (le Finder) et un rejet fortuit
   * (`spawn osascript ENOENT`).
   */
  before(async () => {
    // `realpath` : sur macOS os.tmpdir() rend /var/... alors que `import.meta.url`
    // rend /private/var/... ; sans cela server.js ne se reconnait pas comme point
    // d'entree et sort sans rien faire.
    sansPopplerDir = await fsp.realpath(
      await fsp.mkdtemp(path.join(os.tmpdir(), 'slide-shot-sans-poppler-')),
    );
    const root = fileURLToPath(new URL('..', import.meta.url));

    await fsp.writeFile(
      path.join(sansPopplerDir, 'package.json'),
      JSON.stringify({ name: 'slide-shot-sans-poppler', type: 'module', private: true }),
    );
    await fsp.copyFile(path.join(root, 'server.js'), path.join(sansPopplerDir, 'server.js'));
    await fsp.mkdir(path.join(sansPopplerDir, 'lib'));
    for (const name of await fsp.readdir(path.join(root, 'lib'))) {
      if (!name.endsWith('.js') || name === 'poppler.js') continue;
      await fsp.copyFile(path.join(root, 'lib', name), path.join(sansPopplerDir, 'lib', name));
    }
    const realPoppler = new URL('../lib/poppler.js', import.meta.url).href;
    await fsp.writeFile(
      path.join(sansPopplerDir, 'lib', 'poppler.js'),
      `export * from ${JSON.stringify(realPoppler)};\n` +
        'export function findPoppler() {\n  return { pdftoppm: null, pdfinfo: null };\n}\n',
    );

    const fakeBin = path.join(sansPopplerDir, 'bin');
    await fsp.mkdir(fakeBin);
    await fsp.writeFile(
      path.join(fakeBin, 'open'),
      '#!/bin/sh\necho "kLSNoExecutableErr" 1>&2\nexit 1\n',
      { mode: 0o755 },
    );

    sansPoppler = spawn(process.execPath, [path.join(sansPopplerDir, 'server.js')], {
      env: {
        ...process.env,
        PATH: fakeBin,
        SLIDESHOT_PORT: '0',
        SLIDESHOT_NO_OPEN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    sansPopplerOrigin = await new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      const timer = setTimeout(() => reject(new Error(`serveur muet : ${out}${err}`)), 20_000);
      sansPoppler.stderr.on('data', (chunk) => {
        err += chunk;
      });
      sansPoppler.stdout.on('data', (chunk) => {
        out += chunk;
        const match = /(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      sansPoppler.on('error', reject);
      sansPoppler.on('exit', (code) => reject(new Error(`serveur mort (${code}) : ${out}${err}`)));
    });
  });

  after(async () => {
    if (sansPoppler && sansPoppler.exitCode === null) {
      const dead = new Promise((resolve) => sansPoppler.once('exit', resolve));
      sansPoppler.kill('SIGTERM');
      await Promise.race([dead, new Promise((r) => setTimeout(r, 5000))]);
      if (sansPoppler.exitCode === null) sansPoppler.kill('SIGKILL');
    }
    if (sansPopplerDir) await fsp.rm(sansPopplerDir, { recursive: true, force: true });
  });

  /** POST sur le serveur sans poppler. Le delai evite toute attente infinie. */
  async function postSansPoppler(pathname, body) {
    return fetch(`${sansPopplerOrigin}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
  }

  test('poppler introuvable : /api/open rend le texte d installation, pas « Erreur interne »', async () => {
    const health = await fetch(`${sansPopplerOrigin}/api/health`);
    assert.equal((await health.json()).ok, false, 'ce serveur doit ignorer poppler');

    const res = await postSansPoppler('/api/open', { path: TEST_PDF });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.doesNotMatch(
      body.error,
      /Erreur interne du serveur/,
      "c'est le message que l'utilisateur sans poppler lisait a la place des instructions",
    );
    assert.match(body.error, /poppler est introuvable/);
    assert.match(body.error, /npm run setup/, "l'utilisateur doit lire quoi taper");
    assert.match(body.error, /brew install poppler/);
  });

  test('poppler introuvable : /api/upload rend le meme texte', async () => {
    const res = await fetch(`${sansPopplerOrigin}/api/upload`, {
      method: 'POST',
      headers: { 'x-filename': 'deck.pdf', 'Content-Type': 'application/octet-stream' },
      body: await fsp.readFile(TEST_PDF),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /poppler est introuvable/);
  });

  test('echec du Finder : le message redige atteint l utilisateur', async () => {
    const res = await postSansPoppler('/api/reveal', { path: TEST_PDF });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.doesNotMatch(body.error, /Erreur interne du serveur/);
    assert.match(body.error, /Impossible de révéler/);
    assert.ok(body.error.includes(TEST_PDF), 'le message doit nommer le chemin concerne');
    assert.match(body.error, /kLSNoExecutableErr/, 'la raison reelle doit etre reportee');
  });

  test('echec technique fortuit : le message reste generique', async () => {
    // `osascript` absent du PATH : le rejet est un `spawn ... ENOENT` de Node,
    // pas une phrase ecrite pour l'utilisateur. Il ne doit pas sortir tel quel.
    const res = await postSansPoppler('/api/choose-folder', {});
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'Erreur interne du serveur.');
    assert.doesNotMatch(body.error, /ENOENT/);
    assert.doesNotMatch(body.error, /osascript/);
    assert.doesNotMatch(body.error, /\//, 'aucun chemin interne ne doit fuiter');
  });
});
