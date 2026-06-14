import * as THREE from 'three/webgpu';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { createSplashTrail, createTrailEngine } from '../src/trailCore.js';

const DRAW_MS = 4000;
const TAIL_FADE_MS = 2400;
const BG_FADE_MS = 900;

export async function runMicSplash() {
  const splash = document.getElementById('mic-splash');
  const stage = document.getElementById('mic-splash-stage');

  if (!splash || !stage) {
    return;
  }

  if (WebGPU.isAvailable() === false) {
    splash.remove();
    return;
  }

  const scene = new THREE.Scene();
  const worldGroup = new THREE.Group();
  scene.add(worldGroup);

  const camera = new THREE.PerspectiveCamera(
    59,
    window.innerWidth / window.innerHeight,
    0.1,
    200
  );
  camera.position.set(0, 0, 20);

  const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: false });
  renderer.setClearColor(0x000000);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  stage.appendChild(renderer.domElement);

  try {
    await renderer.init();
  } catch (error) {
    console.error(error);
    splash.remove();
    return;
  }

  const engine = await createTrailEngine(renderer, worldGroup, 1);
  const trail = createSplashTrail();
  const clock = new THREE.Clock();
  const startedAt = performance.now();
  let spawning = true;
  let tailFading = false;
  let bgFadeStarted = false;
  let rafId = 0;

  await new Promise((resolve) => {
    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };

    window.addEventListener('resize', onResize);

    const finish = () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(rafId);
      renderer.dispose();
      splash.classList.add('is-hidden');

      window.setTimeout(() => {
        splash.remove();
        resolve();
      }, BG_FADE_MS);
    };

    const tick = () => {
      const elapsed = performance.now() - startedAt;
      const delta = Math.min(clock.getDelta(), 0.033);

      if (spawning && elapsed >= DRAW_MS) {
        spawning = false;
        tailFading = true;
      }

      if (spawning) {
        engine.tickTrail(trail, delta, { spawn: true, audioStarted: true });
      } else {
        renderer.compute(engine.updateParticles);

        if (tailFading) {
          engine.fadeSlot(trail.particleStart, 1.05);
        }
      }

      renderer.render(scene, camera);

      if (!bgFadeStarted && !spawning) {
        bgFadeStarted = true;
        splash.classList.add('is-exiting');
      }

      if (elapsed >= DRAW_MS + TAIL_FADE_MS) {
        finish();
        return;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
  });
}
