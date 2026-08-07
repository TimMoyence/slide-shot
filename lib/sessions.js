/**
 * Registre en memoire des documents ouverts et des exports en attente.
 * Etat pur + gestion du dossier temporaire de session. Aucune logique metier,
 * aucun I/O reseau.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { sweepTemp, sweepTempSync } from './export-job.js';

/** Dossier temporaire propre a ce processus (une « session »). */
const SESSION_DIR = path.join(os.tmpdir(), `slide-shot-${process.pid}`);

/** Reconnait les dossiers de session laisses par d'autres processus. */
const SESSION_DIR_RE = /^slide-shot-(\d+)$/;

/**
 * Journal des exports en cours d'ecriture, au format JSON Lines.
 * Il vit dans le dossier de session, donc il porte implicitement le PID :
 * un demarrage ulterieur sait a quelle instance morte il appartenait.
 */
const JOURNAL_NAME = 'active-exports.jsonl';

/** @type {Map<string, object>} */
const documents = new Map();
/** @type {Map<string, object>} */
const pendingExports = new Map();
/** exportId -> { exportId, dest } : exports qui ecrivent en ce moment dans `dest`. */
const activeExports = new Map();

/* ------------------------------------------------------------------ */
/* Dossier temporaire                                                  */
/* ------------------------------------------------------------------ */

export function sessionDir() {
  return SESSION_DIR;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Dossier des PDF deposes par glisser-deposer. */
export function uploadsDir() {
  return ensureDir(path.join(SESSION_DIR, 'uploads'));
}

/** Dossier des miniatures d'un document. */
export function thumbsDir(docId) {
  return ensureDir(path.join(SESSION_DIR, 'thumbs', docId));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM : le processus existe mais appartient a un autre utilisateur.
    return err?.code === 'EPERM';
  }
}

/* ------------------------------------------------------------------ */
/* Journal des exports actifs                                          */
/* ------------------------------------------------------------------ */

function journalPath(dir = SESSION_DIR) {
  return path.join(dir, JOURNAL_NAME);
}

/** Reecrit le journal a partir du registre en memoire. Best effort, jamais bloquant. */
function writeJournal() {
  try {
    ensureDir(SESSION_DIR);
    const lines = [...activeExports.values()]
      .map((entry) => JSON.stringify({ exportId: entry.exportId, dest: entry.dest }))
      .join('\n');
    fs.writeFileSync(journalPath(), lines ? `${lines}\n` : '', 'utf8');
  } catch {
    /* le journal est un filet, pas une dependance : un echec ne doit rien casser */
  }
}

/** Lit le journal d'une session (la sienne ou celle d'un PID mort). */
function readJournal(dir) {
  let raw;
  try {
    raw = fs.readFileSync(journalPath(dir), 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.exportId === 'string' && typeof parsed?.dest === 'string') {
        entries.push({ exportId: parsed.exportId, dest: parsed.dest });
      }
    } catch {
      /* ligne tronquee par un arret brutal : on ignore celle-la, pas les autres */
    }
  }
  return entries;
}

/**
 * Declare qu'un export commence a ecrire dans `dest`.
 * A partir d'ici, l'arret du serveur sait quel dossier balayer, et le journal
 * permet au demarrage suivant de rattraper un SIGKILL.
 */
export function beginActiveExport({ exportId, dest }) {
  activeExports.set(exportId, { exportId, dest });
  writeJournal();
}

/** L'export a fini (succes, echec ou abandon) : il n'a plus rien a nettoyer. */
export function endActiveExport(exportId) {
  if (activeExports.delete(exportId)) writeJournal();
}

/** @returns {Array<{exportId:string, dest:string}>} */
export function listActiveExports() {
  return [...activeExports.values()];
}

/**
 * Balaie les residus de tous les exports encore en vol. A appeler a l'arret,
 * **apres** avoir tue les processus de rendu : sinon ils reecrivent derriere nous.
 * @returns {Promise<{removed:number, failed:number}>}
 */
export async function sweepActiveExports() {
  let removed = 0;
  let failed = 0;
  for (const entry of listActiveExports()) {
    const result = await sweepTemp(entry.dest, entry.exportId);
    removed += result.removed;
    failed += result.failed;
  }
  activeExports.clear();
  writeJournal();
  return { removed, failed };
}

/* ------------------------------------------------------------------ */
/* Sessions abandonnees                                                */
/* ------------------------------------------------------------------ */

/**
 * Supprime les dossiers de session abandonnes par des processus morts.
 * On ne touche jamais au dossier d'une instance encore vivante.
 *
 * Avant d'effacer une session morte, on lit son journal : le processus a pu
 * mourir sans pouvoir se rattraper (SIGKILL, panne, coupure) en laissant des
 * `.slideshot-<exportId>*` dans un dossier de l'utilisateur. On ne balaie que
 * les residus portant l'exportId journalise.
 * @returns {{removed:number, adopted:Array<{exportId:string, dest:string}>}}
 *   `adopted` : les exports de la session morte, a reprendre a notre compte.
 */
function removeStaleSessions() {
  let entries;
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return { removed: 0, adopted: [] };
  }
  let removed = 0;
  const adopted = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = SESSION_DIR_RE.exec(entry.name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    if (isProcessAlive(pid)) continue;
    const staleDir = path.join(os.tmpdir(), entry.name);
    for (const job of readJournal(staleDir)) {
      removed += sweepTempSync(job.dest, job.exportId).removed;
      adopted.push(job);
    }
    try {
      fs.rmSync(staleDir, { recursive: true, force: true });
    } catch {
      /* dossier verrouille ou deja disparu : sans importance */
    }
  }
  return { removed, adopted };
}

/**
 * Le seul balayage de recuperation, sans la reprise a son compte que fait
 * `purgeTmp`. Expose pour tester ce demi-mecanisme isolement.
 * @returns {number} nombre de residus effaces
 */
export function recoverStaleSessions() {
  return removeStaleSessions().removed;
}

/**
 * Purge et recree le dossier de session. A appeler au demarrage.
 * @returns {number} residus recuperes dans les dossiers d'utilisateur
 */
export function purgeTmp() {
  const { removed, adopted } = removeStaleSessions();
  try {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  ensureDir(SESSION_DIR);

  // Un `pdftoppm` orphelin peut avoir survecu au SIGKILL de son serveur et
  // continuer d'ecrire pendant qu'on balaie : le balayage ci-dessus le rate
  // alors d'un cheveu, et son journal vient d'etre efface avec sa session.
  // On reprend donc ces exports a notre compte : notre propre arret les
  // rebalaiera, et notre journal les transmettra au demarrage suivant.
  // L'invariant tient : ces exportId sont les notres, ils viennent d'un
  // journal ecrit par slide-shot.
  for (const job of adopted) activeExports.set(job.exportId, job);
  if (adopted.length > 0) writeJournal();

  return removed;
}

/** Supprime le dossier de session et vide le registre. A appeler a l'arret. */
export function cleanupTmp() {
  documents.clear();
  pendingExports.clear();
  activeExports.clear();
  try {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

/**
 * Enregistre un document ouvert.
 * @param {{pdfPath:string, name:string, base:string, pageCount:number, temporary?:boolean}} info
 * @returns {object} le document, avec son `docId` et son dossier de miniatures
 */
export function registerDocument({ pdfPath, name, base, pageCount, temporary = false }) {
  const docId = randomUUID();
  const doc = {
    docId,
    pdfPath,
    name,
    base,
    pageCount,
    temporary,
    thumbDir: thumbsDir(docId),
    /** @type {Map<number, string>|null} rempli quand le rendu des miniatures est fini */
    thumbFiles: null,
    thumbsDone: false,
    /** @type {Error|null} */
    thumbError: null,
    openedAt: Date.now(),
  };
  documents.set(docId, doc);
  return doc;
}

/** @returns {object|null} */
export function getDocument(docId) {
  if (typeof docId !== 'string') return null;
  return documents.get(docId) ?? null;
}

/**
 * Comme `getDocument`, mais leve une erreur explicite si le document est inconnu.
 * L'erreur porte `code = 'UNKNOWN_DOCUMENT'` et `status = 400`.
 */
export function requireDocument(docId) {
  const doc = getDocument(docId);
  if (!doc) {
    const err = new Error('Document introuvable : rouvrez le PDF.');
    err.code = 'UNKNOWN_DOCUMENT';
    err.status = 400;
    throw err;
  }
  return doc;
}

export function documentCount() {
  return documents.size;
}

/* ------------------------------------------------------------------ */
/* Exports en attente                                                  */
/* ------------------------------------------------------------------ */

/**
 * Enregistre un export valide, en attente de sa connexion SSE.
 * @returns {object} le job, avec son `exportId`
 */
export function registerExport(params) {
  const exportId = randomUUID();
  const job = { exportId, createdAt: Date.now(), ...params };
  pendingExports.set(exportId, job);
  return job;
}

/** @returns {object|null} */
export function getExport(exportId) {
  if (typeof exportId !== 'string') return null;
  return pendingExports.get(exportId) ?? null;
}

/** Retire et renvoie l'export : un job ne peut etre consomme qu'une fois. */
export function takeExport(exportId) {
  const job = getExport(exportId);
  if (job) pendingExports.delete(exportId);
  return job;
}

export function removeExport(exportId) {
  return pendingExports.delete(exportId);
}

export function pendingExportCount() {
  return pendingExports.size;
}

/** Vide le registre sans toucher au disque (tests). */
export function reset() {
  documents.clear();
  pendingExports.clear();
  activeExports.clear();
}
