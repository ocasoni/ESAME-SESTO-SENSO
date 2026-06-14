import * as THREE from 'three/webgpu';
import {
  abs,
  atan,
  cos,
  deltaTime,
  float,
  floor,
  Fn,
  hash,
  If,
  instanceIndex,
  max,
  mix,
  mx_fractal_noise_vec3,
  PI,
  sin,
  step,
  storage,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { TRAIL_PALETTES, applyPaletteToTrail } from './trailPalettes.js';
import { analyzeBreathFrame } from './audioFromUpload.js';

export const particlesPerTrail = Math.pow(2, 14);
export const trajectoryParams = {
  speed: 1.35,
  smoothness: 0.12,
  range: 4.2,
  directionChange: 0.72,
  forwardPush: 1.0,
};
export const TRAIL_SPREAD_DISTANCE = 13.5;

export const TRAIL_POSITION_DIRECTIONS = [
  new THREE.Vector3(0.0, 0.0, 0.0),
  new THREE.Vector3(1.0, -0.55, -0.85),
  new THREE.Vector3(-0.92, -0.85, 1.05),
  new THREE.Vector3(0.88, 1.08, -1.18),
  new THREE.Vector3(0.18, 1.48, 1.08),
  new THREE.Vector3(-0.38, -1.58, -1.08),
  new THREE.Vector3(1.28, 0.38, 0.88),
  new THREE.Vector3(-1.18, 0.58, -0.78),
  new THREE.Vector3(0.48, -1.28, 0.98),
  new THREE.Vector3(-0.98, 0.98, 1.38),
  new THREE.Vector3(0.72, -0.32, 1.45),
  new THREE.Vector3(-1.32, -0.22, -0.55),
  new THREE.Vector3(0.58, 1.05, 1.28),
  new THREE.Vector3(-0.62, 1.35, -1.05),
];

const TWO_PI = PI.mul(2.0);

export function getTrailPosition(positionIndex) {
  const direction = TRAIL_POSITION_DIRECTIONS[positionIndex % TRAIL_POSITION_DIRECTIONS.length];

  if (positionIndex === 0 && direction.lengthSq() === 0) {
    return new THREE.Vector3(0.0, 0.0, 0.0);
  }

  return direction.clone().normalize().multiplyScalar(TRAIL_SPREAD_DISTANCE);
}

export function createTrail(index, slot, positionIndex) {
  const startPosition = getTrailPosition(positionIndex);
  const homePosition = startPosition.clone();

  const trail = {
    slot,
    positionIndex,
    particleStart: slot * particlesPerTrail,
    spawnIndex: 0,
    hue: 0,
    colorA: new THREE.Vector3(),
    colorB: new THREE.Vector3(),
    colorC: new THREE.Vector3(),
    saturation: 1.0,
    homePosition,
    position: startPosition.clone(),
    velocity: new THREE.Vector3(),
    direction: new THREE.Vector3(
      1.0,
      0.28 + slot * 0.07,
      0.16 - slot * 0.05
    ).normalize(),
    targetDirection: new THREE.Vector3(),
    wanderPhase: slot * 2.17,
    spawnPosition: startPosition.clone(),
    previousSpawnPosition: startPosition.clone(),
    audioDrivenPosition: startPosition.clone(),
    smoothedLevel: 0,
    smoothedLowBand: 0,
    smoothedMidBand: 0,
    smoothedHighBand: 0,
    previousFrequencyBalance: 0,
    recordElapsed: 0,
    loopElapsed: 0,
    recordedFrames: [],
    loopFrames: [],
    mode: 'recording',
  };

  return applyPaletteToTrail(trail, positionIndex);
}

export function buildSplashLoopFrames(durationSec = 4, fps = 60) {
  const frames = [];
  const count = Math.floor(durationSec * fps);

  for (let i = 0; i < count; i += 1) {
    const t = i / count;
    const level = THREE.MathUtils.clamp(
      Math.sin(t * Math.PI * 2.4) * 0.32 + 0.48 + Math.sin(t * 19.5) * 0.06,
      0,
      1
    );
    const lowBand = THREE.MathUtils.clamp(
      Math.sin(t * Math.PI * 1.6 + 0.4) * 0.28 + 0.42,
      0,
      1
    );
    const midBand = THREE.MathUtils.clamp(
      Math.sin(t * Math.PI * 3.1 + 1.1) * 0.35 + 0.38,
      0,
      1
    );
    const highBand = THREE.MathUtils.clamp(
      Math.sin(t * Math.PI * 4.8 + 0.2) * 0.4 + 0.35,
      0,
      1
    );

    frames.push({ level, lowBand, midBand, highBand });
  }

  return frames;
}

export function getAutomaticSplashBreathFrame(timeSec) {
  const t = timeSec;
  const inhale = Math.pow(Math.max(0, Math.sin(t * 1.65)), 1.25);
  const flutter = (Math.sin(t * 11.5) * 0.5 + 0.5) * 0.12;
  const level = THREE.MathUtils.clamp(0.28 + inhale * 0.58 + flutter, 0.22, 1);
  const lowBand = THREE.MathUtils.clamp(0.3 + inhale * 0.48 + Math.sin(t * 2.3) * 0.1, 0.2, 1);
  const midBand = THREE.MathUtils.clamp(
    0.22 + Math.pow(Math.max(0, Math.sin(t * 2.9 + 0.4)), 1.4) * 0.52,
    0.15,
    1
  );
  const highBand = THREE.MathUtils.clamp(
    0.18 + Math.sin(t * 4.6 + 0.8) * 0.28 + inhale * 0.22,
    0.12,
    1
  );

  return { level, lowBand, midBand, highBand };
}

export function getBreathFrameFromAnalyser(analyser, frequencyData, waveformData, settings) {
  analyser.getByteFrequencyData(frequencyData);
  analyser.getByteTimeDomainData(waveformData);
  return analyzeBreathFrame(frequencyData, waveformData, settings);
}

export function getLoopedBreathFrame(trail, delta) {
  if (trail.mode === 'auto') {
    trail.loopElapsed += delta;
    return getAutomaticSplashBreathFrame(trail.loopElapsed);
  }

  if (trail.mode === 'live' && typeof trail.getLiveFrame === 'function') {
    return trail.getLiveFrame();
  }

  if (trail.mode === 'loop' && trail.loopFrames.length > 0) {
    const loopDuration = trail.loopDuration || 4;
    trail.loopElapsed += delta;

    const loopProgress = (trail.loopElapsed % loopDuration) / loopDuration;
    const exactIndex = loopProgress * trail.loopFrames.length;
    const indexA = Math.floor(exactIndex) % trail.loopFrames.length;
    const indexB = (indexA + 1) % trail.loopFrames.length;
    const mixAmount = exactIndex - Math.floor(exactIndex);
    const a = trail.loopFrames[indexA];
    const b = trail.loopFrames[indexB];

    return {
      level: THREE.MathUtils.lerp(a.level, b.level, mixAmount),
      lowBand: THREE.MathUtils.lerp(a.lowBand, b.lowBand, mixAmount),
      midBand: THREE.MathUtils.lerp(a.midBand, b.midBand, mixAmount),
      highBand: THREE.MathUtils.lerp(a.highBand, b.highBand, mixAmount),
    };
  }

  return { level: 0, lowBand: 0, midBand: 0, highBand: 0 };
}

export async function createTrailEngine(renderer, worldGroup, slotCount = 1, options = {}) {
  const slotParticles = options.particlesPerTrail ?? particlesPerTrail;
  const nbParticles = slotParticles * slotCount;
  const staticTwinkle = options.staticTwinkle === true;

  const currentTrailParticleStart = uniform(0);
  const clearTrailParticleStart = uniform(0);
  const fadeTrailParticleStart = uniform(0);
  const fadeTrailRate = uniform(1.0);
  const timeScale = uniform(0.8);
  const particleLifetime = uniform(0.65);
  const particleSize = uniform(0.45);
  const colorBrightness = uniform(1.25);
  const currentTrailColorA = uniform(vec3(0.0, 0.35, 1.0));
  const currentTrailColorB = uniform(vec3(0.0, 1.0, 1.0));
  const currentTrailColorC = uniform(vec3(0.7, 0.0, 1.0));
  const spawnIndex = uniform(0);
  const nbToSpawn = uniform(50);
  const spawnPosition = uniform(vec3(0.0));
  const previousSpawnPosition = uniform(vec3(0.0));
  const spawnLinksWidth = uniform(0.005);
  const cymaticLevel = uniform(0.0);
  const cymaticLow = uniform(0.0);
  const cymaticMid = uniform(0.0);
  const cymaticHigh = uniform(0.0);
  const cymaticPhase = uniform(0.0);
  const cymaticScale = uniform(1.1);
  const cymaticDepth = uniform(0.12);
  const turbFrequency = uniform(0.35);
  const turbAmplitude = uniform(1.2);
  const turbOctaves = uniform(2);
  const turbLacunarity = uniform(2.0);
  const turbGain = uniform(0.35);
  const freezeLifeThreshold = uniform(0.90);
  const appearanceTime = uniform(0.0);
  const appearanceAudioLow = uniform(0.0);
  const appearanceAudioMid = uniform(0.0);
  const appearanceAudioHigh = uniform(0.0);
  const appearanceRecording = uniform(0.0);

  let particleAppearanceAttr = null;
  let sparkleIntensityAttr = null;
  let particleAppearance = null;
  let sparkleIntensity = null;
  let appearanceData = null;
  let sparkleIntensityData = null;

  if (staticTwinkle) {
    appearanceData = new Float32Array(nbParticles * 4);
    sparkleIntensityData = new Float32Array(nbParticles);
    particleAppearanceAttr = new THREE.StorageInstancedBufferAttribute(appearanceData, 4);
    sparkleIntensityAttr = new THREE.StorageInstancedBufferAttribute(sparkleIntensityData, 1);
    particleAppearance = storage(particleAppearanceAttr, 'vec4', nbParticles);
    sparkleIntensity = storage(sparkleIntensityAttr, 'float', nbParticles);
  }

  const runtime = {
    audioPhase: 0,
    smoothedLevel: 0,
    smoothedLowBand: 0,
    smoothedMidBand: 0,
    smoothedHighBand: 0,
  };

  const getInstanceColor = Fn(([i]) => {
    const seedA = hash(i);
    const seedB = hash(i.add(31));

    const colorMixA = mix(
      currentTrailColorA,
      currentTrailColorB,
      seedA
    );

    const colorMixB = mix(
      colorMixA,
      currentTrailColorC,
      seedB.mul(0.45)
    );

    return colorMixB.mul(colorBrightness);
  });

  const particlePositions = storage(
    new THREE.StorageInstancedBufferAttribute(nbParticles, 4),
    'vec4',
    nbParticles
  );
  const particleVelocities = storage(
    new THREE.StorageInstancedBufferAttribute(nbParticles, 4),
    'vec4',
    nbParticles
  );
  const particleColors = storage(
    new THREE.StorageInstancedBufferAttribute(nbParticles, 4),
    'vec4',
    nbParticles
  );
  const particleProperties = storage(
    new THREE.StorageInstancedBufferAttribute(nbParticles, 4),
    'vec4',
    nbParticles
  );

  renderer.compute(
    Fn(() => {
      particlePositions.element(instanceIndex).xyz.assign(vec3(10000.0));
      particlePositions.element(instanceIndex).w.assign(-1.0);

      particleColors.element(instanceIndex).xyz.assign(vec3(1.0));
      particleColors.element(instanceIndex).w.assign(1.0);

      particleProperties.element(instanceIndex).x.assign(1.0);
      particleProperties.element(instanceIndex).y.assign(0.005);
      particleProperties.element(instanceIndex).z.assign(1.0);
      particleProperties.element(instanceIndex).w.assign(0.0);
    })().compute(nbParticles)
  );

  const clearTrailSlot = Fn(() => {
    const particleIndex = clearTrailParticleStart.add(instanceIndex).toInt();

    particlePositions.element(particleIndex).xyz.assign(vec3(10000.0));
    particlePositions.element(particleIndex).w.assign(-1.0);
    particleProperties.element(particleIndex).w.assign(0.0);
    particleProperties.element(particleIndex).z.assign(1.0);
  })().compute(slotParticles);

  const fadeTrailSlot = Fn(() => {
    const particleIndex = fadeTrailParticleStart.add(instanceIndex).toInt();
    const position = particlePositions.element(particleIndex).xyz;
    const life = particlePositions.element(particleIndex).w;
    const reveal = particleProperties.element(particleIndex).w;
    const fadeStep = deltaTime.mul(fadeTrailRate);

    If(life.greaterThan(0.0), () => {
      life.subAssign(fadeStep);
      reveal.subAssign(fadeStep.mul(1.35));

      If(life.lessThanEqual(0.0), () => {
        life.assign(-1.0);
        reveal.assign(0.0);
        position.assign(vec3(10000.0));
      });
    });
  })().compute(slotParticles);

  let freezeStaticSlot = null;
  let updateStaticAppearance = null;

  if (staticTwinkle) {
    freezeStaticSlot = Fn(() => {
      const particleIndex = currentTrailParticleStart.add(instanceIndex).toInt();
      const life = particlePositions.element(particleIndex).w;

      If(life.greaterThan(0.0), () => {
        const position = particlePositions.element(particleIndex).xyz;
        particleProperties.element(particleIndex).z.assign(1.0);
        particlePositions.element(particleIndex).w.assign(0.9);
        particleProperties.element(particleIndex).w.assign(1.0);
        particleVelocities.element(particleIndex).xyz.assign(position);
      });
    })().compute(slotParticles);

    updateStaticAppearance = Fn(() => {
      const particleIndex = currentTrailParticleStart.add(instanceIndex).toInt();
      const life = particlePositions.element(particleIndex).w;
      const frozen = particleProperties.element(particleIndex).z;

      If(life.greaterThan(0.0), () => {
        If(frozen.greaterThan(0.5), () => {
          const meta = particleAppearance.element(particleIndex);
          const phase = meta.x;
          const speed = meta.y;
          const strength = meta.z;
          const ribbonT = meta.w;

          const sizeSeed = hash(particleIndex.toFloat());
          const isSmall = step(sizeSeed, 0.52);
          const isLarge = step(0.72, sizeSeed);

          const tw = sin(appearanceTime.mul(speed).add(phase)).mul(0.5).add(0.5);
          const twinkleBright = tw.mul(strength);

          const midWeight = float(1.0).sub(abs(ribbonT.sub(0.5).mul(2.0))).clamp(0.0, 1.0);
          const lowReact = appearanceAudioLow.mul(isLarge);
          const midReact = appearanceAudioMid.mul(midWeight);
          const highReact = appearanceAudioHigh.mul(isSmall);
          const audioBright = lowReact
            .mul(0.34)
            .add(midReact.mul(0.28))
            .add(highReact.mul(0.22))
            .mul(appearanceRecording);

          const sparkleBright = sparkleIntensity.element(particleIndex);
          const finalBright = float(0.42)
            .add(twinkleBright)
            .add(sparkleBright)
            .add(audioBright)
            .clamp(0.1, 2.35);

          particleColors.element(particleIndex).w.assign(finalBright);
        });
      });
    })().compute(slotParticles).label('Update Static Appearance');
  }

  const updateParticles = Fn(() => {
    const position = particlePositions.element(instanceIndex).xyz;
    const life = particlePositions.element(instanceIndex).w;
    const targetPosition = particleVelocities.element(instanceIndex).xyz;
    const reveal = particleProperties.element(instanceIndex).w;

    const dt = deltaTime.mul(0.1).mul(timeScale);

    If(life.greaterThan(0.0), () => {
      const frozen = particleProperties.element(instanceIndex).z;

      If(frozen.lessThan(0.5), () => {
        const settleSpeed = float(0.18)
          .add(cymaticLevel.mul(0.12))
          .add(cymaticHigh.mul(0.05));

        position.assign(
          mix(position, targetPosition, settleSpeed)
        );

        const localVel = mx_fractal_noise_vec3(
          position.mul(turbFrequency),
          turbOctaves,
          turbLacunarity,
          turbGain,
          turbAmplitude
        ).mul(life.add(0.01)).mul(0.018);

        position.addAssign(localVel);

        reveal.addAssign(dt.mul(10.0));

        If(reveal.greaterThan(1.0), () => {
          reveal.assign(1.0);
        });

        life.subAssign(dt.mul(particleLifetime.reciprocal()));

        If(life.lessThan(freezeLifeThreshold), () => {
          life.assign(freezeLifeThreshold);
          frozen.assign(1.0);
          reveal.assign(1.0);
        });
      });
    });
  })().compute(nbParticles).label('Update Particles');

  const spawnParticles = Fn(() => {
    const particleIndex = currentTrailParticleStart
      .add(spawnIndex.add(instanceIndex).mod(slotParticles).toInt())
      .toInt();
    const position = particlePositions.element(particleIndex).xyz;
    const life = particlePositions.element(particleIndex).w;
    const velocity = particleVelocities.element(particleIndex).xyz;
    const particleColor = particleColors.element(particleIndex);
    const particleProperty = particleProperties.element(particleIndex);

    life.assign(1.0);

    particleColor.xyz.assign(getInstanceColor(particleIndex));
    particleColor.w.assign(1.0);

    particleProperty.x.assign(particleSize);
    particleProperty.y.assign(spawnLinksWidth);
    particleProperty.z.assign(0.0);

    const pos = mix(
      previousSpawnPosition,
      spawnPosition,
      instanceIndex.toFloat().div(nbToSpawn.sub(1).toFloat()).clamp()
    );

    const seedA = hash(particleIndex);
    const seedB = hash(particleIndex.add(17));
    const seedC = hash(particleIndex.add(43));
    const seedD = hash(particleIndex.add(91));

    const theta = seedA.mul(TWO_PI);

    const modeLow = float(2.0).add(cymaticLow.mul(9.0));
    const modeMid = float(3.0).add(cymaticMid.mul(13.0));
    const modeHigh = float(5.0).add(cymaticHigh.mul(22.0));

    const radialWave = abs(
      sin(theta.mul(modeLow).add(cymaticPhase))
    );

    const angularWave = abs(
      cos(theta.mul(modeMid).sub(cymaticPhase.mul(0.65)))
    );

    const detailWave = abs(
      sin(theta.mul(modeHigh).add(seedC.mul(TWO_PI)))
    );

    const cymaticField = radialWave
      .mul(0.45)
      .add(angularWave.mul(0.4))
      .add(detailWave.mul(0.35));

    const bandCount = float(3.0)
      .add(cymaticLow.mul(4.0))
      .add(cymaticMid.mul(5.0))
      .add(cymaticHigh.mul(3.0));

    const bandId = floor(seedB.mul(bandCount));

    const bandRadius = bandId
      .add(0.5)
      .div(bandCount);

    const bandVibration = abs(
      sin(
        bandRadius
          .mul(modeLow)
          .mul(PI)
          .add(cymaticPhase)
      )
    );

    const nodeAttraction = bandVibration
      .mul(0.55)
      .add(cymaticField.mul(0.45));

    const microSpread = seedD
      .sub(0.5)
      .mul(0.08)
      .mul(float(1.0).add(cymaticHigh));

    const audioRadius = float(0.18).add(cymaticLevel);

    const radius = cymaticScale
      .mul(audioRadius)
      .mul(
        bandRadius
          .add(nodeAttraction.mul(0.38))
          .add(microSpread)
      );

    const xDeform = float(0.75)
      .add(radialWave.mul(0.65))
      .add(cymaticMid.mul(0.45));

    const yDeform = float(0.75)
      .add(angularWave.mul(0.65))
      .add(cymaticHigh.mul(0.45));

    const x = cos(theta).mul(radius).mul(xDeform);
    const y = sin(theta).mul(radius).mul(yDeform);

    const z = detailWave
      .sub(0.5)
      .mul(cymaticDepth)
      .mul(float(0.5).add(cymaticLevel));

    const cymaticOffset = vec3(x, y, z);

    position.assign(pos);

    velocity.assign(
      pos.add(cymaticOffset)
    );

    particleProperty.w.assign(0.80);
  })().compute(nbToSpawn.value).label('Spawn Particles');

  const particleQuadSize = 0.12;
  const particleGeom = new THREE.PlaneGeometry(particleQuadSize, particleQuadSize);

  const particleMaterial = new THREE.SpriteNodeMaterial();
  particleMaterial.blending = THREE.AdditiveBlending;
  particleMaterial.depthWrite = false;
  particleMaterial.positionNode = particlePositions.toAttribute();
  particleMaterial.scaleNode = vec2(particleProperties.toAttribute().x);
  particleMaterial.rotationNode = atan(particleVelocities.toAttribute().y, particleVelocities.toAttribute().x);

  particleMaterial.colorNode = Fn(() => {
    const life = particlePositions.toAttribute().w;
    const reveal = particleProperties.toAttribute().w;
    const liveBrightness = colorBrightness.mul(0.65).add(0.35);
    const color = particleColors.toAttribute().xyz
      .mul(life)
      .mul(reveal)
      .mul(liveBrightness);

    if (staticTwinkle) {
      return color.mul(particleColors.toAttribute().w);
    }

    return color;
  })();

  particleMaterial.opacityNode = Fn(() => {
    const circle = step(uv().xy.sub(0.5).length(), 0.5);
    const life = particlePositions.toAttribute().w;
    const reveal = particleProperties.toAttribute().w;
    const opacity = circle.mul(life).mul(reveal);

    if (staticTwinkle) {
      const appearance = particleColors.toAttribute().w;
      const opacityBoost = appearance.mul(0.5).add(0.5).clamp(0.38, 1.0);
      return opacity.mul(opacityBoost);
    }

    return opacity;
  })();

  const particleMesh = new THREE.InstancedMesh(particleGeom, particleMaterial, nbParticles);
  particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  particleMesh.frustumCulled = false;
  worldGroup.add(particleMesh);

  function applyTrailToGPU(trail) {
    currentTrailParticleStart.value = trail.particleStart;
    currentTrailColorA.value.copy(trail.colorA);
    currentTrailColorB.value.copy(trail.colorB);
    currentTrailColorC.value.copy(trail.colorC);
    spawnIndex.value = trail.spawnIndex;
    previousSpawnPosition.value.copy(trail.previousSpawnPosition);
    spawnPosition.value.copy(trail.spawnPosition);
  }

  function updateAudioDrivenPosition(trail, delta, audioStarted = true) {
    if (!audioStarted) return;

    const breathFrame = getLoopedBreathFrame(trail, delta);
    const level = breathFrame.level;
    const lowBand = breathFrame.lowBand;
    const midBand = breathFrame.midBand;
    const highBand = breathFrame.highBand;

    trail.smoothedLevel = THREE.MathUtils.lerp(trail.smoothedLevel, level, 0.12);

    runtime.smoothedLevel = trail.smoothedLevel;

    runtime.audioPhase += delta * (0.65 + trail.smoothedLevel * 1.8);

    trail.smoothedLowBand = THREE.MathUtils.lerp(trail.smoothedLowBand, lowBand, 0.08);
    trail.smoothedMidBand = THREE.MathUtils.lerp(trail.smoothedMidBand, midBand, 0.08);
    trail.smoothedHighBand = THREE.MathUtils.lerp(trail.smoothedHighBand, highBand, 0.08);

    runtime.smoothedLowBand = trail.smoothedLowBand;
    runtime.smoothedMidBand = trail.smoothedMidBand;
    runtime.smoothedHighBand = trail.smoothedHighBand;

    const totalFrequencyEnergy = THREE.MathUtils.clamp(
      trail.smoothedLowBand + trail.smoothedMidBand + trail.smoothedHighBand,
      0,
      1
    );

    const frequencyBalance =
      trail.smoothedHighBand * 1.2 +
      trail.smoothedMidBand * 0.35 -
      trail.smoothedLowBand * 0.9;

    const frequencyChange = frequencyBalance - trail.previousFrequencyBalance;
    trail.previousFrequencyBalance = THREE.MathUtils.lerp(
      trail.previousFrequencyBalance,
      frequencyBalance,
      0.06
    );

    const motionAmount = THREE.MathUtils.smoothstep(totalFrequencyEnergy, 0.08, 0.55);

    trail.wanderPhase += delta * (
      0.45 +
      motionAmount * 1.35 +
      trail.smoothedHighBand * 1.4
    ) * trajectoryParams.directionChange;

    trail.targetDirection.set(
      Math.sin(trail.wanderPhase * 0.73 + trail.smoothedMidBand * 5.0),
      Math.sin(trail.wanderPhase * 1.11 + frequencyBalance * 3.0),
      Math.cos(trail.wanderPhase * 0.91 + trail.smoothedLowBand * 4.0)
    );

    trail.targetDirection.x += frequencyChange * 3.0;
    trail.targetDirection.y += (trail.smoothedHighBand - trail.smoothedLowBand) * 1.4;
    trail.targetDirection.z += (trail.smoothedMidBand - 0.25) * 1.2;

    if (trail.targetDirection.lengthSq() > 0.0001) {
      trail.targetDirection.normalize();
    }

    trail.direction.lerp(
      trail.targetDirection,
      0.018 + motionAmount * 0.05 + Math.abs(frequencyChange) * 0.08
    );
    trail.direction.normalize();

    const speedMul = trail.speedMultiplier ?? 1;
    const trajectorySpeed =
      (0.025 +
      motionAmount * 0.18 +
      trail.smoothedHighBand * 0.045) * trajectoryParams.speed * speedMul;

    trail.velocity.lerp(
      trail.direction.clone().multiplyScalar(trajectorySpeed * trajectoryParams.forwardPush),
      0.04 + motionAmount * 0.09
    );

    const calmBrake = THREE.MathUtils.lerp(0.88, 0.985, motionAmount);
    trail.velocity.multiplyScalar(calmBrake);

    trail.position.add(trail.velocity);

    const maxDistance = trail.maxRange ?? trajectoryParams.range;
    const offsetFromHome = trail.position.clone().sub(trail.homePosition);

    if (offsetFromHome.length() > maxDistance) {
      const inwardDirection = offsetFromHome.clone().normalize().multiplyScalar(-1);

      trail.position.copy(
        trail.homePosition.clone().add(
          offsetFromHome.setLength(maxDistance * 0.96)
        )
      );

      trail.direction.lerp(inwardDirection, 0.32).normalize();
      trail.velocity.add(inwardDirection.multiplyScalar(trajectorySpeed * 0.65));
      trail.velocity.multiplyScalar(0.78);
    }

    trail.audioDrivenPosition.copy(trail.position);

    turbAmplitude.value = THREE.MathUtils.lerp(
      turbAmplitude.value,
      0.25 + trail.smoothedLevel * 2.4 + highBand * 1.2,
      0.08
    );

    nbToSpawn.value = THREE.MathUtils.lerp(
      nbToSpawn.value,
      8 + trail.smoothedLevel * 70,
      0.08
    );

    cymaticLevel.value = THREE.MathUtils.lerp(
      cymaticLevel.value,
      trail.smoothedLevel,
      0.16
    );

    cymaticLow.value = THREE.MathUtils.lerp(
      cymaticLow.value,
      lowBand,
      0.14
    );

    cymaticMid.value = THREE.MathUtils.lerp(
      cymaticMid.value,
      midBand,
      0.14
    );

    cymaticHigh.value = THREE.MathUtils.lerp(
      cymaticHigh.value,
      highBand,
      0.14
    );

    cymaticPhase.value += delta * (1.2 + trail.smoothedLevel * 5.0);

    const brightnessContrast = THREE.MathUtils.clamp(
      (highBand * 2.2) - (lowBand * 1.4) + midBand * 0.25,
      -1.2,
      1.2
    );

    const audioBrightness = THREE.MathUtils.clamp(
      0.95 + brightnessContrast * 1.6 + trail.smoothedLevel * 0.55,
      0.08,
      4.0
    );

    colorBrightness.value = THREE.MathUtils.lerp(
      colorBrightness.value,
      audioBrightness,
      0.28
    );
  }

  function tickTrail(trail, delta, { spawn = true, audioStarted = true } = {}) {
    renderer.compute(updateParticles);

    if (!spawn && !audioStarted) {
      return;
    }

    trail.previousSpawnPosition.copy(trail.spawnPosition);
    updateAudioDrivenPosition(trail, delta, audioStarted);
    trail.spawnPosition.lerp(trail.audioDrivenPosition, trajectoryParams.smoothness);

    if (spawn) {
      applyTrailToGPU(trail);
      renderer.compute(spawnParticles);
      trail.spawnIndex = (trail.spawnIndex + nbToSpawn.value) % slotParticles;
    }
  }

  function clearSlot(particleStart) {
    clearTrailParticleStart.value = particleStart;
    renderer.compute(clearTrailSlot);
  }

  function fadeSlot(particleStart, rate = 1.0 / 2.8) {
    fadeTrailParticleStart.value = particleStart;
    fadeTrailRate.value = rate;
    renderer.compute(fadeTrailSlot);
  }

  function setStaticParticleMeta(particleIndex, phase, speed, strength, ribbonT) {
    if (!staticTwinkle || !appearanceData) return;

    const offset = particleIndex * 4;
    appearanceData[offset] = phase;
    appearanceData[offset + 1] = speed;
    appearanceData[offset + 2] = strength;
    appearanceData[offset + 3] = ribbonT;
  }

  function commitStaticParticleMeta() {
    if (!staticTwinkle || !particleAppearanceAttr) return;
    particleAppearanceAttr.needsUpdate = true;
  }

  function clearSparkleIntensities() {
    if (!staticTwinkle || !sparkleIntensityData) return;
    sparkleIntensityData.fill(0);
    sparkleIntensityAttr.needsUpdate = true;
  }

  function addSparkleIntensity(particleIndex, intensity) {
    if (!staticTwinkle || !sparkleIntensityData) return;
    sparkleIntensityData[particleIndex] = Math.max(
      sparkleIntensityData[particleIndex],
      intensity
    );
    sparkleIntensityAttr.needsUpdate = true;
  }

  function freezeStaticParticles(trail) {
    if (!staticTwinkle || !freezeStaticSlot) return;
    currentTrailParticleStart.value = trail.particleStart;
    renderer.compute(freezeStaticSlot);
  }

  function applyStaticAppearance(trail, timeSec, { low = 0, mid = 0, high = 0, recording = 0 } = {}) {
    if (!staticTwinkle || !updateStaticAppearance) return;

    currentTrailParticleStart.value = trail.particleStart;
    appearanceTime.value = timeSec;
    appearanceAudioLow.value = low;
    appearanceAudioMid.value = mid;
    appearanceAudioHigh.value = high;
    appearanceRecording.value = recording;
    renderer.compute(updateStaticAppearance);
  }

  return {
    particleMesh,
    updateParticles,
    spawnParticles,
    clearSlot,
    fadeSlot,
    applyTrailToGPU,
    updateAudioDrivenPosition,
    tickTrail,
    setStaticParticleMeta,
    commitStaticParticleMeta,
    clearSparkleIntensities,
    addSparkleIntensity,
    freezeStaticParticles,
    applyStaticAppearance,
    uniforms: {
      nbToSpawn,
      colorBrightness,
      currentTrailColorA,
      currentTrailColorB,
      currentTrailColorC,
    },
    runtime,
  };
}

export function createLandingTrail() {
  const startPosition = new THREE.Vector3(6, 4.5, 0);
  const direction = new THREE.Vector3(-0.85, -0.52, 0.08).normalize();

  const trail = createTrail(0, 0, 0);
  trail.mode = 'loop';
  trail.loopDuration = 5;
  trail.loopElapsed = 0;
  trail.loopFrames = buildSplashLoopFrames(5, 60);

  trail.homePosition.copy(startPosition);
  trail.position.copy(startPosition);
  trail.spawnPosition.copy(startPosition);
  trail.previousSpawnPosition.copy(startPosition);
  trail.audioDrivenPosition.copy(startPosition);
  trail.direction.copy(direction);
  trail.targetDirection.copy(direction);
  trail.speedMultiplier = 2.6;
  trail.maxRange = 14;

  return trail;
}

export function createAmbientTrail() {
  const startPosition = new THREE.Vector3(-3.5, -2.5, 0);

  const trail = createTrail(0, 0, 0);
  trail.mode = 'auto';
  trail.loopElapsed = 0;

  trail.homePosition.copy(startPosition);
  trail.position.copy(startPosition);
  trail.spawnPosition.copy(startPosition);
  trail.previousSpawnPosition.copy(startPosition);
  trail.audioDrivenPosition.copy(startPosition);

  trail.direction.set(0.25, 0.12, 0.04).normalize();
  trail.targetDirection.copy(trail.direction);
  trail.wanderPhase = 0.4;
  trail.speedMultiplier = 0.32;
  trail.maxRange = 5;

  return trail;
}
