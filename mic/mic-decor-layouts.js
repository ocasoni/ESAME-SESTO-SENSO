import * as THREE from 'three';

function rnd(seed) {
  const x = Math.sin(seed * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function cluster(out, cx, cy, count, spreadX, spreadY, seedStart) {
  for (let i = 0; i < count; i += 1) {
    const a = rnd(seedStart + i * 1.7) * Math.PI * 2;
    const r = rnd(seedStart + i * 2.3);
    out.push({
      nx: THREE.MathUtils.clamp(cx + Math.cos(a) * spreadX * r, 0.015, 0.985),
      ny: THREE.MathUtils.clamp(cy + Math.sin(a) * spreadY * r, 0.015, 0.985),
      seed: seedStart + i,
    });
  }
}

function alongCurve(out, points, count, seedStart) {
  for (let i = 0; i < count; i += 1) {
    const t = i / Math.max(1, count - 1);
    const idx = Math.min(points.length - 2, Math.floor(t * (points.length - 1)));
    const localT = t * (points.length - 1) - idx;
    const a = points[idx];
    const b = points[idx + 1];
    const jitter = (rnd(seedStart + i) - 0.5) * 0.014;
    out.push({
      nx: THREE.MathUtils.clamp(a.nx + (b.nx - a.nx) * localT + jitter, 0.015, 0.985),
      ny: THREE.MathUtils.clamp(a.ny + (b.ny - a.ny) * localT + jitter, 0.015, 0.985),
      seed: seedStart + i,
    });
  }
}

export const DECOR_PARTICLE_COUNT = 108;

function buildIdleLayout() {
  const points = [];
  cluster(points, 0.9, 0.07, 22, 0.09, 0.065, 10);
  cluster(points, 0.1, 0.93, 34, 0.12, 0.08, 120);
  cluster(points, 0.22, 0.82, 16, 0.07, 0.055, 220);
  return normalizeCount(points);
}

function buildRecordingLayout() {
  const points = [];
  cluster(points, 0.9, 0.07, 20, 0.085, 0.06, 310);
  alongCurve(
    points,
    [
      { nx: 0.96, ny: 0.22 },
      { nx: 0.98, ny: 0.38 },
      { nx: 0.95, ny: 0.52 },
      { nx: 0.97, ny: 0.66 },
    ],
    26,
    410
  );
  alongCurve(
    points,
    [
      { nx: 0.04, ny: 0.97 },
      { nx: 0.24, ny: 0.94 },
      { nx: 0.48, ny: 0.92 },
      { nx: 0.72, ny: 0.93 },
      { nx: 0.94, ny: 0.96 },
    ],
    38,
    510
  );
  return normalizeCount(points);
}

function buildWaitingLayout() {
  const points = [];
  cluster(points, 0.93, 0.1, 12, 0.05, 0.04, 610);
  alongCurve(
    points,
    [
      { nx: 0.98, ny: 0.3 },
      { nx: 0.99, ny: 0.46 },
      { nx: 0.96, ny: 0.62 },
      { nx: 0.94, ny: 0.78 },
    ],
    22,
    710
  );
  alongCurve(
    points,
    [
      { nx: 0.03, ny: 0.95 },
      { nx: 0.18, ny: 0.84 },
      { nx: 0.36, ny: 0.76 },
      { nx: 0.52, ny: 0.72 },
    ],
    42,
    810
  );
  cluster(points, 0.08, 0.88, 14, 0.045, 0.035, 910);
  return normalizeCount(points);
}

function buildCompleteLayout() {
  const points = [];
  alongCurve(
    points,
    [
      { nx: 0.05, ny: 0.3 },
      { nx: 0.04, ny: 0.4 },
      { nx: 0.06, ny: 0.5 },
    ],
    24,
    1010
  );
  alongCurve(
    points,
    [
      { nx: 0.03, ny: 0.95 },
      { nx: 0.24, ny: 0.98 },
      { nx: 0.48, ny: 0.96 },
      { nx: 0.72, ny: 0.91 },
      { nx: 0.95, ny: 0.86 },
    ],
    44,
    1110
  );
  cluster(points, 0.08, 0.46, 18, 0.035, 0.07, 1210);
  return normalizeCount(points);
}

function normalizeCount(points) {
  const result = points.slice(0, DECOR_PARTICLE_COUNT);

  while (result.length < DECOR_PARTICLE_COUNT) {
    const source = points[result.length % points.length];
    result.push({
      nx: THREE.MathUtils.clamp(source.nx + (rnd(result.length * 9.1) - 0.5) * 0.008, 0.015, 0.985),
      ny: THREE.MathUtils.clamp(source.ny + (rnd(result.length * 7.3) - 0.5) * 0.008, 0.015, 0.985),
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
