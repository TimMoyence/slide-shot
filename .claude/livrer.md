# livrer — ce que slide-shot ajoute

Lu par la skill `atelier:livrer` avant de cadrer. Ce fichier l'emporte sur elle. Aucune dépendance npm : Node seul, plus poppler (`pdftoppm`, `pdfinfo`) installé par `npm run setup`.

## Boucle de step

- Commande ciblée : `node --test test/<sujet>.test.js`. Ni lint ni typecheck ne sont outillés.
- Un test qui lit un PDF passe par `test/fixtures/pdf-de-test.js` (15 pages, versionné), jamais par un fichier hors du dépôt.

## Commit

- Suite complète (ni CI ni hook git) : `npm test`.
- Message : `<type>: <phrase française>`.
