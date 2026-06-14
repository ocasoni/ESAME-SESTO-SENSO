/** Curva della scia intro (coordinate normalizzate schermo, origine in alto a sinistra). */
export const LANDING_PATH = [
  { nx: -0.05, ny: 0.46 },
  { nx: 0.06, ny: 0.48 },
  { nx: 0.18, ny: 0.52 },
  { nx: 0.3, ny: 0.58 },
  { nx: 0.44, ny: 0.5 },
  { nx: 0.56, ny: 0.38 },
  { nx: 0.68, ny: 0.44 },
  { nx: 0.78, ny: 0.3 },
  { nx: 0.88, ny: 0.18 },
  { nx: 0.96, ny: 0.08 },
  { nx: 1.08, ny: -0.05 },
];

export const LANDING_PARTICLE_COUNT = 340;
export const LANDING_TRAIL_SPAN = 0.82;
export const LANDING_MOVE_DURATION = 5.4;
export const LANDING_DISSOLVE_DURATION = 1.35;

export function sampleLandingPath(path, t) {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (path.length - 1);
  const idx = Math.min(path.length - 2, Math.floor(scaled));
  const localT = scaled - idx;
  const a = path[idx];
  const b = path[idx + 1];
  return {
    nx: a.nx + (b.nx - a.nx) * localT,
    ny: a.ny + (b.ny - a.ny) * localT,
    tx: b.nx - a.nx,
    ty: b.ny - a.ny,
  };
}

export function buildLandingParticles(path, count, trailSpan) {
  const particles = [];

  for (let i = 0; i < count; i += 1) {
    const along = (i / Math.max(1, count - 1)) * trailSpan;
    const headBias = 1 - along / trailSpan;
    const spread = 0.018 + headBias * 0.055;
    const seed = i * 1.73 + 41.2;

    particles.push({
      along,
      seed,
      spreadX: spread * (0.75 + pseudoRandom(seed) * 0.5),
      spreadY: spread * (0.65 + pseudoRandom(seed + 7) * 0.55),
      angle: pseudoRandom(seed + 13) * Math.PI * 2,
    });
  }

  return particles;
}

function pseudoRandom(seed) {
  const x = Math.sin(seed * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}
