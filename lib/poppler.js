// Pont vers les binaires poppler (pdftoppm, pdfinfo).
import { accessSync, constants } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

function locateBinary(name) {
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const dirs = [...pathDirs, ...FALLBACK_DIRS];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // pas trouve dans ce dossier, on continue
    }
  }
  return null;
}

/**
 * Localise les binaires. Cherche dans PATH, puis /opt/homebrew/bin,
 * /usr/local/bin, /usr/bin (le PATH est souvent ampute hors terminal).
 * @returns {{ pdftoppm: string|null, pdfinfo: string|null }} chemins absolus
 */
export function findPoppler() {
  return {
    pdftoppm: locateBinary('pdftoppm'),
    pdfinfo: locateBinary('pdfinfo'),
  };
}

/**
 * Processus poppler encore en vol.
 *
 * `pdftoppm` ecrit directement dans le dossier de l'utilisateur : s'il survit a
 * l'arret du serveur, il continue a semer des `.slideshot-*` que plus personne
 * ne balaiera. On garde donc une reference sur chaque enfant pour pouvoir le
 * tuer — et attendre sa mort — avant de nettoyer.
 * @type {Set<import('node:child_process').ChildProcess>}
 */
const activeChildren = new Set();

/** Nombre de processus poppler encore vivants (diagnostic et tests). */
export function activeChildCount() {
  return activeChildren.size;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('close', resolve);
    child.once('exit', resolve);
    child.once('error', resolve);
  });
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Termine tous les processus poppler en vol et **attend reellement leur mort**.
 * SIGTERM d'abord, SIGKILL si l'enfant s'accroche. A appeler a l'arret, avant
 * tout balayage : sinon le balayage court apres un ecrivain encore actif.
 * @returns {Promise<number>} nombre de processus qui etaient encore vivants
 */
export async function killActiveChildren({ graceMs = 2000, hardMs = 2000 } = {}) {
  const children = [...activeChildren];
  if (children.length === 0) return 0;

  const exits = children.map((child) => waitForExit(child));
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* deja mort */
    }
  }
  await withTimeout(Promise.all(exits), graceMs);

  const stubborn = children.filter((c) => c.exitCode === null && c.signalCode === null);
  if (stubborn.length > 0) {
    for (const child of stubborn) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* deja mort */
      }
    }
    await withTimeout(Promise.all(exits), hardMs);
  }

  activeChildren.clear();
  return children.length;
}

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      activeChildren.delete(child);
      reject(err);
    });
    child.on('close', (code, signal) => {
      activeChildren.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** @returns {Promise<number>} nombre de pages. Rejette si le PDF est illisible. */
export async function getPageCount(pdfinfoPath, pdfPath) {
  const { code, stdout, stderr } = await runCommand(pdfinfoPath, [pdfPath]);
  if (code !== 0) {
    throw new Error(
      `Impossible de lire le PDF « ${pdfPath} » : ${stderr.trim() || 'erreur inconnue'}`
    );
  }
  const match = stdout.match(/^Pages:\s*(\d+)/m);
  if (!match) {
    throw new Error(`Impossible de déterminer le nombre de pages du PDF « ${pdfPath} ».`);
  }
  return parseInt(match[1], 10);
}

/**
 * Rend les pages [first..last] dans outDir.
 * format: 'png' | 'jpeg'.
 * Les fichiers produits s'appellent `${prefix}-<page paddee>.<ext>`.
 * @returns {Promise<Array<{page:number, path:string}>>} trie par page croissante
 */
export async function renderRange({ pdftoppmPath, pdfPath, outDir, prefix, first, last, dpi, format }) {
  const ext = format === 'png' ? 'png' : 'jpg';
  const formatFlag = format === 'png' ? '-png' : '-jpeg';
  const outputRoot = path.join(outDir, prefix);

  const args = ['-r', String(dpi), '-f', String(first), '-l', String(last), formatFlag, pdfPath, outputRoot];
  const { code, signal, stderr } = await runCommand(pdftoppmPath, args);
  if (code !== 0) {
    // Un signal signifie qu'on a nous-memes interrompu le rendu (arret du serveur).
    const cause = signal
      ? `rendu interrompu (${signal})`
      : stderr.trim() || 'erreur inconnue';
    throw new Error(`Échec du rendu pdftoppm (pages ${first}-${last}) : ${cause}`);
  }

  const dotExt = '.' + ext;
  const prefixDash = prefix + '-';
  const entries = await readdir(outDir);
  const matched = [];
  for (const file of entries) {
    if (!file.startsWith(prefixDash) || !file.endsWith(dotExt)) continue;
    const numPart = file.slice(prefixDash.length, file.length - dotExt.length);
    if (!/^\d+$/.test(numPart)) continue;
    const page = parseInt(numPart, 10);
    // outDir et prefix peuvent etre partages entre plusieurs appels concurrents
    // ou successifs (un lot d'export = un appel) : ne retenir que les pages de
    // CETTE plage. Les plages sont disjointes par construction, donc sans ambiguite.
    if (page < first || page > last) continue;
    matched.push({ page, path: path.join(outDir, file) });
  }
  matched.sort((a, b) => a.page - b.page);

  const expectedCount = last - first + 1;
  if (matched.length !== expectedCount) {
    throw new Error(
      `Rendu incomplet : ${matched.length} fichier(s) trouvé(s) pour les pages ${first}-${last} ` +
      `(attendu ${expectedCount}). Impossible d'apparier les fichiers pdftoppm à leurs numéros de page.`
    );
  }

  return matched;
}
