/**
 * slide-shot — serveur HTTP local.
 *
 * Ecoute sur 127.0.0.1 uniquement. Aucune dependance npm : `node:http` a la main.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { findPoppler, getPageCount, renderRange, killActiveChildren } from './lib/poppler.js';
import { sanitizeBase } from './lib/naming.js';
import { chooseFile, chooseFolder, reveal } from './lib/finder.js';
import * as sessions from './lib/sessions.js';
import { runExportJob, CONCURRENCY } from './lib/export-job.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4321;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 Go
const MAX_JSON_BYTES = 1024 * 1024;
const THUMB_DPI = 30;
const THUMB_PREFIX = 'thumb';
const THUMB_POLL_MS = 100;
const THUMB_TIMEOUT_MS = 60_000;
const DEFAULT_DPI = 300;

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {number} status
 * @param {string} message  message francais destine a l'utilisateur
 * @param {{expose?:boolean}} [options] `expose` : montrer le message tel quel
 *   meme en 5xx (sinon les 5xx sont masquees derriere « Erreur interne »).
 */
function httpError(status, message, { expose = false } = {}) {
  const err = new Error(message);
  err.status = status;
  err.expose = expose;
  return err;
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, 'Fichier trop volumineux (2 Go maximum).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_JSON_BYTES) throw httpError(413, 'Corps de requête trop volumineux.');
  const buf = await readBody(req, MAX_JSON_BYTES);
  if (buf.length === 0) return {};
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw httpError(400, 'Corps de requête JSON invalide.');
  }
}

const PDF_MAGIC = '%PDF-';

function bufferLooksLikePdf(buf) {
  return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === PDF_MAGIC;
}

async function fileLooksLikePdf(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(5);
    const { bytesRead } = await handle.read(buf, 0, 5, 0);
    return bytesRead === 5 && bufferLooksLikePdf(buf);
  } finally {
    await handle.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Poppler                                                             */
/* ------------------------------------------------------------------ */

let poppler = { pdftoppm: null, pdfinfo: null };

/**
 * Vrai pendant l'arret. Consulte par les exports en cours au meme titre qu'une
 * deconnexion du client : un lot ne doit plus etre lance apres le balayage,
 * sinon il ecrit des residus que plus personne ne nettoiera.
 */
let shuttingDown = false;

function refreshPoppler() {
  try {
    poppler = findPoppler() ?? { pdftoppm: null, pdfinfo: null };
  } catch {
    poppler = { pdftoppm: null, pdfinfo: null };
  }
  return poppler;
}

function requirePoppler() {
  if (!poppler.pdftoppm || !poppler.pdfinfo) refreshPoppler();
  if (!poppler.pdftoppm || !poppler.pdfinfo) {
    // `expose` : c'est LE message du scenario pour lequel ce projet existe —
    // quelqu'un recoit le dossier sans avoir poppler. Il doit lire comment
    // l'installer, pas « Erreur interne du serveur ».
    throw httpError(
      503,
      "poppler est introuvable. Installez-le avec « npm run setup » ou « brew install poppler ».",
      { expose: true },
    );
  }
  return poppler;
}

/* ------------------------------------------------------------------ */
/* Documents et miniatures                                             */
/* ------------------------------------------------------------------ */

async function openDocument({ pdfPath, name, temporary }) {
  const { pdfinfo } = requirePoppler();
  let pageCount;
  try {
    pageCount = await getPageCount(pdfinfo, pdfPath);
  } catch {
    throw httpError(400, 'PDF illisible ou endommagé.');
  }
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw httpError(400, 'PDF illisible : nombre de pages indéterminé.');
  }
  const doc = sessions.registerDocument({
    pdfPath,
    name,
    base: sanitizeBase(name),
    pageCount,
    temporary,
  });
  startThumbnails(doc);
  return { docId: doc.docId, name: doc.name, base: doc.base, pageCount: doc.pageCount };
}

/** Rendu des miniatures en tache de fond : une seule invocation sur tout le document. */
function startThumbnails(doc) {
  if (!poppler.pdftoppm) {
    doc.thumbError = new Error('poppler est introuvable.');
    doc.thumbsDone = true;
    return;
  }
  renderRange({
    pdftoppmPath: poppler.pdftoppm,
    pdfPath: doc.pdfPath,
    outDir: doc.thumbDir,
    prefix: THUMB_PREFIX,
    first: 1,
    last: doc.pageCount,
    dpi: THUMB_DPI,
    format: 'jpeg',
  })
    .then((items) => {
      doc.thumbFiles = new Map(items.map((item) => [item.page, item.path]));
    })
    .catch((err) => {
      doc.thumbError = err;
    })
    .finally(() => {
      doc.thumbsDone = true;
    });
}

/**
 * Cherche la miniature d'une page. Renvoie null tant qu'elle n'est pas
 * completement ecrite : `pdftoppm` produit les fichiers dans l'ordre, la page N
 * n'est sure que si la page N+1 existe deja ou si le rendu est termine.
 */
async function findThumb(doc, page) {
  if (doc.thumbFiles) return doc.thumbFiles.get(page) ?? null;
  let names;
  try {
    names = await fsp.readdir(doc.thumbDir);
  } catch {
    return null;
  }
  const found = new Map();
  for (const name of names) {
    const match = /^thumb-(\d+)\.(?:jpe?g)$/i.exec(name);
    if (match) found.set(Number(match[1]), path.join(doc.thumbDir, name));
  }
  const hit = found.get(page);
  if (!hit) return null;
  if (doc.thumbsDone || found.has(page + 1)) return hit;
  return null;
}

/* ------------------------------------------------------------------ */
/* Fichiers statiques                                                  */
/* ------------------------------------------------------------------ */

const STATIC_FILES = new Map([
  ['/', { file: 'public/index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'public/index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'public/app.js', type: 'text/javascript; charset=utf-8' }],
  ['/style.css', { file: 'public/style.css', type: 'text/css; charset=utf-8' }],
  // Le frontend importe le meme parseur que le serveur.
  ['/lib/pages.js', { file: 'lib/pages.js', type: 'text/javascript; charset=utf-8' }],
]);

async function serveStatic(ctx) {
  const entry = STATIC_FILES.get(ctx.pathname);
  if (!entry) throw httpError(404, 'Ressource introuvable.');
  const filePath = path.join(ROOT, entry.file);
  let body;
  try {
    body = await fsp.readFile(filePath);
  } catch {
    throw httpError(404, `Fichier absent : ${entry.file}.`);
  }
  ctx.res.writeHead(200, {
    'Content-Type': entry.type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  ctx.res.end(body);
}

/* ------------------------------------------------------------------ */
/* Handlers d'API                                                      */
/* ------------------------------------------------------------------ */

async function handleHealth(ctx) {
  const found = refreshPoppler();
  sendJson(ctx.res, 200, {
    ok: Boolean(found.pdftoppm && found.pdfinfo),
    pdftoppm: found.pdftoppm ?? null,
    pdfinfo: found.pdfinfo ?? null,
  });
}

async function handleChooseFile(ctx) {
  const body = await readJsonBody(ctx.req);
  const chosen = await chooseFile(typeof body.defaultPath === 'string' ? body.defaultPath : undefined);
  if (!chosen) return sendJson(ctx.res, 200, { cancelled: true });
  sendJson(ctx.res, 200, { path: chosen });
}

async function handleChooseFolder(ctx) {
  const body = await readJsonBody(ctx.req);
  const chosen = await chooseFolder(
    typeof body.defaultPath === 'string' ? body.defaultPath : undefined,
  );
  if (!chosen) return sendJson(ctx.res, 200, { cancelled: true });
  sendJson(ctx.res, 200, { path: chosen });
}

async function handleOpen(ctx) {
  const body = await readJsonBody(ctx.req);
  const target = typeof body.path === 'string' ? body.path.trim() : '';
  if (!target) throw httpError(400, 'Chemin du PDF manquant.');

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    throw httpError(400, `Fichier introuvable : ${target}`);
  }
  if (!stat.isFile()) throw httpError(400, "Ce chemin n'est pas un fichier.");
  try {
    await fsp.access(target, fs.constants.R_OK);
  } catch {
    throw httpError(400, 'Fichier illisible : vérifiez les autorisations.');
  }
  if (!(await fileLooksLikePdf(target))) {
    throw httpError(400, "Ce fichier n'est pas un PDF.");
  }

  const info = await openDocument({
    pdfPath: path.resolve(target),
    name: path.basename(target),
    temporary: false,
  });
  sendJson(ctx.res, 200, info);
}

async function handleUpload(ctx) {
  const declared = Number(ctx.req.headers['content-length'] ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw httpError(413, 'Fichier trop volumineux (2 Go maximum).');

  const raw = ctx.req.headers['x-filename'];
  let name = 'document.pdf';
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      name = decodeURIComponent(raw);
    } catch {
      name = raw;
    }
  }
  name = path.basename(name.replace(/\\/g, '/')) || 'document.pdf';

  const body = await readBody(ctx.req, MAX_UPLOAD_BYTES);
  if (body.length === 0) throw httpError(400, 'Fichier vide.');
  if (!bufferLooksLikePdf(body)) throw httpError(400, "Ce fichier n'est pas un PDF.");

  const pdfPath = path.join(sessions.uploadsDir(), `${randomUUID()}.pdf`);
  await fsp.writeFile(pdfPath, body);

  try {
    const info = await openDocument({ pdfPath, name, temporary: true });
    sendJson(ctx.res, 200, info);
  } catch (err) {
    await fsp.rm(pdfPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Traduit l'echec du rendu des miniatures en reponse HTTP parlante.
 * `expose` : le vrai message doit atteindre le frontend, sinon l'echec reste
 * invisible et l'utilisateur ne comprend pas pourquoi sa grille est vide.
 */
function thumbFailure(err) {
  const detail = err?.message ? String(err.message) : 'erreur inconnue';
  return httpError(500, `Le rendu des miniatures a échoué : ${detail}`, { expose: true });
}

async function handleThumb(ctx) {
  const docId = decodeURIComponent(ctx.params.docId);
  const page = Number(ctx.params.page);
  const doc = sessions.getDocument(docId);
  if (!doc) throw httpError(404, 'Document introuvable.');
  if (!Number.isInteger(page) || page < 1 || page > doc.pageCount) {
    throw httpError(404, 'Page inexistante.');
  }
  // Le rendu des miniatures a echoue : un 404 muet laisserait l'utilisateur
  // devant 180 images cassees sans explication. On dit ce qui s'est passe.
  if (doc.thumbError) throw thumbFailure(doc.thumbError);

  const deadline = Date.now() + THUMB_TIMEOUT_MS;
  for (;;) {
    const found = await findThumb(doc, page);
    if (found) {
      let body;
      try {
        body = await fsp.readFile(found);
      } catch {
        throw httpError(404, 'Miniature introuvable.');
      }
      ctx.res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': body.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      ctx.res.end(body);
      return;
    }
    // Le rendu peut echouer pendant qu'on attend la miniature.
    if (doc.thumbError) throw thumbFailure(doc.thumbError);
    if (doc.thumbsDone) throw httpError(404, 'Miniature indisponible.');
    if (Date.now() >= deadline) throw httpError(404, 'Miniature indisponible (délai dépassé).');
    if (ctx.res.writableEnded || ctx.req.destroyed) return;
    await new Promise((resolve) => setTimeout(resolve, THUMB_POLL_MS));
  }
}

async function handleExportCreate(ctx) {
  const body = await readJsonBody(ctx.req);
  const doc = sessions.getDocument(typeof body.docId === 'string' ? body.docId : '');
  if (!doc) throw httpError(400, 'Document introuvable : rouvrez le PDF.');

  // Pages : entiers 1-indexes, dans les bornes, tries et dedoublonnes.
  const warnings = [];
  const raw = Array.isArray(body.pages) ? body.pages : [];
  const seen = new Set();
  let outOfRange = 0;
  for (const value of raw) {
    const page = Number(value);
    if (!Number.isInteger(page)) continue;
    if (page < 1 || page > doc.pageCount) {
      outOfRange += 1;
      continue;
    }
    seen.add(page);
  }
  if (outOfRange > 0) {
    warnings.push(
      `${outOfRange} page(s) hors du document ont été ignorées (le document en compte ${doc.pageCount}).`,
    );
  }
  const pages = [...seen].sort((a, b) => a - b);
  if (pages.length === 0) throw httpError(400, 'Aucune page sélectionnée.');

  const dest = typeof body.dest === 'string' ? body.dest.trim() : '';
  if (!dest) throw httpError(400, 'Dossier de destination manquant.');
  let stat;
  try {
    stat = await fsp.stat(dest);
  } catch {
    throw httpError(400, `Dossier de destination introuvable : ${dest}`);
  }
  if (!stat.isDirectory()) throw httpError(400, "La destination n'est pas un dossier.");
  try {
    await fsp.access(dest, fs.constants.W_OK);
  } catch {
    throw httpError(400, "Le dossier de destination n'est pas accessible en écriture.");
  }

  const format = body.format === 'jpeg' || body.format === 'jpg' ? 'jpeg' : 'png';
  const dpi = Number.isFinite(Number(body.dpi)) && Number(body.dpi) > 0
    ? Math.min(1200, Math.round(Number(body.dpi)))
    : DEFAULT_DPI;

  const job = sessions.registerExport({
    docId: doc.docId,
    pdfPath: doc.pdfPath,
    pageCount: doc.pageCount,
    base: doc.base,
    pages,
    dest: path.resolve(dest),
    dpi,
    format,
    warnings,
  });
  sendJson(ctx.res, 200, { exportId: job.exportId });
}

async function handleExportEvents(ctx) {
  const { req, res } = ctx;
  const exportId = decodeURIComponent(ctx.params.exportId);
  const job = sessions.takeExport(exportId);
  if (!job) throw httpError(404, 'Export introuvable ou déjà consommé.');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  const emit = (payload) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // A partir d'ici, l'export ecrit des `.slideshot-*` dans un dossier de
  // l'utilisateur : on memorise `dest` pour pouvoir le balayer si le serveur
  // s'arrete en plein rendu, et on le journalise pour le demarrage suivant.
  sessions.beginActiveExport({ exportId: job.exportId, dest: job.dest });

  try {
    const { pdftoppm } = requirePoppler();
    const result = await runExportJob(
      { ...job, pdftoppmPath: pdftoppm },
      { emit, isAborted: () => aborted || shuttingDown },
    );
    if (!aborted && !result.aborted) {
      emit({
        type: 'done',
        files: result.files,
        warnings: [...(job.warnings ?? []), ...result.warnings],
      });
    }
  } catch (err) {
    if (!aborted) {
      emit({ type: 'error', message: `L'export a échoué : ${err?.message ?? 'erreur inconnue'}` });
    }
  } finally {
    sessions.endActiveExport(job.exportId);
    if (!res.writableEnded) res.end();
  }
}

async function handleReveal(ctx) {
  const body = await readJsonBody(ctx.req);
  const target = typeof body.path === 'string' ? body.path.trim() : '';
  if (!target) throw httpError(400, 'Chemin manquant.');
  if (!fs.existsSync(target)) throw httpError(400, `Chemin introuvable : ${target}`);
  await reveal(target);
  sendJson(ctx.res, 200, { ok: true });
}

/* ------------------------------------------------------------------ */
/* Routeur                                                             */
/* ------------------------------------------------------------------ */

function compilePattern(pattern) {
  const names = [];
  const source = pattern
    .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
  return { regex: new RegExp(`^${source}$`), names };
}

function route(method, pattern, handler) {
  return { method, pattern, handler, ...compilePattern(pattern) };
}

const ROUTES = [
  route('GET', '/', serveStatic),
  route('GET', '/index.html', serveStatic),
  route('GET', '/app.js', serveStatic),
  route('GET', '/style.css', serveStatic),
  route('GET', '/lib/pages.js', serveStatic),
  route('GET', '/api/health', handleHealth),
  route('POST', '/api/choose-file', handleChooseFile),
  route('POST', '/api/choose-folder', handleChooseFolder),
  route('POST', '/api/open', handleOpen),
  route('POST', '/api/upload', handleUpload),
  route('GET', '/api/thumb/:docId/:page', handleThumb),
  route('POST', '/api/export', handleExportCreate),
  route('GET', '/api/export/:exportId/events', handleExportEvents),
  route('POST', '/api/reveal', handleReveal),
];

function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const entry of ROUTES) {
    const match = entry.regex.exec(pathname);
    if (!match) continue;
    pathMatched = true;
    if (entry.method !== method) continue;
    const params = {};
    entry.names.forEach((name, index) => {
      params[name] = match[index + 1];
    });
    return { entry, params };
  }
  return pathMatched ? { methodMismatch: true } : null;
}

/* ------------------------------------------------------------------ */
/* Garde d'origine                                                     */
/* ------------------------------------------------------------------ */

/**
 * Seules ces autorites sont acceptees, sur le port reellement ecoute.
 * Refuser tout le reste ferme deux portes d'un coup :
 * - le DNS rebinding (un nom d'attaquant qui resout vers 127.0.0.1 arrive
 *   avec son propre `Host`, jamais avec `127.0.0.1:<port>`) ;
 * - les requetes simples cross-site (POST JSON sans preflight), qui pourraient
 *   sinon faire surgir les dialogues macOS natifs depuis n'importe quel onglet.
 * Aucun en-tete CORS n'est emis : rien n'est partage avec une autre origine.
 */
function isAllowedAuthority(authority, port) {
  if (typeof authority !== 'string' || !Number.isInteger(port)) return false;
  return authority === `127.0.0.1:${port}` || authority === `localhost:${port}`;
}

/**
 * @returns {string|null} message de refus, ou null si la requete est legitime
 */
function checkRequestOrigin(req) {
  const port = req.socket?.localPort;

  if (!isAllowedAuthority(req.headers.host, port)) {
    return "Requête refusée : slide-shot ne répond que sur 127.0.0.1 et localhost.";
  }

  // Un `Origin` absent est legitime : EventSource same-origin, curl, fetch GET.
  const origin = req.headers.origin;
  if (origin === undefined) return null;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    // Inclut `Origin: null` (iframe bac a sable, page file://).
    return "Requête refusée : origine non autorisée.";
  }
  if (parsed.protocol !== 'http:' || !isAllowedAuthority(parsed.host, port)) {
    return "Requête refusée : origine non autorisée.";
  }
  return null;
}

async function handleRequest(req, res) {
  // Avant toute chose, et avant toute action visible (dialogues natifs, rendu).
  const refusal = checkRequestOrigin(req);
  if (refusal) return sendError(res, 403, refusal);

  let pathname = '/';
  try {
    pathname = new URL(req.url, `http://${HOST}`).pathname;
  } catch {
    return sendError(res, 400, 'Requête invalide.');
  }

  // Aucune traversee de chemin : rien d'autre que les routes declarees.
  if (pathname.includes('..') || /%2e/i.test(pathname) || pathname.includes('\0')) {
    return sendError(res, 404, 'Ressource introuvable.');
  }

  const found = matchRoute(req.method, pathname);
  if (!found) return sendError(res, 404, 'Ressource introuvable.');
  if (found.methodMismatch) return sendError(res, 405, 'Méthode non autorisée.');

  const ctx = { req, res, pathname, params: found.params };
  try {
    await found.entry.handler(ctx);
  } catch (err) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const status = Number.isInteger(err?.status) ? err.status : 500;
    const expose = status < 500 || err?.expose === true;
    if (status >= 500 && !expose) console.error('[slide-shot]', err);
    sendError(res, status, expose ? err.message : 'Erreur interne du serveur.');
  }
}

/* ------------------------------------------------------------------ */
/* Cycle de vie                                                        */
/* ------------------------------------------------------------------ */

export function createServer() {
  return http.createServer(handleRequest);
}

/**
 * Demarre le serveur.
 * @param {{port?:number, host?:string, open?:boolean}} [options]
 * @returns {Promise<{server:http.Server, port:number, url:string, close:()=>Promise<void>}>}
 */
export async function start(options = {}) {
  const port = options.port ?? Number(process.env.SLIDESHOT_PORT ?? DEFAULT_PORT);
  const host = options.host ?? HOST;

  // Filet de recuperation : si une instance precedente est morte sans pouvoir
  // se rattraper (SIGKILL, panne, coupure), son journal designe les dossiers
  // ou elle ecrivait. On y balaie ses residus avant d'oublier son existence.
  const recovered = sessions.purgeTmp();
  refreshPoppler();

  const server = createServer();
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      // Le port demande fait partie du diagnostic : on l'attache a l'erreur
      // pour que l'appelant puisse expliquer sans avoir a le recalculer.
      if (err && err.port === undefined) err.port = port;
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const actualPort = server.address().port;
  const url = `http://${host}:${actualPort}`;

  const close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });

  return { server, port: actualPort, url, close, recovered };
}

/**
 * Arret propre du travail en cours, sans quitter le processus (donc testable).
 *
 * L'ordre est l'invariant : on tue d'abord les `pdftoppm` en vol **et on attend
 * leur mort**, sinon ils continuent d'ecrire des `.slideshot-*` derriere le
 * balayage ; puis on balaie les dossiers de destination memorises. On ne
 * supprime jamais que les residus portant l'exportId de l'export concerne.
 * @returns {Promise<{killed:number, removed:number, failed:number}>}
 */
export async function stopWork() {
  // Pose synchrone, avant tout `await` : aucun lot ne peut plus etre lance
  // entre ce point et la fin du balayage.
  shuttingDown = true;
  try {
    let killed = 0;
    try {
      killed = await killActiveChildren();
    } catch {
      /* on balaie quand meme : mieux vaut un balayage imparfait que rien */
    }
    const swept = await sessions.sweepActiveExports();
    return { killed, ...swept };
  } finally {
    // Les enfants sont morts et les lots en vol ont vu l'arret : plus rien ne
    // peut demarrer a cause de cette remise a zero. En production le processus
    // quitte juste apres ; elle sert a garder la fonction testable telle quelle.
    shuttingDown = false;
  }
}

function explainStartupFailure(err) {
  const port = err?.port ?? Number(process.env.SLIDESHOT_PORT ?? DEFAULT_PORT);
  if (err?.code === 'EADDRINUSE') {
    return [
      '',
      `  slide-shot tourne déjà : le port ${port} est occupé.`,
      '',
      `  → Ouvrez simplement http://127.0.0.1:${port} dans votre navigateur.`,
      '',
      '  Si vous voulez malgré tout une seconde instance, donnez-lui un autre port :',
      '',
      `      SLIDESHOT_PORT=${port + 1} npm start`,
      '',
      "  (Si c'est un autre programme qui occupe ce port, la même commande règle",
      '   le problème : choisissez un numéro libre entre 1024 et 65535.)',
      '',
    ].join('\n');
  }
  if (err?.code === 'EACCES') {
    return [
      '',
      `  slide-shot n'a pas le droit d'écouter sur le port ${port}.`,
      '',
      '  Les ports inférieurs à 1024 sont réservés au système. Choisissez-en un autre :',
      '',
      '      SLIDESHOT_PORT=4321 npm start',
      '',
    ].join('\n');
  }
  return `\n  slide-shot n'a pas pu démarrer : ${err?.message ?? 'erreur inconnue'}\n`;
}

async function main() {
  let handle;
  try {
    handle = await start();
  } catch (err) {
    // Aucune trace de pile : l'utilisateur n'a rien a debugger, il a besoin
    // qu'on lui dise ce qui se passe et quoi faire.
    console.error(explainStartupFailure(err));
    process.exit(1);
  }

  console.log(`slide-shot — ${handle.url}`);
  console.log(`poppler : ${poppler.pdftoppm ?? 'introuvable'}`);
  if (!poppler.pdftoppm || !poppler.pdfinfo) {
    console.log('poppler est introuvable : lancez « npm run setup » ou « brew install poppler ».');
  }
  console.log(`export : ${CONCURRENCY} rendu(s) en parallèle`);
  if (handle.recovered > 0) {
    console.log(
      `nettoyage : ${handle.recovered} fichier(s) temporaire(s) abandonné(s) par une session précédente ont été supprimés.`,
    );
  }

  if (!process.env.SLIDESHOT_NO_OPEN) {
    spawn('open', [handle.url], { stdio: 'ignore', detached: true }).unref();
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      const { killed, removed, failed } = await stopWork();
      if (killed > 0 || removed > 0) {
        console.log(`\nArrêt : ${killed} rendu(s) interrompu(s), ${removed} fichier(s) temporaire(s) nettoyé(s).`);
      }
      if (failed > 0) {
        console.error(
          `Attention : ${failed} fichier(s) temporaire(s) « .slideshot-* » n'ont pas pu être supprimés.`,
        );
      }
    } catch (err) {
      console.error(`Le nettoyage de l'arrêt a échoué : ${err?.message ?? 'erreur inconnue'}`);
    }
    sessions.cleanupTmp();
    await handle.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  // Dernier filet : aucune erreur de demarrage ne doit sortir en trace brute.
  main().catch((err) => {
    console.error(explainStartupFailure(err));
    process.exit(1);
  });
}
