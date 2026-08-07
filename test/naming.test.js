import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeBase, padWidth, slideFilename, resolveCollision } from '../lib/naming.js';

describe('sanitizeBase', () => {
  test('exemple du contrat : retire l extension .pdf', () => {
    assert.equal(sanitizeBase('Prez Client X.pdf'), 'Prez Client X');
  });

  test('extension .PDF en majuscules egalement retiree', () => {
    assert.equal(sanitizeBase('Prez Client X.PDF'), 'Prez Client X');
  });

  test('extension mixte .Pdf retiree', () => {
    assert.equal(sanitizeBase('rapport.Pdf'), 'rapport');
  });

  test('nom sans extension conserve tel quel', () => {
    assert.equal(sanitizeBase('rapport-annuel'), 'rapport-annuel');
  });

  test('nom avec plusieurs points : seule l extension finale est retiree', () => {
    assert.equal(sanitizeBase('v1.2.final.pdf'), 'v1.2.final');
  });

  test('caractere / retire', () => {
    assert.equal(sanitizeBase('dossier/fichier.pdf'), 'dossierfichier');
  });

  test('caractere \\0 retire', () => {
    assert.equal(sanitizeBase('fichier\0malveillant.pdf'), 'fichiermalveillant');
  });

  test('chaine d espaces -> slides', () => {
    assert.equal(sanitizeBase('    '), 'slides');
  });

  test('chaine vide -> slides', () => {
    assert.equal(sanitizeBase(''), 'slides');
  });

  test('nom devenant vide apres nettoyage -> slides', () => {
    assert.equal(sanitizeBase('.pdf'), 'slides');
  });

  test('espaces en bordure retires (trim)', () => {
    assert.equal(sanitizeBase('  Prez Client X  '), 'Prez Client X');
  });
});

describe('padWidth', () => {
  test('frontiere basse 9 -> largeur minimale 2', () => {
    assert.equal(padWidth(9), 2);
  });

  test('frontiere 10 -> largeur minimale 2', () => {
    assert.equal(padWidth(10), 2);
  });

  test('frontiere 99 -> encore 2', () => {
    assert.equal(padWidth(99), 2);
  });

  test('frontiere 100 -> passe a 3', () => {
    assert.equal(padWidth(100), 3);
  });

  test('180 -> 3', () => {
    assert.equal(padWidth(180), 3);
  });
});

describe('slideFilename', () => {
  test('exemple du contrat', () => {
    assert.equal(slideFilename('prez', 3, 180, 'png'), 'prez-slide-003.png');
  });

  test('pageCount 9, page 9 -> padding 2', () => {
    assert.equal(slideFilename('prez', 9, 9, 'png'), 'prez-slide-09.png');
  });

  test('pageCount 10, page 10 -> padding 2', () => {
    assert.equal(slideFilename('prez', 10, 10, 'png'), 'prez-slide-10.png');
  });

  test('pageCount 99, page 99 -> padding 2', () => {
    assert.equal(slideFilename('prez', 99, 99, 'png'), 'prez-slide-99.png');
  });

  test('pageCount 100, page 100 -> padding 3', () => {
    assert.equal(slideFilename('prez', 100, 100, 'png'), 'prez-slide-100.png');
  });

  test('pageCount 180, petite page paddee a 3 chiffres', () => {
    assert.equal(slideFilename('prez', 9, 180, 'png'), 'prez-slide-009.png');
  });

  test('extension jpeg respectee', () => {
    assert.equal(slideFilename('prez', 3, 180, 'jpeg'), 'prez-slide-003.jpeg');
  });
});

describe('resolveCollision', () => {
  test('aucune collision : nom inchange', () => {
    const taken = new Set(['b.png', 'c.png']);
    assert.equal(resolveCollision('a.png', taken), 'a.png');
  });

  test('une collision : suffixe -2', () => {
    const taken = new Set(['a.png']);
    assert.equal(resolveCollision('a.png', taken), 'a-2.png');
  });

  test('collisions en chaine : premier suffixe libre trouve', () => {
    const taken = new Set(['a.png', 'a-2.png', 'a-3.png']);
    assert.equal(resolveCollision('a.png', taken), 'a-4.png');
  });

  test('nom sans extension', () => {
    const taken = new Set(['rapport']);
    assert.equal(resolveCollision('rapport', taken), 'rapport-2');
  });

  test('nom avec plusieurs points : suffixe avant la derniere extension', () => {
    const taken = new Set(['v1.2.final.png']);
    assert.equal(resolveCollision('v1.2.final.png', taken), 'v1.2.final-2.png');
  });

  test('ne mute pas le Set recu', () => {
    const taken = new Set(['a.png', 'a-2.png']);
    const before = new Set(taken);
    resolveCollision('a.png', taken);
    assert.deepEqual(taken, before);
    assert.equal(taken.size, 2);
  });
});
