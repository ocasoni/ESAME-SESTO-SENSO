const MOVE_DURATION_MS = 4000;
const EXIT_DURATION_MS = 1000;
const BG_FADE_MS = 900;

function setupCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  return { ctx, width, height };
}

function trailPosition(progress, width, height) {
  const cx = width * 0.5;
  const cy = height * 0.52;
  const angle = progress * Math.PI * 2.8;

  return {
    x: cx + Math.sin(angle * 1.15) * width * 0.28 + Math.cos(angle * 0.7) * width * 0.08,
    y: cy + Math.cos(angle * 0.95) * height * 0.22 + Math.sin(angle * 1.4) * height * 0.06,
  };
}

function drawTrail(ctx, particles, head, opacity) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = opacity;

  for (const particle of particles) {
    const size = particle.size * (0.35 + particle.life * 0.65);
    const gradient = ctx.createRadialGradient(
      particle.x,
      particle.y,
      0,
      particle.x,
      particle.y,
      size * 2.4
    );

    gradient.addColorStop(0, `rgba(120, 240, 255, ${particle.life * 0.95})`);
    gradient.addColorStop(0.45, `rgba(180, 90, 255, ${particle.life * 0.55})`);
    gradient.addColorStop(1, 'rgba(120, 240, 255, 0)');

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, size * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  const headGradient = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 16);
  headGradient.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  headGradient.addColorStop(0.35, 'rgba(120, 240, 255, 0.75)');
  headGradient.addColorStop(1, 'rgba(180, 90, 255, 0)');

  ctx.fillStyle = headGradient;
  ctx.beginPath();
  ctx.arc(head.x, head.y, 16, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

export function runMicSplash() {
  const splash = document.getElementById('mic-splash');
  const canvas = document.getElementById('mic-splash-canvas');

  if (!splash || !canvas) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const { ctx, width, height } = setupCanvas(canvas);
    const particles = [];
    const startedAt = performance.now();
    let rafId = 0;

    const tick = (now) => {
      const elapsed = now - startedAt;
      const moveProgress = Math.min(elapsed / MOVE_DURATION_MS, 1);
      const exitElapsed = Math.max(elapsed - MOVE_DURATION_MS, 0);
      const exitProgress = Math.min(exitElapsed / EXIT_DURATION_MS, 1);

      const head = trailPosition(moveProgress, width, height);
      const exitOffsetX = exitProgress * width * 1.15;
      const trailOpacity = 1 - exitProgress;

      particles.push({
        x: head.x,
        y: head.y,
        life: 1,
        size: 2.2 + Math.random() * 2.8,
      });

      if (particles.length > 90) {
        particles.splice(0, particles.length - 90);
      }

      for (const particle of particles) {
        particle.life -= 0.018 + exitProgress * 0.04;
      }

      ctx.clearRect(0, 0, width, height);

      const shiftedParticles = particles
        .filter((particle) => particle.life > 0)
        .map((particle) => ({
          ...particle,
          x: particle.x + exitOffsetX,
        }));

      const shiftedHead = {
        x: head.x + exitOffsetX,
        y: head.y,
      };

      drawTrail(ctx, shiftedParticles, shiftedHead, trailOpacity);

      if (elapsed >= MOVE_DURATION_MS) {
        splash.classList.add('is-exiting');
      }

      if (elapsed >= MOVE_DURATION_MS + EXIT_DURATION_MS) {
        cancelAnimationFrame(rafId);
        splash.classList.add('is-hidden');

        window.setTimeout(() => {
          splash.remove();
          resolve();
        }, BG_FADE_MS);

        return;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
  });
}
