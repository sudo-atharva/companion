// Touchscreen calibration via the X11 libinput "Calibration Matrix" (needs the `xinput` package).
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const TOUCH_NAME = /touch|ads7846|xpt2046|ft5406|ft5x06|goodix|ili2|egalax|waveshare/i;

function xinput(args) {
  return new Promise((resolve, reject) =>
    execFile('xinput', args, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );
}

async function findTouchDevice() {
  const names = (await xinput(['list', '--name-only'])).split('\n').map(n => n.trim());
  const name = names.find(n => TOUCH_NAME.test(n));
  if (!name) throw new Error('No touchscreen found (xinput list).');
  return name;
}

export async function setMatrix(matrix) {
  const device = await findTouchDevice();
  await xinput(['set-prop', device, 'libinput Calibration Matrix', ...matrix.map(String)]);
}

// Solve a 3x3 linear system with Cramer's rule.
function solve3(m, v) {
  const det = a =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-9) throw new Error('Taps too close together, try again.');
  return [0, 1, 2].map(col => det(m.map((row, i) => row.map((x, j) => (j === col ? v[i] : x)))) / d);
}

// points: [{ rx, ry, tx, ty }] normalized 0..1, r = reported with identity matrix, t = target.
// Least squares fit of t = A * r (affine, so rotation/mirroring is handled too).
export function computeMatrix(points) {
  if (points.length < 3) throw new Error('Need at least 3 points.');
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const atx = [0, 0, 0];
  const aty = [0, 0, 0];
  for (const p of points) {
    const row = [p.rx, p.ry, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) ata[i][j] += row[i] * row[j];
      atx[i] += row[i] * p.tx;
      aty[i] += row[i] * p.ty;
    }
  }
  const [a, b, c] = solve3(ata, atx);
  const [d, e, f] = solve3(ata, aty);
  // a tap that lands far from where the fit says it should = user missed a target
  const worst = Math.max(
    ...points.map(p => Math.hypot(a * p.rx + b * p.ry + c - p.tx, d * p.rx + e * p.ry + f - p.ty)),
  );
  if (worst > 0.08) throw new Error('One tap was off target, try again.');
  return [a, b, c, d, e, f, 0, 0, 1].map(x => Math.round(x * 1e6) / 1e6 + 0); // + 0 turns -0 into 0
}

// Stored outside the OctoDash config, so calibration can run before the setup wizard (touch must work there).
// undefined = never asked, [] = skipped, 9 numbers = matrix.
export async function activateTouchListener(ipcMain, window) {
  const { default: Store } = await import('electron-store'); // lazy: the self-check below runs without Electron
  const store = new Store();
  const stored = () => store.get('touchCalibration');
  const applyStored = () => setMatrix(stored()?.length === 9 ? stored() : IDENTITY);

  const reply = (channel, promise) =>
    promise
      .then(matrix => window.webContents.send(channel, { matrix }))
      .catch(error => window.webContents.send(channel, { error: error.message }));

  // X forgets the matrix when it restarts: apply on every start
  if (stored()?.length === 9) applyStored().catch(() => {});

  // needed = touchscreen present and never calibrated/skipped; no touchscreen (desktop, HDMI) = never ask
  ipcMain.on('touchStatus', () =>
    findTouchDevice()
      .then(() => stored() === undefined)
      .catch(() => false)
      .then(needed => window.webContents.send('touchStatus', { needed })),
  );
  ipcMain.on('touchSave', (_, matrix) => store.set('touchCalibration', matrix));
  // leave without saving: put the previous matrix back, and don't ask again on next start
  ipcMain.on('touchCancel', () => {
    if (stored() === undefined) store.set('touchCalibration', []);
    applyStored().catch(() => {});
  });

  ipcMain.on('touchSetMatrix', (_, matrix) =>
    reply(
      'touchMatrixSet',
      setMatrix(matrix).then(() => matrix),
    ),
  );
  ipcMain.on('touchCalibrate', (_, points) =>
    reply(
      'touchMatrixSet',
      Promise.resolve().then(async () => {
        const matrix = computeMatrix(points);
        await setMatrix(matrix);
        return matrix;
      }),
    ),
  );
}

// self-check: node src/helper/touch.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const assert = await import('node:assert/strict');
  const targets = [
    [0.1, 0.1],
    [0.9, 0.1],
    [0.9, 0.9],
    [0.1, 0.9],
  ];
  // panel mounted rotated 90° and squashed: reported (rx, ry) = (ty * 0.8 + 0.05, 1 - tx)
  const points = targets.map(([tx, ty]) => ({ tx, ty, rx: ty * 0.8 + 0.05, ry: 1 - tx }));
  const m = computeMatrix(points);
  for (const p of points) {
    assert.ok(Math.abs(m[0] * p.rx + m[1] * p.ry + m[2] - p.tx) < 1e-6);
    assert.ok(Math.abs(m[3] * p.rx + m[4] * p.ry + m[5] - p.ty) < 1e-6);
  }
  assert.throws(() => computeMatrix([...points.slice(0, 3), { tx: 0.1, ty: 0.9, rx: 0.9, ry: 0.1 }]), /off target/);
  assert.throws(() => computeMatrix(points.map(p => ({ ...p, rx: 0.5, ry: 0.5 }))), /too close/);
  console.log('touch.js self-check OK', m);
}
