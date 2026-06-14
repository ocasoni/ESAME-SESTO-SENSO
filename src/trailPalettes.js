import * as THREE from 'three';

export const TRAIL_PALETTES = [
  {
    hue: 0.58,
    colorA: new THREE.Vector3(0.0, 0.35, 1.0),
    colorB: new THREE.Vector3(0.0, 1.0, 1.0),
    colorC: new THREE.Vector3(0.4, 0.0, 1.0),
    saturation: 1.0,
  },
  {
    hue: 0.08,
    colorA: new THREE.Vector3(1.0, 0.18, 0.0),
    colorB: new THREE.Vector3(1.0, 0.75, 0.0),
    colorC: new THREE.Vector3(1.0, 0.02, 0.25),
    saturation: 1.0,
  },
  {
    hue: 0.33,
    colorA: new THREE.Vector3(0.0, 1.0, 0.15),
    colorB: new THREE.Vector3(0.55, 1.0, 0.0),
    colorC: new THREE.Vector3(0.0, 0.75, 0.35),
    saturation: 1.0,
  },
  {
    hue: 0.78,
    colorA: new THREE.Vector3(0.65, 0.0, 1.0),
    colorB: new THREE.Vector3(1.0, 0.0, 0.95),
    colorC: new THREE.Vector3(0.25, 0.0, 1.0),
    saturation: 1.0,
  },
  {
    hue: 0.55,
    colorA: new THREE.Vector3(0.0, 0.9, 1.0),
    colorB: new THREE.Vector3(0.0, 0.45, 1.0),
    colorC: new THREE.Vector3(0.0, 1.0, 0.65),
    saturation: 1.0,
  },
  {
    hue: 0.95,
    colorA: new THREE.Vector3(1.0, 0.0, 0.35),
    colorB: new THREE.Vector3(1.0, 0.0, 0.75),
    colorC: new THREE.Vector3(0.9, 0.0, 0.15),
    saturation: 1.0,
  },
  {
    hue: 0.15,
    colorA: new THREE.Vector3(1.0, 0.55, 0.0),
    colorB: new THREE.Vector3(1.0, 0.85, 0.2),
    colorC: new THREE.Vector3(0.85, 0.25, 0.0),
    saturation: 1.0,
  },
  {
    hue: 0.48,
    colorA: new THREE.Vector3(0.0, 0.75, 0.95),
    colorB: new THREE.Vector3(0.15, 0.55, 1.0),
    colorC: new THREE.Vector3(0.0, 0.95, 0.75),
    saturation: 1.0,
  },
  {
    hue: 0.68,
    colorA: new THREE.Vector3(0.55, 0.0, 0.95),
    colorB: new THREE.Vector3(0.85, 0.15, 1.0),
    colorC: new THREE.Vector3(0.35, 0.0, 0.85),
    saturation: 1.0,
  },
  {
    hue: 0.02,
    colorA: new THREE.Vector3(1.0, 0.25, 0.05),
    colorB: new THREE.Vector3(1.0, 0.55, 0.15),
    colorC: new THREE.Vector3(0.95, 0.05, 0.2),
    saturation: 1.0,
  },
];

export function getTrailPalette(positionIndex) {
  return TRAIL_PALETTES[positionIndex % TRAIL_PALETTES.length];
}

export function applyPaletteToTrail(trail, positionIndex) {
  const palette = getTrailPalette(positionIndex);
  trail.hue = palette.hue;
  trail.colorA.copy(palette.colorA);
  trail.colorB.copy(palette.colorB);
  trail.colorC.copy(palette.colorC);
  trail.saturation = palette.saturation;
  return trail;
}

export function lerpPalettes(positionIndexA, positionIndexB, mixAmount) {
  const a = getTrailPalette(positionIndexA);
  const b = getTrailPalette(positionIndexB);
  const t = THREE.MathUtils.clamp(mixAmount, 0, 1);

  return {
    hue: THREE.MathUtils.lerp(a.hue, b.hue, t),
    colorA: a.colorA.clone().lerp(b.colorA, t),
    colorB: a.colorB.clone().lerp(b.colorB, t),
    colorC: a.colorC.clone().lerp(b.colorC, t),
    saturation: THREE.MathUtils.lerp(a.saturation, b.saturation, t),
  };
}

export function applyMixedPalette(trail, mixed) {
  trail.hue = mixed.hue;
  trail.colorA.copy(mixed.colorA);
  trail.colorB.copy(mixed.colorB);
  trail.colorC.copy(mixed.colorC);
  trail.saturation = mixed.saturation;
}

export function getParticleColor(palette, seed) {
  const seedA = (seed * 0.6180339887) % 1;
  const seedB = (seed * 0.4338912758) % 1;
  const mixAB = palette.colorA.clone().lerp(palette.colorB, seedA);
  return mixAB.lerp(palette.colorC, seedB * 0.45);
}
