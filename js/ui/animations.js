/**
 * animations.js — JS animation helpers + canvas starfield
 */

export function initBackground() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let W = 0, H = 0, stars = [];

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
    stars = Array.from({ length: 120 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.5 + 0.3,
      alpha: Math.random() * 0.6 + 0.1,
      speed: Math.random() * 0.3 + 0.05,
      drift: (Math.random() - 0.5) * 0.1,
    }));
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Nebula-like gradient blobs
    const gradients = [
      { x: W * 0.15, y: H * 0.2, c1: 'rgba(124,77,255,0.08)', c2: 'transparent', r: 350 },
      { x: W * 0.85, y: H * 0.7, c1: 'rgba(224,64,251,0.06)', c2: 'transparent', r: 300 },
      { x: W * 0.5, y: H * 0.5, c1: 'rgba(0,229,255,0.04)', c2: 'transparent', r: 400 },
    ];

    gradients.forEach(g => {
      const grad = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, g.r);
      grad.addColorStop(0, g.c1);
      grad.addColorStop(1, g.c2);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
      ctx.fill();
    });

    // Stars
    stars.forEach(star => {
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(232, 234, 246, ${star.alpha})`;
      ctx.fill();

      // Drift
      star.y -= star.speed;
      star.x += star.drift;
      star.alpha += (Math.random() - 0.5) * 0.01;
      star.alpha = Math.max(0.05, Math.min(0.8, star.alpha));

      if (star.y < -5) { star.y = H + 5; star.x = Math.random() * W; }
      if (star.x < -5) star.x = W + 5;
      if (star.x > W + 5) star.x = -5;
    });

    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  resize();
  draw();
}

export function staggerReveal(elements, delay = 40) {
  elements.forEach((el, i) => {
    el.style.animationDelay = `${i * delay}ms`;
    el.style.opacity = '0';
    el.style.animation = 'none';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.animation = `cardReveal 0.35s ease ${i * delay}ms both`;
        el.style.opacity = '';
      });
    });
  });
}

export function showSkeletonGrid(container, count = 12) {
  container.innerHTML = `
    <div class="skeleton-card-grid">
      ${Array.from({ length: count }, () => `
        <div class="skeleton-card">
          <div class="skeleton skeleton-poster"></div>
          <div class="skeleton-body">
            <div class="skeleton skeleton-text"></div>
            <div class="skeleton skeleton-text short"></div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}
