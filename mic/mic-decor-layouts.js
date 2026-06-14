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
    const jitter = (rnd(seedStart + i) - 0.5) * 0.012;
    out.push({
      nx: THREE.MathUtils.clamp(a.nx + (b.nx - a.nx) * localT + jitter, 0.015, 0.985),
      ny: THREE.MathUtils.clamp(a.ny + (b.ny - a.ny) * localT + jitter, 0.015, 0.985),
      seed: seedStart + i,
    });
  }
}

export const DECOR_PARTICLE_COUNT = 108;

function buildHomeLayout() {
  const points = [];
  cluster(points, 0.94, 0.08, 16, 0.05, 0.038, 10);
  alongCurve(
    points,
    [
      { nx: 0.97, ny: 0.18 },
      { nx: 0.98, ny: 0.34 },
      { nx: 0.96, ny: 0.5 },
      { nx: 0.97, ny: 0.64 },
      { nx: 0.95, ny: 0.74 },
    ],
    30,
    110
  );
  alongCurve(
    points,
    [
      { nx: 0.03, ny: 0.96 },
      { nx: 0.14, ny: 0.9 },
      { nx: 0.3, ny: 0.82 },
      { nx: 0.46, ny: 0.76 },
      { nx: 0.6, ny: 0.72 },
    ],
    44,
    210
  );
  cluster(points, 0.1, 0.9, 18, 0.055, 0.04, 310);
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
  home: buildHomeLayout(),
};

export function layoutForMicState() {
  return 'home';
}
