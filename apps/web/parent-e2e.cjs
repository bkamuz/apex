// Exercises the parent relation through the real wasm + UI:
// nesting depth, level inheritance, cycle refusal, detach.
const { chromium } = require('playwright');

const URL = process.env.APEX_SMOKE_URL || 'http://127.0.0.1:5175/';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 20000 });

  // The UI drives elements through wasm; expose a probe by reading the scene the
  // app already renders. Click New to start clean.
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.waitForTimeout(500);

  // Helper injected into the page: talk to the wasm module directly.
  await page.addInitScript(() => {});
  const probe = await page.evaluate(async () => {
    const mod = await import('/src/wasm/apex.ts');
    return typeof mod.apexSetElementParent;
  });
  console.log('apexSetElementParent reachable from page:', probe);

  const result = await page.evaluate(async () => {
    const mod = await import('/src/wasm/apex.ts');
    const out = {};

    // Two levels.
    const lvl0 = mod.apexGetScene().levels[0];
    const lvl1 = mod.apexCreateLevel('L1', 3.0).levels.find((l) => l.name === 'L1');
    out.levels = [lvl0?.name, lvl1?.name];

    // Wall on level 1.
    mod.apexSetActiveLevel(lvl1.id);
    const wall = mod.apexCreateElement('apex.wall', [[0, 3, 0], [4, 3, 0]], undefined, 0, 'two_point');
    const wallId = wall.elements.find((e) => e.component_id === 'apex.wall')?.id;
    out.wallId = !!wallId;

    // Column on level 0, then re-parent onto the wall.
    mod.apexSetActiveLevel(lvl0.id);
    const col = mod.apexCreateElement('apex.column', [[1, 0, 0]], undefined, 0, 'point');
    const colId = col.elements.find((e) => e.component_id === 'apex.column')?.id;

    mod.apexSetElementParent(colId, wallId);
    out.childEffectiveLevel = mod.apexEffectiveLevelOf(colId);
    out.parentLevel = mod.apexEffectiveLevelOf(wallId);
    out.level1Id = lvl1.id;
    out.level0Id = lvl0.id;
    out.inherited = mod.apexEffectiveLevelOf(colId) === lvl1.id;
    out.childrenOfWall = mod.apexChildrenOf(wallId);
    out.ownLevelOfChild = mod
      .apexListElements()
      .find((e) => e.id === colId)?.level_id;

    // Nesting: the column itself becomes a parent.
    mod.apexSetActiveLevel(lvl0.id);
    const beam = mod.apexCreateElement('apex.beam', [[2, 0, 0], [5, 0, 0]], undefined, 0, 'two_point');
    const beamId = beam.elements.find((e) => e.component_id === 'apex.beam')?.id;
    mod.apexSetElementParent(beamId, colId);
    out.grandchildEffectiveLevel = mod.apexEffectiveLevelOf(beamId);
    out.descendantsOfWall = mod.apexDescendantsOf(wallId);
    out.nestingDepth = mod.apexDescendantsOf(wallId).length;

    // Cycle must be refused.
    try {
      mod.apexSetElementParent(wallId, beamId);
      out.cycleRefused = false;
    } catch (e) {
      out.cycleRefused = true;
      out.cycleMessage = String(e);
    }

    // Detach.
    mod.apexSetElementParent(colId, null);
    out.afterDetachLevel = mod.apexEffectiveLevelOf(colId);
    out.beamStillOnColumn = mod.apexDescendantsOf(colId).includes(beamId);
    out.parentAfterDetach = mod
      .apexListElements()
      .find((e) => e.id === colId)?.parent_id ?? null;
    return out;
  });

  console.log(JSON.stringify(result, null, 2));

  const failures = [];
  if (!result.inherited) failures.push('child did not inherit the parent level');
  if (result.nestingDepth !== 2) failures.push(`nesting depth was ${result.nestingDepth}, expected 2`);
  if (!result.cycleRefused) failures.push('a cycle was NOT refused');
  if (!result.beamStillOnColumn) failures.push('detach lost the grandchild');
  if (result.parentAfterDetach !== null)
    failures.push('detach left a parent_id behind');
  if (result.afterDetachLevel !== result.ownLevelOfChild)
    failures.push(
      `detach did not restore the own level: ${result.afterDetachLevel} vs ${result.ownLevelOfChild}`,
    );
  if (errors.length) failures.push('console errors: ' + JSON.stringify(errors));

  await browser.close();
  if (failures.length) {
    console.log('FAIL:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('PASS: nesting, inheritance, cycle refusal and detach all behave');
})();
