function rnd(seed) {
  const x = Math.sin(seed * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function cluster(out, cx, cy, count, spreadX, spreadY, sizeBase, seedStart) {
  for (let i = 0; i < count; i += 1) {
    const a = rnd(seedStart + i * 1.7) * Math.PI * 2;
    const r = rnd(seedStart + i * 2.3);
    out.push({
      nx: cx + Math.cos(a) * spreadX * r,
      ny: cy + Math.sin(a) * spreadY * r,
      size: sizeBase + rnd(seedStart + i * 3.1) * 0.035,
      seed: seedStart + i,
    });
  }
}

function alongCurve(out, points, count, sizeBase, seedStart) {
  for (let i = 0; i < count; i += 1) {
    const t = i / Math.max(1, count - 1);
    const idx = Math.min(points.length - 2, Math.floor(t * (points.length - 1)));
    const localT = t * (points.length - 1) - idx;
    const a = points[idx];
    const b = points[idx + 1];
    const jitter = (rnd(seedStart + i) - 0.5) * 0.018;
    out.push({
      nx: a.nx + (b.nx - a.nx) * localT + jitter,
      ny: a.ny + (b.ny - a.ny) * localT + jitter,
      size: sizeBase + rnd(seedStart + i * 1.9) * 0.028,
      seed: seedStart + i,
    });
  }
}

export const DECOR_PARTICLE_COUNT = 108;

function buildIdleLayout() {
  const points = [];
  cluster(points, 0.86, 0.1, 22, 0.11, 0.08, 0.022, 10);
  cluster(points, 0.14, 0.9, 34, 0.14, 0.1, 0.024, 120);
  cluster(points, 0.28, 0.78, 16, 0.08, 0.06, 0.02, 220);
  return normalizeCount(points);
}

function buildRecordingLayout() {
  const points = [];
  cluster(points, 0.84, 0.1, 20, 0.1, 0.075, 0.022, 310);
  alongCurve(
    points,
    [
      { nx: 0.93, ny: 0.28 },
      { nx: 0.95, ny: 0.42 },
      { nx: 0.91, ny: 0.56 },
      { nx: 0.94, ny: 0.68 },
    ],
    26,
    0.019,
    410
  );
  alongCurve(
    points,
    [
      { nx: 0.08, ny: 0.95 },
      { nx: 0.28, ny: 0.9 },
      { nx: 0.52, ny: 0.88 },
      { nx: 0.74, ny: 0.9 },
      { nx: 0.9, ny: 0.93 },
    ],
    38,
    0.021,
    510
  );
  return normalizeCount(points);
}

function buildWaitingLayout() {
  const points = [];
  cluster(points, 0.88, 0.12, 12, 0.06, 0.05, 0.018, 610);
  alongCurve(
    points,
    [
      { nx: 0.95, ny: 0.34 },
      { nx: 0.96, ny: 0.5 },
      { nx: 0.93, ny: 0.66 },
      { nx: 0.9, ny: 0.82 },
    ],
    22,
    0.018,
    710
  );
  alongCurve(
    points,
    [
      { nx: 0.05, ny: 0.92 },
      { nx: 0.22, ny: 0.82 },
      { nx: 0.4, ny: 0.74 },
      { nx: 0.55, ny: 0.7 },
    ],
    42,
    0.023,
    810
  );
  cluster(points, 0.12, 0.86, 14, 0.05, 0.04, 0.02, 910);
  return normalizeCount(points);
}

function buildCompleteLayout() {
  const points = [];
  alongCurve(
    points,
    [
      { nx: 0.1, ny: 0.34 },
      { nx: 0.09, ny: 0.44 },
      { nx: 0.11, ny: 0.54 },
    ],
    24,
    0.02,
    1010
  );
  alongCurve(
    points,
    [
      { nx: 0.06, ny: 0.92 },
      { nx: 0.28, ny: 0.96 },
      { nx: 0.5, ny: 0.93 },
      { nx: 0.72, ny: 0.88 },
      { nx: 0.92, ny: 0.82 },
    ],
    44,
    0.022,
    1110
  );
  cluster(points, 0.14, 0.48, 18, 0.04, 0.08, 0.019, 1210);
  return normalizeCount(points);
}

function normalizeCount(points) {
  const result = points.slice(0, DECOR_PARTICLE_COUNT);

  while (result.length < DECOR_PARTICLE_COUNT) {
    const source = points[result.length % points.length];
    result.push({
      ...source,
      nx: source.nx + (rnd(result.length * 9.1) - 0.5) * 0.01,
      ny: source.ny + (rnd(result.length * 7.3) - 0.5) * 0.01,
      seed: source.seed + result.length,
    });
  }

  return result;
}

export const DECOR_LAYOUTS = {
  idle: buildIdleLayout(),
  recording: buildRecordingLayout(),
  waiting: buildWaitingLayout(),
  complete: buildCompleteLayout(),
};

export function layoutForMicState(state) {
  if (state === 'recording') return 'recording';
  if (state === 'waiting') return 'waiting';
  if (state === 'generating' || state === 'complete') return 'complete';
  return 'idle';
}
