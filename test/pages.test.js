import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePageSpec, formatPageSpec, toRanges, chunkRanges } from '../lib/pages.js';

describe('parsePageSpec', () => {
  test('chaine vide -> aucune page, aucun warning', () => {
    assert.deepEqual(parsePageSpec('', 10), { pages: [], warnings: [] });
  });

  test('null -> aucune page, aucun warning', () => {
    assert.deepEqual(parsePageSpec(null, 10), { pages: [], warnings: [] });
  });

  test('undefined -> aucune page, aucun warning', () => {
    assert.deepEqual(parsePageSpec(undefined, 10), { pages: [], warnings: [] });
  });

  test('chaine composee uniquement d espaces -> aucune page, aucun warning', () => {
    assert.deepEqual(parsePageSpec('   ', 10), { pages: [], warnings: [] });
  });

  test('pageCount 0 -> aucune page, aucun warning', () => {
    assert.deepEqual(parsePageSpec('1,2,3', 0), { pages: [], warnings: [] });
  });

  test('pageCount negatif -> aucune page, aucun warning', () => {
    assert.deepEqual(parsePageSpec('1,2,3', -5), { pages: [], warnings: [] });
  });

  test('pageCount non entier -> aucune page, aucun warning', () => {
    assert.deepEqual(parsePageSpec('1,2,3', 3.5), { pages: [], warnings: [] });
  });

  test('page isolee simple', () => {
    assert.deepEqual(parsePageSpec('3', 10), { pages: [3], warnings: [] });
  });

  test('plage simple', () => {
    assert.deepEqual(parsePageSpec('2-4', 10), { pages: [2, 3, 4], warnings: [] });
  });

  test('separateurs melanges : virgule, point-virgule, espace', () => {
    assert.deepEqual(parsePageSpec('1, 3;5 7', 10), {
      pages: [1, 3, 5, 7],
      warnings: [],
    });
  });

  test('separateur retour ligne', () => {
    assert.deepEqual(parsePageSpec('1\n3\n5', 10), {
      pages: [1, 3, 5],
      warnings: [],
    });
  });

  test('espaces multiples entre fragments', () => {
    assert.deepEqual(parsePageSpec('1     3      5', 10), {
      pages: [1, 3, 5],
      warnings: [],
    });
  });

  test('plage inversee normalisee', () => {
    assert.deepEqual(parsePageSpec('8-5', 10), {
      pages: [5, 6, 7, 8],
      warnings: [],
    });
  });

  test('doublons fusionnes', () => {
    assert.deepEqual(parsePageSpec('3,3,3', 10), { pages: [3], warnings: [] });
  });

  test('chevauchement de plages fusionne', () => {
    assert.deepEqual(parsePageSpec('1-5,3-8', 10), {
      pages: [1, 2, 3, 4, 5, 6, 7, 8],
      warnings: [],
    });
  });

  test('page 0 ignoree avec warning', () => {
    assert.deepEqual(parsePageSpec('0', 10), {
      pages: [],
      warnings: [`La page 0 n'existe pas (le document en compte 10).`],
    });
  });

  test('page negative ignoree avec warning', () => {
    assert.deepEqual(parsePageSpec('-3', 10), {
      pages: [],
      warnings: [`La page -3 n'existe pas (le document en compte 10).`],
    });
  });

  test('page superieure a pageCount ignoree avec warning exact', () => {
    assert.deepEqual(parsePageSpec('200', 180), {
      pages: [],
      warnings: [`La page 200 n'existe pas (le document en compte 180).`],
    });
  });

  test('plage partiellement hors bornes tronquee avec un seul warning', () => {
    assert.deepEqual(parsePageSpec('175-200', 180), {
      pages: [175, 176, 177, 178, 179, 180],
      warnings: [`La plage 175-200 dépasse le document (180 pages).`],
    });
  });

  test('plage totalement hors bornes (superieure) : aucune page, warning de plage', () => {
    const result = parsePageSpec('190-200', 180);
    assert.deepEqual(result.pages, []);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0], `La plage 190-200 dépasse le document (180 pages).`);
  });

  test('fragment non reconnu : lettres', () => {
    assert.deepEqual(parsePageSpec('abc', 10), {
      pages: [],
      warnings: [`Expression non reconnue : « abc ».`],
    });
  });

  test('fragment non reconnu : double tiret', () => {
    assert.deepEqual(parsePageSpec('1--2', 10), {
      pages: [],
      warnings: [`Expression non reconnue : « 1--2 ».`],
    });
  });

  test('fragment non reconnu : tiret seul', () => {
    assert.deepEqual(parsePageSpec('-', 10), {
      pages: [],
      warnings: [`Expression non reconnue : « - ».`],
    });
  });

  test('melange de fragments valides et invalides : warnings et pages combines', () => {
    const result = parsePageSpec('1,abc,3', 10);
    assert.deepEqual(result.pages, [1, 3]);
    assert.deepEqual(result.warnings, [`Expression non reconnue : « abc ».`]);
  });

  test('pages triees en sortie meme si spec desordonnee', () => {
    assert.deepEqual(parsePageSpec('5,1,3', 10), { pages: [1, 3, 5], warnings: [] });
  });
});

describe('formatPageSpec', () => {
  test('liste vide -> chaine vide', () => {
    assert.equal(formatPageSpec([]), '');
  });

  test('page isolee', () => {
    assert.equal(formatPageSpec([4]), '4');
  });

  test('deux pages contigues fusionnees en plage', () => {
    assert.equal(formatPageSpec([1, 2]), '1-2');
  });

  test('exemple du contrat', () => {
    assert.equal(formatPageSpec([1, 3, 5, 6, 7, 8]), '1,3,5-8');
  });

  test('entree non triee normalisee', () => {
    assert.equal(formatPageSpec([8, 1, 6, 3, 7, 5]), '1,3,5-8');
  });

  test('doublons ignores', () => {
    assert.equal(formatPageSpec([1, 1, 2, 2, 3]), '1-3');
  });

  test('pages toutes eparses', () => {
    assert.equal(formatPageSpec([1, 3, 5, 7]), '1,3,5,7');
  });
});

describe('toRanges', () => {
  test('liste vide', () => {
    assert.deepEqual(toRanges([]), []);
  });

  test('page unique', () => {
    assert.deepEqual(toRanges([4]), [{ first: 4, last: 4 }]);
  });

  test('tout contigu', () => {
    assert.deepEqual(toRanges([1, 2, 3, 4]), [{ first: 1, last: 4 }]);
  });

  test('tout eparse', () => {
    assert.deepEqual(toRanges([1, 3, 5]), [
      { first: 1, last: 1 },
      { first: 3, last: 3 },
      { first: 5, last: 5 },
    ]);
  });

  test('exemple du contrat', () => {
    assert.deepEqual(toRanges([1, 3, 5, 6, 7, 8]), [
      { first: 1, last: 1 },
      { first: 3, last: 3 },
      { first: 5, last: 8 },
    ]);
  });

  test('entree non triee normalisee avant regroupement', () => {
    assert.deepEqual(toRanges([8, 7, 1, 6, 5, 3]), [
      { first: 1, last: 1 },
      { first: 3, last: 3 },
      { first: 5, last: 8 },
    ]);
  });
});

describe('chunkRanges', () => {
  test('liste vide', () => {
    assert.deepEqual(chunkRanges([], 10), []);
  });

  test('plage unique sous le maximum : inchangee', () => {
    assert.deepEqual(chunkRanges([{ first: 1, last: 5 }], 10), [{ first: 1, last: 5 }]);
  });

  test('plage exactement au maximum : inchangee', () => {
    assert.deepEqual(chunkRanges([{ first: 1, last: 10 }], 10), [{ first: 1, last: 10 }]);
  });

  test('plage depassant le maximum : decoupee en lots', () => {
    assert.deepEqual(chunkRanges([{ first: 1, last: 25 }], 10), [
      { first: 1, last: 10 },
      { first: 11, last: 20 },
      { first: 21, last: 25 },
    ]);
  });

  test('plusieurs plages, certaines decoupees', () => {
    assert.deepEqual(
      chunkRanges(
        [
          { first: 1, last: 3 },
          { first: 10, last: 25 },
        ],
        10
      ),
      [
        { first: 1, last: 3 },
        { first: 10, last: 19 },
        { first: 20, last: 25 },
      ]
    );
  });

  test('propriete : ordre et couverture exacte preserves sur 180 pages decoupees par 10', () => {
    const pages = Array.from({ length: 180 }, (_, i) => i + 1);
    const ranges = toRanges(pages);
    const chunks = chunkRanges(ranges, 10);

    // Aucun lot ne dépasse la taille maximale
    for (const chunk of chunks) {
      assert.ok(chunk.last - chunk.first + 1 <= 10);
      assert.ok(chunk.first <= chunk.last);
    }

    // Reconstitution de toutes les pages couvertes, dans l'ordre
    const covered = [];
    for (const chunk of chunks) {
      for (let p = chunk.first; p <= chunk.last; p++) covered.push(p);
    }
    assert.deepEqual(covered, pages);
  });

  test('propriete sur plage eparse decoupee : aucune page perdue ni dupliquee', () => {
    const pages = [1, 2, 3, 10, 11, 12, 13, 14, 15, 16, 17, 18, 50];
    const ranges = toRanges(pages);
    const chunks = chunkRanges(ranges, 5);

    const covered = [];
    for (const chunk of chunks) {
      for (let p = chunk.first; p <= chunk.last; p++) covered.push(p);
    }
    assert.deepEqual(covered, pages);
    for (const chunk of chunks) {
      assert.ok(chunk.last - chunk.first + 1 <= 5);
    }
  });
});
