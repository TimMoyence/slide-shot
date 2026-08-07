/**
 * Execution d'un export : rendu des pages selectionnees directement dans le
 * dossier de destination, puis renommage vers les noms finaux.
 *
 * Le rendu ecrit dans `dest` avec le prefixe temporaire `.slideshot-<exportId>`
 * pour que le renommage final soit un `rename` sur le meme volume (aucune copie
 * de plusieurs centaines de Mo). Tout residu portant ce prefixe est balaye,
 * y compris en cas d'echec ou d'annulation.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { toRanges, chunkRanges } from './pages.js';
import { slideFilename, resolveCollision } from './naming.js';
import { renderRange } from './poppler.js';

/** Taille d'un lot : granularite de la barre de progression. */
export const CHUNK_SIZE = 10;

/**
 * `pdftoppm` est monothread (~94 % d'un cœur) : on lance plusieurs lots en
 * parallele. Deux cœurs sont laisses au systeme et au serveur, et on plafonne
 * a 4 pour ne pas saturer les I/O disque.
 */
export const CONCURRENCY = Math.max(1, Math.min(4, (os.cpus()?.length ?? 2) - 2));

export function tempPrefix(exportId) {
  return `.slideshot-${exportId}`;
}

/**
 * Supprime les residus de CET export uniquement : le dossier est a l'utilisateur,
 * un `.slideshot-` appartenant a un autre export doit survivre.
 * @returns {Promise<{removed:number, failed:number}>} `failed` > 0 signale des
 *   residus qu'on n'a pas su effacer — a remonter a l'utilisateur, jamais a avaler.
 */
export async function sweepTemp(dest, exportId) {
  const prefix = tempPrefix(exportId);
  let names;
  try {
    names = await fsp.readdir(dest);
  } catch (err) {
    // Le dossier a disparu : il n'y a plus rien a nettoyer, ce n'est pas un echec.
    return { removed: 0, failed: err?.code === 'ENOENT' ? 0 : 1 };
  }
  let removed = 0;
  let failed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      await fsp.rm(path.join(dest, name), { force: true });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

/**
 * Variante synchrone de `sweepTemp`, pour la recuperation au demarrage : le
 * balayage des sessions mortes doit etre termine avant que le serveur ecoute.
 * @returns {{removed:number, failed:number}}
 */
export function sweepTempSync(dest, exportId) {
  const prefix = tempPrefix(exportId);
  let names;
  try {
    names = fs.readdirSync(dest);
  } catch (err) {
    return { removed: 0, failed: err?.code === 'ENOENT' ? 0 : 1 };
  }
  let removed = 0;
  let failed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      fs.rmSync(path.join(dest, name), { force: true });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

/** Message affiche a l'utilisateur quand des residus n'ont pas pu etre effaces. */
export function sweepFailureMessage(dest, exportId, failed) {
  const subject = failed === 1
    ? "1 fichier temporaire n'a pas pu être supprimé"
    : `${failed} fichiers temporaires n'ont pas pu être supprimés`;
  return (
    `Nettoyage incomplet : ${subject} dans « ${dest} ». ` +
    `Supprimez à la main les fichiers commençant par « ${tempPrefix(exportId)} » ` +
    `(ce sont des fichiers cachés : Cmd+Maj+. les révèle dans le Finder).`
  );
}

/** Extension du fichier final selon le format demande. */
export function extensionFor(format) {
  return format === 'jpeg' || format === 'jpg' ? 'jpg' : 'png';
}

/**
 * Lance `runner` sur chaque element de `items`, au plus `limit` en parallele.
 * S'arrete de piocher des que `shouldStop()` est vrai (echec ou annulation).
 * @returns {Promise<Error|null>} la premiere erreur rencontree, ou null
 */
async function runPool(items, limit, shouldStop, runner) {
  let cursor = 0;
  let firstError = null;
  const workers = [];
  const width = Math.max(1, Math.min(limit, items.length));

  for (let w = 0; w < width; w += 1) {
    workers.push(
      (async () => {
        for (;;) {
          if (firstError || shouldStop()) return;
          const index = cursor;
          cursor += 1;
          if (index >= items.length) return;
          try {
            await runner(items[index]);
          } catch (err) {
            if (!firstError) firstError = err;
            return;
          }
        }
      })(),
    );
  }

  await Promise.allSettled(workers);
  return firstError;
}

/**
 * @param {object} job    parametres valides de l'export
 * @param {(payload:object)=>void} emit  emetteur d'evenements SSE
 * @param {()=>boolean} isAborted        vrai si le client s'est deconnecte
 * @returns {Promise<{files:string[], warnings:string[], aborted:boolean}>}
 */
export async function runExportJob(job, { emit, isAborted = () => false } = {}) {
  const {
    exportId,
    pdftoppmPath,
    pdfPath,
    pages,
    dest,
    dpi,
    format,
    base,
    pageCount,
    concurrency = CONCURRENCY,
  } = job;

  const prefix = tempPrefix(exportId);
  const ext = extensionFor(format);
  const total = pages.length;
  const warnings = [];
  const files = [];
  /** @type {Array<{page:number, path:string}>} */
  const rendered = [];
  let done = 0;
  /** @type {Error|null} erreur en cours de propagation, pour l'annoter apres le balayage */
  let failure = null;

  try {
    const batches = chunkRanges(toRanges(pages), CHUNK_SIZE);

    // --- Phase 1 : rendu, en parallele borne. ---------------------------
    // Les lots finissent dans le desordre ; `done` compte les pages
    // effectivement ecrites et ne recule donc jamais.
    const renderFailure = await runPool(batches, concurrency, isAborted, async (batch) => {
      const produced = await renderRange({
        pdftoppmPath,
        pdfPath,
        outDir: dest,
        prefix,
        first: batch.first,
        last: batch.last,
        dpi,
        format,
      });
      for (const item of produced) {
        rendered.push(item);
        done += 1;
        emit?.({ type: 'progress', done, total, page: item.page });
      }
    });

    if (renderFailure) throw renderFailure;
    if (isAborted()) return { files: [], warnings, aborted: true };

    // --- Phase 2 : renommage, dans l'ordre croissant des pages. ---------
    // Independant de l'ordre d'arrivee des lots : le nommage reste
    // deterministe. Le cout est negligeable face au rendu.
    rendered.sort((a, b) => a.page - b.page);

    // Noms deja pris : contenu reel du dossier, relu maintenant, plus les
    // noms attribues au fil de cet export.
    const taken = new Set(
      (await fsp.readdir(dest)).filter((name) => !name.startsWith('.slideshot-')),
    );
    let collisions = 0;

    for (const item of rendered) {
      const wanted = slideFilename(base, item.page, pageCount, ext);
      let finalName = resolveCollision(wanted, taken);
      // Filet de securite : le systeme de fichiers macOS est insensible a la
      // casse, `taken` ne l'est pas. On ne doit jamais ecraser un fichier.
      for (let guard = 0; guard < 1000; guard += 1) {
        if (!fs.existsSync(path.join(dest, finalName))) break;
        taken.add(finalName);
        finalName = resolveCollision(wanted, taken);
      }
      taken.add(finalName);
      if (finalName !== wanted) collisions += 1;
      const finalPath = path.join(dest, finalName);
      await fsp.rename(item.path, finalPath);
      files.push(finalPath);
    }

    if (collisions === 1) {
      warnings.push('Un fichier portait déjà le nom prévu : il a été renommé avec un suffixe.');
    } else if (collisions > 1) {
      warnings.push(
        `${collisions} fichiers portaient déjà le nom prévu : ils ont été renommés avec un suffixe (-2, -3…).`,
      );
    }

    return { files, warnings, aborted: false };
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    // `warnings` est le meme tableau que celui deja place dans l'objet de
    // retour : y pousser ici suffit a le faire remonter dans l'evenement `done`.
    const sweep = await sweepTemp(dest, exportId);
    if (sweep.failed > 0) {
      const note = sweepFailureMessage(dest, exportId, sweep.failed);
      if (failure) failure.message = `${failure.message} — ${note}`;
      else warnings.push(note);
    }
  }
}
