// Selection de pages : logique pure, aucun I/O.
// Numeros de page 1-indexes partout.

// Une plage s'ecrit "debut-fin" avec des entiers positifs des deux cotes.
const RANGE_PATTERN = /^(\d+)-(\d+)$/;
// Une page isolee peut porter un signe negatif, pour distinguer les pages
// hors bornes (< 1) des expressions vraiment incomprehensibles.
const SINGLE_PAGE_PATTERN = /^-?\d+$/;

/**
 * Analyse une expression de selection.
 * Separateurs acceptes : virgule, point-virgule, espace, retour ligne.
 * Plage inversee ("8-5") : normalisee en 5-8.
 * Doublons et chevauchements : fusionnes.
 * @returns {{ pages: number[], warnings: string[] }} pages triees croissant, uniques
 */
export function parsePageSpec(spec, pageCount) {
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    return { pages: [], warnings: [] };
  }
  if (spec == null) {
    return { pages: [], warnings: [] };
  }

  const trimmed = String(spec).trim();
  if (trimmed === '') {
    return { pages: [], warnings: [] };
  }

  const fragments = trimmed.split(/[,;\s]+/).filter(Boolean);
  const pageSet = new Set();
  const warnings = [];

  for (const fragment of fragments) {
    const rangeMatch = fragment.match(RANGE_PATTERN);
    if (rangeMatch) {
      const rawFirst = Number(rangeMatch[1]);
      const rawLast = Number(rangeMatch[2]);
      const first = Math.min(rawFirst, rawLast);
      const last = Math.max(rawFirst, rawLast);

      if (last < 1 || first > pageCount) {
        warnings.push(
          `La plage ${rangeMatch[1]}-${rangeMatch[2]} dépasse le document (${pageCount} pages).`
        );
        continue;
      }

      const clampedFirst = Math.max(first, 1);
      const clampedLast = Math.min(last, pageCount);
      if (clampedFirst !== first || clampedLast !== last) {
        warnings.push(
          `La plage ${rangeMatch[1]}-${rangeMatch[2]} dépasse le document (${pageCount} pages).`
        );
      }
      for (let p = clampedFirst; p <= clampedLast; p++) pageSet.add(p);
      continue;
    }

    if (SINGLE_PAGE_PATTERN.test(fragment)) {
      const page = Number(fragment);
      if (page < 1 || page > pageCount) {
        warnings.push(`La page ${page} n'existe pas (le document en compte ${pageCount}).`);
      } else {
        pageSet.add(page);
      }
      continue;
    }

    warnings.push(`Expression non reconnue : « ${fragment} ».`);
  }

  return { pages: [...pageSet].sort((a, b) => a - b), warnings };
}

/**
 * Formate une liste de pages en expression compacte.
 * [1,3,5,6,7,8] -> "1,3,5-8"   []  -> ""
 */
export function formatPageSpec(pages) {
  return toRanges(pages)
    .map(({ first, last }) => (first === last ? `${first}` : `${first}-${last}`))
    .join(',');
}

/**
 * Regroupe des pages en plages contigues, pour limiter le nombre
 * d'invocations de pdftoppm.
 * [1,3,5,6,7,8] -> [{first:1,last:1},{first:3,last:3},{first:5,last:8}]
 */
export function toRanges(pages) {
  if (!pages || pages.length === 0) return [];

  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges = [];
  let first = sorted[0];
  let last = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const page = sorted[i];
    if (page === last + 1) {
      last = page;
    } else {
      ranges.push({ first, last });
      first = page;
      last = page;
    }
  }
  ranges.push({ first, last });

  return ranges;
}

/**
 * Redecoupe des plages en lots d'au plus maxPages pages, pour alimenter
 * la barre de progression. L'ordre et la couverture sont preserves.
 */
export function chunkRanges(ranges, maxPages) {
  const chunks = [];

  for (const { first, last } of ranges) {
    let start = first;
    while (start <= last) {
      const end = Math.min(start + maxPages - 1, last);
      chunks.push({ first: start, last: end });
      start = end + 1;
    }
  }

  return chunks;
}
