import { parsePageSpec, formatPageSpec } from '/lib/pages.js';

// ---------------------------------------------------------------------
// État
// ---------------------------------------------------------------------

/** @type {{docId:string, name:string, base:string, pageCount:number}|null} */
let doc = null;

/** Ensemble unique des pages sélectionnées (1-indexées). Source de vérité. */
let selected = new Set();

/** Dernière vignette cliquée normalement, ancre pour Shift+clic. */
let anchorPage = null;

/** Chemin du dossier de destination choisi, ou null. */
let dest = null;

/** true pendant un export en cours. */
let exporting = false;

/** EventSource ouvert pour l'export en cours, ou null. */
let currentEventSource = null;

/** page -> élément .thumb, construit une seule fois par document. */
const thumbEls = new Map();

/**
 * Vrai dès qu'on a signalé l'échec des miniatures pour ce document.
 * Il peut y avoir 180 vignettes en erreur : on n'affiche le bandeau qu'une fois.
 */
let thumbErrorReported = false;

/** Fichiers écrits par le dernier export, pour « Afficher dans le Finder ». */
let lastExportFiles = [];

// ---------------------------------------------------------------------
// Éléments du DOM
// ---------------------------------------------------------------------

const errorBanner = document.getElementById('error-banner');
const errorMessageEl = document.getElementById('error-message');
const errorDismissBtn = document.getElementById('error-dismiss');

const viewChecking = document.getElementById('view-checking');
const viewPopplerMissing = document.getElementById('view-poppler-missing');
const viewDrop = document.getElementById('view-drop');
const viewWorkspace = document.getElementById('view-workspace');
const views = [viewChecking, viewPopplerMissing, viewDrop, viewWorkspace];

const popplerRetryBtn = document.getElementById('poppler-retry-btn');

const dropzone = document.getElementById('dropzone');
const browseBtn = document.getElementById('browse-btn');
const uploadStatus = document.getElementById('upload-status');
const uploadStatusText = document.getElementById('upload-status-text');

const docNameEl = document.getElementById('doc-name');
const docPageCountEl = document.getElementById('doc-page-count');
const resetBtn = document.getElementById('reset-btn');

const selectAllBtn = document.getElementById('select-all-btn');
const selectNoneBtn = document.getElementById('select-none-btn');
const selectInvertBtn = document.getElementById('select-invert-btn');
const selectionCountEl = document.getElementById('selection-count');
const thumbGrid = document.getElementById('thumb-grid');

const pageSpecInput = document.getElementById('page-spec-input');
const pageSpecWarningsEl = document.getElementById('page-spec-warnings');

const prefixDisplay = document.getElementById('prefix-display');

const chooseDestBtn = document.getElementById('choose-dest-btn');
const destPathEl = document.getElementById('dest-path');

const exportBtn = document.getElementById('export-btn');

const exportProgress = document.getElementById('export-progress');
const exportProgressBar = document.getElementById('export-progress-bar');
const exportProgressCount = document.getElementById('export-progress-count');

const exportResult = document.getElementById('export-result');
const exportResultSummary = document.getElementById('export-result-summary');
const exportResultWarnings = document.getElementById('export-result-warnings');
const revealBtn = document.getElementById('reveal-btn');

// ---------------------------------------------------------------------
// Utilitaires génériques
// ---------------------------------------------------------------------

function showView(view) {
  for (const v of views) {
    v.hidden = v !== view;
  }
}

function showError(message) {
  errorMessageEl.textContent = message;
  errorBanner.hidden = false;
}

function hideError() {
  errorBanner.hidden = true;
}

errorDismissBtn.addEventListener('click', hideError);

/**
 * POST JSON et lit la réponse JSON. Lance une Error(message) si le statut
 * est en erreur. Ne masque jamais un échec réseau ou serveur.
 */
async function postJSON(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error("Impossible de joindre le serveur local.");
  }
  let data = {};
  try {
    data = await res.json();
  } catch (err) {
    // corps vide ou non JSON
  }
  if (!res.ok) {
    throw new Error(data.error || `Erreur ${res.status}.`);
  }
  return data;
}

function renderWarnings(container, warnings) {
  container.replaceChildren();
  if (!warnings || warnings.length === 0) return;
  const ul = document.createElement('ul');
  for (const w of warnings) {
    const li = document.createElement('li');
    li.textContent = w;
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

// ---------------------------------------------------------------------
// Vérification poppler
// ---------------------------------------------------------------------

async function checkHealth() {
  showView(viewChecking);
  try {
    const res = await fetch('/api/health');
    let data = {};
    try {
      data = await res.json();
    } catch (err) {
      // ignore
    }
    if (!res.ok || !data.ok) {
      showView(viewPopplerMissing);
      return;
    }
    showView(viewDrop);
  } catch (err) {
    showView(viewPopplerMissing);
  }
}

popplerRetryBtn.addEventListener('click', checkHealth);

// ---------------------------------------------------------------------
// Dépôt / ouverture du document
// ---------------------------------------------------------------------

function setUploadStatus(text) {
  uploadStatusText.textContent = text;
  uploadStatus.hidden = false;
  dropzone.hidden = true;
}

function clearUploadStatus() {
  uploadStatus.hidden = true;
  dropzone.hidden = false;
}

function looksLikePdf(file) {
  if (file.type === 'application/pdf') return true;
  return /\.pdf$/i.test(file.name || '');
}

async function uploadFile(file) {
  if (!looksLikePdf(file)) {
    showError("Le fichier déposé ne semble pas être un PDF.");
    return;
  }
  hideError();
  setUploadStatus(`Envoi de « ${file.name} »…`);
  let res;
  try {
    res = await fetch('/api/upload', {
      method: 'POST',
      headers: {
        'x-filename': encodeURIComponent(file.name),
        'Content-Type': 'application/octet-stream',
      },
      body: file,
    });
  } catch (err) {
    clearUploadStatus();
    showError("Erreur réseau pendant l'envoi du fichier.");
    return;
  }
  let data = {};
  try {
    data = await res.json();
  } catch (err) {
    // ignore
  }
  if (!res.ok) {
    clearUploadStatus();
    showError(data.error || "Erreur lors de l'envoi du fichier.");
    return;
  }
  clearUploadStatus();
  onDocLoaded(data);
}

async function openViaBrowse() {
  hideError();
  try {
    const chosen = await postJSON('/api/choose-file');
    if (chosen.cancelled) return;
    setUploadStatus('Ouverture du document…');
    const data = await postJSON('/api/open', { path: chosen.path });
    clearUploadStatus();
    onDocLoaded(data);
  } catch (err) {
    clearUploadStatus();
    showError(err.message);
  }
}

browseBtn.addEventListener('click', openViaBrowse);

// Empêche le navigateur d'ouvrir le PDF si le dépôt manque la zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});
dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('drag-over');
});
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) uploadFile(file);
});

// ---------------------------------------------------------------------
// Chargement du document dans l'espace de travail
// ---------------------------------------------------------------------

function onDocLoaded(data) {
  doc = data;
  selected = new Set();
  for (let p = 1; p <= doc.pageCount; p++) selected.add(p);
  anchorPage = null;
  dest = null;
  exporting = false;
  thumbErrorReported = false;
  lastExportFiles = [];

  docNameEl.textContent = doc.name;
  docPageCountEl.textContent = doc.pageCount === 1 ? '1 page' : `${doc.pageCount} pages`;
  prefixDisplay.value = doc.base;
  destPathEl.textContent = '';
  hideExportProgress();
  hideExportResult();
  renderWarnings(pageSpecWarningsEl, []);

  buildGrid(doc.pageCount);
  syncFromSelection();

  showView(viewWorkspace);
}

function resetToDrop() {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
  doc = null;
  selected = new Set();
  anchorPage = null;
  dest = null;
  exporting = false;
  thumbErrorReported = false;
  lastExportFiles = [];
  thumbGrid.replaceChildren();
  thumbEls.clear();
  pageSpecInput.value = '';
  renderWarnings(pageSpecWarningsEl, []);
  destPathEl.textContent = '';
  hideExportProgress();
  hideExportResult();
  hideError();
  clearUploadStatus();
  showView(viewDrop);
}

resetBtn.addEventListener('click', resetToDrop);

// ---------------------------------------------------------------------
// Grille de miniatures
// ---------------------------------------------------------------------

/**
 * Une vignette n'a pas pu être chargée. Le rendu des miniatures est une passe
 * unique : si elle échoue, les 180 images échouent. On interroge le serveur une
 * seule fois pour connaître la vraie raison, et on l'affiche une seule fois.
 */
async function onThumbLoadError(page, el) {
  el.classList.add('is-broken');
  if (thumbErrorReported || !doc) return;
  thumbErrorReported = true;

  let detail = '';
  try {
    const res = await fetch(`/api/thumb/${doc.docId}/${page}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data && typeof data.error === 'string') detail = data.error;
    }
  } catch (err) {
    // Serveur injoignable : on reste sur le message générique.
  }

  const cause = (detail || "les aperçus n'ont pas pu être générés").replace(/\s*\.\s*$/, '');
  showError(
    `Aperçus indisponibles — ${cause}. ` +
      "Les vignettes restent vides, mais l'export fonctionne toujours : " +
      'indiquez les pages voulues dans le champ « Pages à exporter », à droite.',
  );
}

function buildGrid(pageCount) {
  thumbGrid.replaceChildren();
  thumbEls.clear();
  const frag = document.createDocumentFragment();
  for (let page = 1; page <= pageCount; page++) {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.dataset.page = String(page);

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = `Page ${page}`;
    img.addEventListener('error', () => onThumbLoadError(page, el));
    img.src = `/api/thumb/${doc.docId}/${page}`;

    const badge = document.createElement('span');
    badge.className = 'thumb-badge';
    badge.textContent = String(page);

    el.appendChild(img);
    el.appendChild(badge);
    el.addEventListener('click', (e) => onThumbClick(e, page));

    thumbEls.set(page, el);
    frag.appendChild(el);
  }
  thumbGrid.appendChild(frag);
}

function onThumbClick(e, page) {
  if (e.shiftKey && anchorPage !== null) {
    const lo = Math.min(anchorPage, page);
    const hi = Math.max(anchorPage, page);
    for (let p = lo; p <= hi; p++) selected.add(p);
  } else {
    if (selected.has(page)) {
      selected.delete(page);
    } else {
      selected.add(page);
    }
    anchorPage = page;
  }
  syncFromSelection();
}

selectAllBtn.addEventListener('click', () => {
  selected = new Set();
  for (let p = 1; p <= doc.pageCount; p++) selected.add(p);
  anchorPage = null;
  syncFromSelection();
});

selectNoneBtn.addEventListener('click', () => {
  selected = new Set();
  anchorPage = null;
  syncFromSelection();
});

selectInvertBtn.addEventListener('click', () => {
  const next = new Set();
  for (let p = 1; p <= doc.pageCount; p++) {
    if (!selected.has(p)) next.add(p);
  }
  selected = next;
  anchorPage = null;
  syncFromSelection();
});

// ---------------------------------------------------------------------
// Synchronisation grille <-> champ texte
//
// `selected` est l'unique source de vérité. Les actions sur la grille
// appellent syncFromSelection(), qui met à jour la surbrillance des
// vignettes ET reformate le champ texte. Le champ texte, lui, n'est
// jamais réécrit pendant que l'utilisateur tape : sa frappe met à jour
// `selected` et la grille via un chemin séparé (onPageSpecInput).
// ---------------------------------------------------------------------

function refreshGridHighlight() {
  for (const [page, el] of thumbEls) {
    el.classList.toggle('is-selected', selected.has(page));
  }
}

function refreshSelectionCount() {
  if (!doc) return;
  selectionCountEl.textContent = `${selected.size} / ${doc.pageCount} sélectionnée(s)`;
}

function refreshExportButtonState() {
  const ready = Boolean(doc) && Boolean(dest) && selected.size > 0 && !exporting;
  exportBtn.disabled = !ready;
}

/** Appelé après une modification venant de la grille (clic, Tout, Rien, Inverser). */
function syncFromSelection() {
  refreshGridHighlight();
  refreshSelectionCount();
  refreshExportButtonState();
  const sorted = Array.from(selected).sort((a, b) => a - b);
  pageSpecInput.value = formatPageSpec(sorted);
  renderWarnings(pageSpecWarningsEl, []);
}

/** Appelé après une modification venant du champ texte. Ne réécrit jamais le champ. */
pageSpecInput.addEventListener('input', () => {
  if (!doc) return;
  const { pages, warnings } = parsePageSpec(pageSpecInput.value, doc.pageCount);
  selected = new Set(pages);
  anchorPage = null;
  refreshGridHighlight();
  refreshSelectionCount();
  refreshExportButtonState();
  renderWarnings(pageSpecWarningsEl, warnings);
});

// ---------------------------------------------------------------------
// Destination
// ---------------------------------------------------------------------

chooseDestBtn.addEventListener('click', async () => {
  hideError();
  try {
    const body = dest ? { defaultPath: dest } : {};
    const data = await postJSON('/api/choose-folder', body);
    if (data.cancelled) return;
    dest = data.path;
    destPathEl.textContent = dest;
    refreshExportButtonState();
  } catch (err) {
    showError(err.message);
  }
});

// ---------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------

function showExportProgress(done, total) {
  exportProgress.hidden = false;
  exportProgressBar.max = Math.max(total, 1);
  exportProgressBar.value = done;
  exportProgressCount.textContent = `${done} / ${total}`;
}

function hideExportProgress() {
  exportProgress.hidden = true;
  exportProgressBar.value = 0;
}

function hideExportResult() {
  exportResult.hidden = true;
  exportResultSummary.textContent = '';
  renderWarnings(exportResultWarnings, []);
}

function endExporting() {
  exporting = false;
  refreshExportButtonState();
  exportBtn.textContent = 'Exporter';
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
}

exportBtn.addEventListener('click', async () => {
  if (exportBtn.disabled || !doc || !dest) return;
  hideError();
  hideExportResult();
  exporting = true;
  exportBtn.textContent = 'Export en cours…';
  refreshExportButtonState();

  const pages = Array.from(selected).sort((a, b) => a - b);
  showExportProgress(0, pages.length);

  let data;
  try {
    data = await postJSON('/api/export', {
      docId: doc.docId,
      pages,
      dest,
      dpi: 300,
      format: 'png',
    });
  } catch (err) {
    hideExportProgress();
    endExporting();
    showError(err.message);
    return;
  }

  startExportEvents(data.exportId, pages.length);
});

function startExportEvents(exportId, total) {
  const es = new EventSource(`/api/export/${exportId}/events`);
  currentEventSource = es;

  es.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (err) {
      return;
    }
    if (msg.type === 'progress') {
      showExportProgress(msg.done, msg.total || total);
    } else if (msg.type === 'done') {
      hideExportProgress();
      lastExportFiles = Array.isArray(msg.files) ? msg.files : [];
      exportResultSummary.textContent =
        msg.files.length <= 1
          ? `${msg.files.length} fichier écrit.`
          : `${msg.files.length} fichiers écrits.`;
      renderWarnings(exportResultWarnings, msg.warnings);
      exportResult.hidden = false;
      endExporting();
    } else if (msg.type === 'error') {
      hideExportProgress();
      showError(msg.message);
      endExporting();
    }
  };

  es.onerror = () => {
    if (!currentEventSource) return; // déjà fermé proprement (done/error applicatif)
    hideExportProgress();
    showError("La connexion avec le serveur a été interrompue pendant l'export.");
    endExporting();
  };
}

revealBtn.addEventListener('click', async () => {
  // `open -R <dossier>` sélectionne le dossier dans sa fenêtre parente au lieu
  // de l'ouvrir : on révèle le premier fichier écrit, ce que l'utilisateur veut
  // réellement voir. Repli sur le dossier si l'export n'a rien produit.
  const target = lastExportFiles.length > 0 ? lastExportFiles[0] : dest;
  if (!target) return;
  hideError();
  try {
    await postJSON('/api/reveal', { path: target });
  } catch (err) {
    showError(err.message);
  }
});

// ---------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------

checkHealth();
