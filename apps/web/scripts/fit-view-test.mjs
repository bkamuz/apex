/**
 * Unit checks for plan/3D fit math (no WebGL).
 */
import {
  CAMERA_FOVY,
  planFitDistance,
  perspectiveFitDistance,
  sanitizeAabb,
} from '../src/viewport/fitView.ts';

const failures = [];
function check(label, ok) {
  console.log(`${ok ? '  ok  ' : ' FAIL '}${label}`);
  if (!ok) failures.push(label);
}

const room = sanitizeAabb({
  min: [0, 0, 0],
  max: [10, 3, 8],
});
if (!room) throw new Error('sanitize failed');

const aspect = 1400 / 900;
const dist = planFitDistance(room, aspect, CAMERA_FOVY);
const tanHalf = Math.tan(CAMERA_FOVY / 2);
const halfH = dist * tanHalf;
const halfW = halfH * aspect;
check('plan fit spans width', halfW * 2 >= 10 * 1.1);
check('plan fit spans depth', halfH * 2 >= 8 * 1.1);
check('plan fit is not over-zoomed (distance reasonable)', dist > 8 && dist < 80);

const huge = sanitizeAabb({
  min: [-2000, 0, -2000],
  max: [2000, 0, 2000],
});
check('sanitize clamps km helpers', huge?.max[0] === 500);

const persp = perspectiveFitDistance(room);
check('3D fit distance sane', persp > 6 && persp < 200);

if (failures.length) {
  console.error('\nFailed:', failures.join(', '));
  process.exit(1);
}
console.log('\nfit-view tests passed');
