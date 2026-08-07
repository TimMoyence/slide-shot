// Nommage des fichiers exportes : logique pure, aucun I/O.

/** "Prez Client X.pdf" -> "Prez Client X". Retire / et \0, trim, "slides" si vide. */
export function sanitizeBase(filename) {
  let base = typeof filename === 'string' ? filename : '';
  base = base.replace(/\.pdf$/i, '');
  base = base.replace(/[/\0]/g, '');
  base = base.trim();
  return base === '' ? 'slides' : base;
}

/** Largeur du zero-padding : 2 minimum, 3 des 100 pages. padWidth(180) === 3 */
export function padWidth(pageCount) {
  return Math.max(2, String(pageCount).length);
}

/** slideFilename("prez", 3, 180, "png") -> "prez-slide-003.png" */
export function slideFilename(base, page, pageCount, ext) {
  const width = padWidth(pageCount);
  const padded = String(page).padStart(width, '0');
  return `${base}-slide-${padded}.${ext}`;
}

/**
 * Resout une collision contre un Set de noms deja pris.
 * "a.png" pris -> "a-2.png" ; "a-2.png" pris aussi -> "a-3.png"
 * N'ajoute rien au Set : c'est a l'appelant de le faire.
 */
export function resolveCollision(filename, taken) {
  if (!taken.has(filename)) return filename;

  const dotIndex = filename.lastIndexOf('.');
  const hasExt = dotIndex > 0;
  const base = hasExt ? filename.slice(0, dotIndex) : filename;
  const ext = hasExt ? filename.slice(dotIndex) : '';

  let suffix = 2;
  let candidate;
  do {
    candidate = `${base}-${suffix}${ext}`;
    suffix += 1;
  } while (taken.has(candidate));

  return candidate;
}
