import test from 'node:test';
import assert from 'node:assert/strict';
import { APEXGENUS_VERSION, decodeGenusFile, encodeGenusFile, genusFile, importCommands } from '../src/genusEditor/apexgenus.ts';
import { blankGenusDraft, type GenusDraft } from '../src/genusEditor/model.ts';
import { closeProjectTest, leaveNeedsPrompt, openProjectTest } from '../src/genusEditor/projectPreview.ts';
import { deleteGenusFromLibrary, memoryLibraryStore, saveGenusToLibrary } from '../src/genusEditor/library.ts';
import { planLibraryInsert } from '../src/genusEditor/libraryInsert.ts';
import { retargetGenusId } from '../src/genusEditor/params.ts';
import { en } from '../src/i18n/catalogs/en.ts';
import { ru } from '../src/i18n/catalogs/ru.ts';

const rich = (): GenusDraft => ({
  id: 'user.shelf',
  name: 'Shelf',
  category: 'furniture',
  purpose: 'A shelf',
  extends: 'user.base',
  placement: { kind: 'point' },
  params: [
    { id: 'width', default: 1.2, species: true },
    { id: 'height', default: 0.4 },
    { id: 'show', kind: 'bool', default: true },
  ],
  refs: [
    { id: 'left', ref: 'plane', origin: [0, 0, 0], normal: 'x' },
    { id: 'edge', ref: 'polyline', points: [[0, 'height', 0], ['width', 'height', 0]] },
  ],
  body: [
    { id: 'board', item: 'solid', shape: 'box', min: [0, 0, 0], max: ['width', 'height', 0.4], material: 'oak' },
    {
      id: 'lip',
      item: 'solid',
      shape: 'prism',
      normal: 'y',
      depth: [0, 0.02],
      sketch: [{ kind: 'rect', a: [0, 0], b: ['width', 0.4] }],
    },
    { id: 'notch', item: 'cut', shape: 'box', min: [0.2, 0, -0.1], max: [0.5, 0.2, 0.5], targets: { self: true, host: true, neighbours: ['wall'] } },
    {
      id: 'leg',
      item: 'nested',
      genus: 'user.leg',
      at: 'left',
      offset: [0.05, 0, 0.05],
      rotation: 90,
      mirror: true,
      params: { height: 'height - 0.04' },
    },
  ],
  dims: [{ id: 'w', from: 'left', to: 'right', param: 'width', locked: true }],
  remove: ['old'],
});

test('apexgenus round-trip keeps params, species, refs, dims, sketches, solids, cuts, nested genera and mirror', () => {
  const species = [{ id: 'user.shelf.oak', name: 'Oak', values: { width: 1.5, show: true } }];
  const text = encodeGenusFile(rich(), species);
  const decoded = decodeGenusFile(text);
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.deepEqual(decoded.file, genusFile(rich(), species));
  assert.equal(encodeGenusFile(decoded.file.genus, decoded.file.species), text);
  const leg = decoded.file.genus.body.find((b) => b.id === 'leg');
  assert.ok(leg && leg.item === 'nested' && leg.mirror === true);
  const lip = decoded.file.genus.body.find((b) => b.id === 'lip');
  assert.ok(lip && lip.item === 'solid' && lip.shape === 'prism' && lip.sketch?.length === 1);
});

test('a newer or broken genus file is refused with a code', () => {
  const newer = decodeGenusFile(JSON.stringify({ format: 'apexgenus', version: APEXGENUS_VERSION + 1, genus: { id: 'user.a', name: 'A', body: [] }, species: [] }));
  assert.deepEqual(newer, { ok: false, code: 'versionNewer', version: APEXGENUS_VERSION + 1 });
  assert.equal(decodeGenusFile('not json').ok, false);
  assert.equal(decodeGenusFile('{}').ok, false);
  const badFormat = decodeGenusFile(JSON.stringify({ format: 'other', version: 1 }));
  assert.ok(!badFormat.ok && badFormat.code === 'format');
  const zero = decodeGenusFile(JSON.stringify({ format: 'apexgenus', version: 0, genus: {}, species: [] }));
  assert.ok(!zero.ok && zero.code === 'version');
  const builtIn = decodeGenusFile(JSON.stringify({ format: 'apexgenus', version: 1, genus: { id: 'apex.window', name: 'Window', body: [] }, species: [] }));
  assert.ok(!builtIn.ok && builtIn.code === 'builtIn');
  const noBody = decodeGenusFile(JSON.stringify({ format: 'apexgenus', version: 1, genus: { id: 'user.a', name: 'A' }, species: [] }));
  assert.ok(!noBody.ok && noBody.code === 'body');
});

test('import commands are define_genus plus each species', () => {
  const file = genusFile(blankGenusDraft('user.custom', 'Box'), [{ id: 'user.custom.wide', name: 'Wide', values: { width: 2 } }]);
  const cmds = importCommands(file);
  assert.equal(cmds[0].op, 'define_genus');
  assert.equal(cmds[0].id, 'user.custom');
  assert.equal(cmds[1].op, 'create_species');
  assert.equal((cmds[1].params as { width: number }).width, 2);
});

test('apply keeps the preview and discard restores the baseline', () => {
  const testSession = openProjectTest('{"before":true}');
  assert.equal(closeProjectTest(testSession, 'apply').restore, null);
  assert.equal(closeProjectTest(testSession, 'discard').restore, '{"before":true}');
  assert.equal(leaveNeedsPrompt(true), true);
  assert.equal(leaveNeedsPrompt(false), false);
});

test('library save, list and delete round-trip the file', async () => {
  const store = memoryLibraryStore();
  const draft = rich();
  const species = [{ id: 'user.shelf.oak', name: 'Oak', values: { width: 1.5 } }];
  await saveGenusToLibrary(draft, species, store, '2026-01-01T00:00:00.000Z');
  await saveGenusToLibrary({ ...draft, name: 'Shelf 2' }, species, store, '2026-01-02T00:00:00.000Z');
  const rows = await store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Shelf 2');
  assert.equal(rows[0].file.genus.body.length, draft.body.length);
  assert.equal(rows[0].file.genus.body.find((b) => b.id === 'leg' && b.item === 'nested')?.mirror, true);
  await deleteGenusFromLibrary(draft.id, store);
  assert.deepEqual(await store.list(), []);
});

test('retargeting a new genus id moves species ids with it', () => {
  const draft = blankGenusDraft('user.custom', 'Box');
  const next = retargetGenusId(draft, [{ id: 'user.custom.wide', name: 'Wide', values: { width: 2 } }], 'user.smoke.box');
  assert.equal(next.draft.id, 'user.smoke.box');
  assert.equal(next.species[0].id, 'user.smoke.box.wide');
});

test('inserting a genus that is already in the project is reported, and replace is only offered when nothing is placed', () => {
  assert.deepEqual(planLibraryInsert(false, 0), { kind: 'insert' });
  assert.deepEqual(planLibraryInsert(false, 2), { kind: 'insert' });
  assert.deepEqual(planLibraryInsert(true, 0), { kind: 'already', replace: true });
  assert.deepEqual(planLibraryInsert(true, 3), { kind: 'already', replace: false });
  assert.equal(ru['browser.library.already'], 'Род уже есть в проекте');
  assert.equal(en['browser.library.already'], 'Genus is already in the project');
  assert.equal(ru['browser.library.inserted'], 'Род вставлен в проект');
  assert.ok(en['browser.library.inserted']);
  assert.equal(ru['browser.library.replace'], 'Заменить');
  assert.equal(en['browser.library.updated'], 'Genus updated in the project');
  assert.equal(ru['browser.library.updated'], 'Род обновлён в проекте');
});

test('a blank genus is a point-placed box', () => {
  const draft = blankGenusDraft('user.custom', 'New genus');
  assert.equal(draft.placement?.kind, 'point');
  assert.equal(draft.body[0].item, 'solid');
  assert.equal(draft.params.find((p) => p.id === 'height')?.default, 1);
});
