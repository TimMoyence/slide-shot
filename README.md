# slide-shot

**Extrait les slides d'un PDF de présentation en images PNG haute définition.**

Tout se passe en local : aucun fichier ne quitte ta machine, aucun serveur
distant n'est contacté, aucune dépendance npm n'est téléchargée.

Glisse ton PDF, coche les slides voulues, choisis un dossier — l'app y écrit un
PNG 300 DPI par slide.

![macOS](https://img.shields.io/badge/macOS-uniquement-black)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-brightgreen)
![Dépendances](https://img.shields.io/badge/dépendances%20npm-0-blue)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## Démarrage rapide

```bash
git clone https://github.com/TimMoyence/slide-shot.git
cd slide-shot
npm run setup     # vérifie et installe les prérequis
npm start         # lance l'app
```

L'application s'ouvre toute seule dans le navigateur sur
**http://127.0.0.1:4321**. Pour l'arrêter : `Ctrl+C` dans le Terminal.

---

## Prérequis

Le script `npm run setup` vérifie tout et installe ce qui manque. Il a besoin de
deux choses :

| Outil | Rôle | Si absent |
|---|---|---|
| **Node.js ≥ 18** | fait tourner l'app | à installer depuis [nodejs.org](https://nodejs.org) (version LTS) |
| **poppler** | moteur de rendu PDF (`pdftoppm`, `pdfinfo`) | installé automatiquement via Homebrew |

Si Homebrew manque aussi, le script affiche la ligne à coller pour l'installer.

> **Aucune dépendance npm** : pas de `npm install` à faire. Le dossier
> fonctionne tel quel une fois Node et poppler présents.

---

## Utilisation

```bash
npm start
```

1. **Charge le PDF** — glisse-le dans la fenêtre, ou clique « Parcourir… ».
   Pour un gros fichier, préfère « Parcourir… » : l'app lit le PDF là où il est
   au lieu d'en copier plusieurs centaines de Mo.
2. **Sélectionne les slides** — clique les vignettes, ou tape une plage comme
   `1,3,5-8` dans le champ. `Shift`+clic sélectionne d'un coup toutes les
   vignettes entre deux points.
3. **Choisis le dossier** de destination — le dialogue macOS habituel s'ouvre.
4. **Exporte.** Les PNG sont écrits directement dans ce dossier, en 300 DPI.

### Nommage des fichiers

Les images s'appellent `<nom-du-pdf>-slide-003.png`. Le numéro est aligné sur la
taille du document (`003` pour un PDF de 200 slides, `03` pour un PDF de 20).

Un fichier déjà présent **n'est jamais écrasé** : l'app ajoute un suffixe `-2`,
`-3`, etc.

### Et les fichiers PowerPoint ?

slide-shot ne prend que des PDF. Depuis PowerPoint, fais
**Fichier → Enregistrer sous…** et choisis le format PDF, puis glisse ce PDF
dans l'app. Le rendu est ainsi exactement celui de PowerPoint, sans
approximation de polices.

---

## Dépannage

| Symptôme | Solution |
|---|---|
| `poppler est manquant` | relance `npm run setup`, ou installe-le à la main : `brew install poppler` |
| poppler installé mais toujours introuvable | ouvre un **nouveau** Terminal (le `PATH` n'est pas rechargé) puis relance |
| `EADDRINUSE` / le port 4321 est occupé | lance avec un autre port : `SLIDESHOT_PORT=4400 npm start` |
| Le navigateur ne s'ouvre pas | ouvre manuellement http://127.0.0.1:4321 |
| Node.js trop ancien | mets-le à jour depuis [nodejs.org](https://nodejs.org) (version 18 minimum) |

---

## Développement

```bash
npm test        # suite de tests (node:test, sans aucune dépendance)
```

### Variables d'environnement

| Variable | Effet |
|---|---|
| `SLIDESHOT_PORT` | change le port d'écoute (`4321` par défaut) |
| `SLIDESHOT_NO_OPEN` | démarre sans ouvrir le navigateur |

### Architecture

```
server.js          serveur HTTP local, routes et orchestration
lib/finder.js      localise poppler sur la machine
lib/poppler.js     appelle pdftoppm / pdfinfo
lib/pages.js       parsing des plages de pages (« 1,3,5-8 »)
lib/naming.js      nommage des fichiers et gestion des collisions
lib/sessions.js    cycle de vie d'un PDF chargé
lib/export-job.js  déroulement d'un export
public/            interface (HTML/CSS/JS, sans framework)
test/              tests unitaires node:test
```

[`docs/CONTRACTS.md`](docs/CONTRACTS.md) est la source de vérité des interfaces
entre modules : signatures, conventions, invariants.

### Sécurité

Le serveur n'écoute que sur `127.0.0.1` : rien n'est exposé au réseau local.

---

## Contribuer

La branche `main` est protégée : pas de push direct, tout passe par une Pull
Request validée.

```bash
git checkout -b ma-fonctionnalite
# ... tes modifications
npm test
git push -u origin ma-fonctionnalite
```

Puis ouvre une Pull Request. Les tests doivent passer et les contrats de
`docs/CONTRACTS.md` doivent être respectés.

---

## Limites connues

- **macOS uniquement.** Les dialogues de choix de fichier et de dossier passent
  par `osascript`, et poppler est installé via Homebrew.
- Un seul PDF à la fois.

---

## Licence

[MIT](LICENSE) — © 2026 Tim Kraken
