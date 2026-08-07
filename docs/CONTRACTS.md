# slide-shot — contrats d'interface

Source de vérité unique. Chaque lot code **contre** ces signatures sans les modifier.
Si un contrat te semble faux, signale-le dans ton rapport — ne le change pas unilatéralement.

## Contexte produit

Mini app locale macOS. L'utilisateur glisse un PDF de présentation (jusqu'à ~200 slides),
sélectionne des slides, choisit un dossier via le dialogue macOS natif, et l'app écrit
un PNG 300 DPI par slide **directement dans ce dossier** (jamais via le navigateur).

Le rendu est délégué à poppler (`pdftoppm`, `pdfinfo`), installé via Homebrew.
Node >= 18, ESM (`import`/`export`), **zéro dépendance npm**.

## Conventions

- Modules ESM. Tests avec `node:test` + `node:assert/strict`.
- Messages destinés à l'utilisateur : en français, avec les accents corrects.
- Noms de code, variables, fonctions : en anglais.
- Numéros de page : **1-indexés** partout (page 1 = première slide).

---

## `lib/pages.js` — sélection de pages (logique pure, aucun I/O)

```js
/**
 * Analyse une expression de selection.
 * Separateurs acceptes : virgule, point-virgule, espace, retour ligne.
 * Plage inversee ("8-5") : normalisee en 5-8.
 * Doublons et chevauchements : fusionnes.
 * @returns {{ pages: number[], warnings: string[] }} pages triees croissant, uniques
 */
export function parsePageSpec(spec, pageCount)

/**
 * Formate une liste de pages en expression compacte.
 * [1,3,5,6,7,8] -> "1,3,5-8"   []  -> ""
 */
export function formatPageSpec(pages)

/**
 * Regroupe des pages en plages contigues, pour limiter le nombre
 * d'invocations de pdftoppm.
 * [1,3,5,6,7,8] -> [{first:1,last:1},{first:3,last:3},{first:5,last:8}]
 */
export function toRanges(pages)

/**
 * Redecoupe des plages en lots d'au plus maxPages pages, pour alimenter
 * la barre de progression. L'ordre et la couverture sont preserves.
 */
export function chunkRanges(ranges, maxPages)
```

Règles de `parsePageSpec` :

- hors bornes (`< 1` ou `> pageCount`) → page ignorée + warning
  `` `La page 200 n'existe pas (le document en compte 180).` ``
- fragment non reconnu → warning `` `Expression non reconnue : « abc ».` ``
- une plage partiellement hors bornes est tronquée aux bornes valides, avec un
  seul warning pour la plage : `` `La plage 175-200 dépasse le document (180 pages).` ``
- `spec` vide / `null` / `undefined` → `{ pages: [], warnings: [] }`
- `pageCount` invalide (`0`, négatif, non entier) → `{ pages: [], warnings: [] }`

## `lib/naming.js` — nommage des fichiers (logique pure, aucun I/O)

```js
/** "Prez Client X.pdf" -> "Prez Client X". Retire / et \0, trim, "slides" si vide. */
export function sanitizeBase(filename)

/** Largeur du zero-padding : 2 minimum, 3 des 100 pages. padWidth(180) === 3 */
export function padWidth(pageCount)

/** slideFilename("prez", 3, 180, "png") -> "prez-slide-003.png" */
export function slideFilename(base, page, pageCount, ext)

/**
 * Resout une collision contre un Set de noms deja pris.
 * "a.png" pris -> "a-2.png" ; "a-2.png" pris aussi -> "a-3.png"
 * N'ajoute rien au Set : c'est a l'appelant de le faire.
 */
export function resolveCollision(filename, taken)
```

## `lib/poppler.js` — pont vers poppler

```js
/**
 * Localise les binaires. Cherche dans PATH, puis /opt/homebrew/bin,
 * /usr/local/bin, /usr/bin (le PATH est souvent ampute hors terminal).
 * @returns {{ pdftoppm: string|null, pdfinfo: string|null }} chemins absolus
 */
export function findPoppler()

/** @returns {Promise<number>} nombre de pages. Rejette si le PDF est illisible. */
export async function getPageCount(pdfinfoPath, pdfPath)

/**
 * Rend les pages [first..last] dans outDir.
 * format: 'png' | 'jpeg'.
 * Les fichiers produits s'appellent `${prefix}-<page paddee>.<ext>`.
 * @returns {Promise<Array<{page:number, path:string}>>} trie par page croissante
 */
export async function renderRange({ pdftoppmPath, pdfPath, outDir, prefix, first, last, dpi, format })
```

`renderRange` doit **apparier chaque fichier produit a son numero de page reel**.
`pdftoppm` choisit lui-même son zero-padding selon le nombre de pages du document :
ne le suppose pas — liste `outDir` après le rendu, filtre sur `prefix`, et extrais
le numéro du suffixe. Rejette si le nombre de fichiers ne correspond pas à la plage.

## `lib/finder.js` — dialogues macOS (`osascript`)

```js
/** @returns {Promise<string|null>} chemin POSIX, ou null si annule */
export async function chooseFolder(defaultPath)

/** Dialogue filtre sur les PDF. @returns {Promise<string|null>} */
export async function chooseFile(defaultPath)

/** Revele un fichier ou dossier dans le Finder. */
export async function reveal(targetPath)
```

L'annulation d'un dialogue fait sortir `osascript` en erreur (code 1, « User canceled ») :
c'est un cas nominal, il doit donner `null`, jamais une exception.

---

## Serveur HTTP — `server.js`

Écoute sur `127.0.0.1:4321` **uniquement** (jamais `0.0.0.0`).
Toutes les réponses d'erreur : `{ error: "message en francais" }` avec un statut adapté.

**Garde d'origine.** Avant tout routage et tout effet de bord, chaque requête est
filtrée : l'en-tête `Host` doit valoir `127.0.0.1:<port>` ou `localhost:<port>`, et
un `Origin` présent doit désigner l'une de ces deux autorités en `http://`. Sinon,
`403`. Un `Origin` absent est légitime (curl, `EventSource`) et accepté. Aucun
en-tête CORS n'est émis.

Sans cette garde, n'importe quelle page web visitée pendant que l'app tourne peut
déclencher les dialogues macOS natifs, et par DNS rebinding lire un PDF arbitraire
du disque via `/api/open` puis `/api/thumb`.

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| `GET` | `/` | — | `public/index.html` |
| `GET` | `/app.js`, `/style.css` | — | statique depuis `public/` |
| `GET` | `/api/health` | — | `{ ok, pdftoppm, pdfinfo }` — `ok:false` si poppler manque |
| `POST` | `/api/choose-file` | — | `{ path }` ou `{ cancelled: true }` |
| `POST` | `/api/choose-folder` | `{ defaultPath? }` | `{ path }` ou `{ cancelled: true }` |
| `POST` | `/api/open` | `{ path }` | `{ docId, name, base, pageCount }` |
| `POST` | `/api/upload` | corps binaire brut, header `x-filename` | `{ docId, name, base, pageCount }` |
| `GET` | `/api/thumb/:docId/:page` | — | image JPEG |
| `POST` | `/api/export` | `{ docId, pages, dest, dpi, format }` | `{ exportId }` |
| `GET` | `/api/export/:exportId/events` | — | flux SSE (voir plus bas) |
| `POST` | `/api/reveal` | `{ path }` | `{ ok: true }` |

Détails :

- **`/api/open`** charge un PDF déjà présent sur le disque (bouton « Parcourir… ») :
  aucune copie, on retient le chemin. **`/api/upload`** reçoit un PDF glissé-déposé
  et l'écrit dans le dossier temporaire de session. Les deux valident la signature
  `%PDF` en tête de fichier et rejettent le reste en `400`.
- `base` = `sanitizeBase(name)`, renvoyé pour préremplir le champ de préfixe côté UI.
- **Miniatures** : générées en tâche de fond dès l'ouverture du document
  (une seule invocation `renderRange` sur tout le document, `jpeg`, 30 DPI).
  `/api/thumb/:docId/:page` sert le fichier ; s'il n'est pas encore écrit, la route
  attend qu'il apparaisse (poll 100 ms, plafond 60 s) avant de répondre `404`.
  Si la passe de miniatures a échoué, la route répond `500` en portant le message
  réel de poppler, et le frontend affiche un bandeau — une seule fois, pas une par
  vignette. Un `404` muet laisserait l'utilisateur devant 180 icônes cassées sans
  explication.
- **Export** : `POST /api/export` valide puis répond immédiatement `{ exportId }` ;
  le travail démarre à la connexion SSE. Les pages sont regroupées via
  `toRanges` puis `chunkRanges(ranges, 10)`, un lot = un `renderRange`.
  Le rendu écrit **directement dans `dest`** avec le préfixe temporaire
  `.slideshot-<exportId>`, puis chaque fichier est renommé vers son nom final
  (`slideFilename` + `resolveCollision` contre le contenu réel du dossier).
  Rendre dans `dest` garantit un `rename` sur le même volume : aucune copie
  de plusieurs centaines de Mo. Tout `.slideshot-*` restant est nettoyé,
  y compris en cas d'échec.
- **Arrêt et récupération.** Le dossier de destination appartient à l'utilisateur :
  y abandonner des fichiers cachés est le pire défaut possible de cette app, car ils
  sont invisibles dans le Finder. Trois mécanismes s'enchaînent. À l'arrêt, les
  processus `pdftoppm` en vol sont terminés (SIGTERM, puis SIGKILL) et leur mort
  réellement attendue avant le balayage — sans quoi ils continuent d'écrire dans le
  dossier après la sortie du serveur. Les `dest` des exports en cours sont tenus
  dans un registre, seul moyen de savoir quoi balayer. Enfin, un journal
  `active-exports.jsonl` dans le dossier de session permet au démarrage suivant de
  rattraper une mort brutale : la nouvelle session lit le journal des sessions dont
  le PID est mort, balaie leurs résidus, et **adopte** ce qu'elle ne peut pas encore
  nettoyer pour le retransmettre à son propre successeur.
  Invariant absolu, à tous les étages : **on ne supprime que les résidus portant son
  propre `exportId`**.

Deux modules internes complètent le serveur : `lib/sessions.js` (registre en mémoire
des documents, des exports actifs, et cycle de vie du dossier temporaire) et
`lib/export-job.js` (déroulé d'un export : rendu des lots en parallèle, renommage
déterministe, balayage des résidus).
- **Événements SSE** (`data:` = JSON, un par ligne) :
  - `{ type: "progress", done, total, page }` après chaque page écrite
  - `{ type: "done", files: string[], warnings: string[] }`
  - `{ type: "error", message }`
- `/api/export` rejette en `400` : `dest` absent ou non accessible en écriture,
  `pages` vide, `docId` inconnu.

## Frontend — `public/index.html`, `public/app.js`, `public/style.css`

Vanilla, aucun framework, aucun CDN (l'app doit tourner hors ligne).
`app.js` est chargé en `<script type="module" src="/app.js">`.

Parcours :

1. **Zone de dépôt** plein écran : glisser un PDF → `POST /api/upload`.
   Bouton « Parcourir… » à côté → `POST /api/choose-file` puis `POST /api/open`.
2. **Grille de miniatures** : une vignette par page, numérotée, `loading="lazy"`
   sur chaque `<img src="/api/thumb/...">` (il peut y en avoir 200).
   Clic = bascule la sélection. **Shift+clic** = sélectionne la plage depuis
   la dernière vignette cliquée. Boutons « Tout », « Rien », « Inverser ».
3. **Champ texte** `1,3,5-8` synchronisé **dans les deux sens** avec la grille :
   la frappe met à jour la grille (via `parsePageSpec` côté serveur ? non —
   le champ est parsé côté client par une copie légère de la même logique :
   importe `/lib/pages.js`, servi en statique, pour ne pas dupliquer la logique).
   Les warnings de parsing s'affichent sous le champ.
4. **Destination** : bouton « Choisir le dossier… » → `POST /api/choose-folder`.
   Le chemin retenu est affiché. Le bouton « Exporter » reste désactivé tant
   qu'il manque une destination ou une sélection.
5. **Export** : barre de progression alimentée par le SSE, avec le compte
   `12 / 180`. À la fin : le nombre de fichiers écrits, les warnings éventuels,
   et un bouton « Afficher dans le Finder » → `POST /api/reveal`.
6. Si `/api/health` renvoie `ok:false`, l'app affiche à la place un écran
   expliquant d'installer poppler (`npm run setup` ou `brew install poppler`),
   avec un bouton « Réessayer ».

Note : `server.js` sert donc aussi `/lib/pages.js` en statique, pour que le
frontend et le serveur partagent exactement le même parseur.

Style : sobre, dense, lisible. Fond clair, une seule couleur d'accent pour la
sélection. Pas de dépendance externe, pas d'animation gratuite. La grille doit
rester fluide à 200 vignettes.
