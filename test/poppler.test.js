import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findPoppler, getPageCount, renderRange } from '../lib/poppler.js';

const PDF_PATH = '/Users/Tim/Desktop/all/dev/perso/2020-Scrum-Guide-French.pdf';
const EXPECTED_PAGE_COUNT = 15; // confirme via `pdfinfo` sur la machine de test

const poppler = findPoppler();

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'slideshot-poppler-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('findPoppler localise pdftoppm et pdfinfo avec des chemins absolus', () => {
  assert.ok(poppler.pdftoppm, 'pdftoppm devrait etre trouve sur cette machine');
  assert.ok(poppler.pdfinfo, 'pdfinfo devrait etre trouve sur cette machine');
  assert.ok(path.isAbsolute(poppler.pdftoppm), 'le chemin de pdftoppm doit etre absolu');
  assert.ok(path.isAbsolute(poppler.pdfinfo), 'le chemin de pdfinfo doit etre absolu');
});

test('getPageCount renvoie le bon nombre de pages sur le PDF de test', async () => {
  const count = await getPageCount(poppler.pdfinfo, PDF_PATH);
  assert.equal(count, EXPECTED_PAGE_COUNT);
});

test("getPageCount rejette sur un fichier qui n'est pas un PDF", async () => {
  await withTempDir(async (dir) => {
    const fakePdf = path.join(dir, 'notapdf.txt');
    await writeFile(fakePdf, "ceci n'est pas un PDF, juste du texte.");
    await assert.rejects(() => getPageCount(poppler.pdfinfo, fakePdf));
  });
});

test('renderRange sur une plage d\'une seule page', async () => {
  await withTempDir(async (dir) => {
    const result = await renderRange({
      pdftoppmPath: poppler.pdftoppm,
      pdfPath: PDF_PATH,
      outDir: dir,
      prefix: '.slideshot-single',
      first: 3,
      last: 3,
      dpi: 72,
      format: 'png',
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].page, 3);
    const stats = await stat(result[0].path);
    assert.ok(stats.isFile(), 'le fichier rendu doit exister sur le disque');
  });
});

test('renderRange sur une plage de plusieurs pages', async () => {
  await withTempDir(async (dir) => {
    const result = await renderRange({
      pdftoppmPath: poppler.pdftoppm,
      pdfPath: PDF_PATH,
      outDir: dir,
      prefix: '.slideshot-multi',
      first: 1,
      last: 4,
      dpi: 72,
      format: 'png',
    });
    assert.equal(result.length, 4);
    assert.deepEqual(result.map((r) => r.page), [1, 2, 3, 4]);
    for (const entry of result) {
      const stats = await stat(entry.path);
      assert.ok(stats.isFile(), `${entry.path} doit exister sur le disque`);
    }
  });
});

test("renderRange sur une plage qui ne commence pas a 1 (piege du padding pdftoppm)", async () => {
  await withTempDir(async (dir) => {
    const result = await renderRange({
      pdftoppmPath: poppler.pdftoppm,
      pdfPath: PDF_PATH,
      outDir: dir,
      prefix: '.slideshot-offset',
      first: 5,
      last: 7,
      dpi: 72,
      format: 'png',
    });
    assert.equal(result.length, 3);
    const pages = result.map((r) => r.page);
    assert.deepEqual(pages, [5, 6, 7], 'les numeros de page reels doivent etre 5, 6, 7');
    assert.notDeepEqual(pages, [1, 2, 3], 'ne doit jamais retomber sur des indices relatifs a la plage');
  });
});

test('renderRange format jpeg produit des fichiers .jpg', async () => {
  await withTempDir(async (dir) => {
    const result = await renderRange({
      pdftoppmPath: poppler.pdftoppm,
      pdfPath: PDF_PATH,
      outDir: dir,
      prefix: '.slideshot-jpg',
      first: 2,
      last: 2,
      dpi: 72,
      format: 'jpeg',
    });
    assert.equal(result.length, 1);
    assert.ok(result[0].path.endsWith('.jpg'), `attendu .jpg, recu ${result[0].path}`);
  });
});

test('renderRange format png produit des fichiers .png', async () => {
  await withTempDir(async (dir) => {
    const result = await renderRange({
      pdftoppmPath: poppler.pdftoppm,
      pdfPath: PDF_PATH,
      outDir: dir,
      prefix: '.slideshot-png',
      first: 2,
      last: 2,
      dpi: 72,
      format: 'png',
    });
    assert.equal(result.length, 1);
    assert.ok(result[0].path.endsWith('.png'), `attendu .png, recu ${result[0].path}`);
  });
});

test('renderRange rejette explicitement quand le compte de fichiers ne correspond pas a la plage demandee', async () => {
  await withTempDir(async (dir) => {
    // La plage depasse le nombre reel de pages du document (15) : pdftoppm
    // s'arrete a la derniere page existante, produisant moins de fichiers
    // que prevu par (last - first + 1). Doit rejeter, jamais echouer en silence.
    await assert.rejects(
      () =>
        renderRange({
          pdftoppmPath: poppler.pdftoppm,
          pdfPath: PDF_PATH,
          outDir: dir,
          prefix: '.slideshot-overflow',
          first: 14,
          last: 20,
          dpi: 72,
          format: 'png',
        }),
      /Rendu incomplet/
    );
  });
});

test('renderRange sur des appels successifs partageant outDir et prefix (lots d\'export)', async () => {
  await withTempDir(async (dir) => {
    const shared = { pdftoppmPath: poppler.pdftoppm, pdfPath: PDF_PATH, outDir: dir, prefix: '.slideshot-shared', dpi: 72, format: 'png' };

    const first = await renderRange({ ...shared, first: 1, last: 3 });
    assert.deepEqual(first.map((r) => r.page), [1, 2, 3]);

    // Meme outDir, meme prefix, plage disjointe : ne doit voir que ses propres
    // fichiers, pas ceux laisses par le lot precedent.
    const second = await renderRange({ ...shared, first: 4, last: 6 });
    assert.deepEqual(second.map((r) => r.page), [4, 5, 6]);
    assert.equal(second.length, 3, 'ne doit pas remonter les 6 fichiers presents dans outDir');
  });
});

test('renderRange en parallele sur le meme outDir et le meme prefix (config reelle du serveur)', async () => {
  await withTempDir(async (dir) => {
    const shared = { pdftoppmPath: poppler.pdftoppm, pdfPath: PDF_PATH, outDir: dir, prefix: '.slideshot-parallel', dpi: 72, format: 'png' };

    const [batchA, batchB] = await Promise.all([
      renderRange({ ...shared, first: 1, last: 3 }),
      renderRange({ ...shared, first: 4, last: 6 }),
    ]);

    assert.deepEqual(batchA.map((r) => r.page), [1, 2, 3]);
    assert.deepEqual(batchB.map((r) => r.page), [4, 5, 6]);
  });
});
