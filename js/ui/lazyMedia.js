/**
 * lazyMedia.js — IntersectionObserver-based lazy loader for images/posters.
 * Preloads image off-DOM, then fades it in for a premium skeleton-to-image transition.
 */

const io = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target;
          const src = el.dataset.src;
          if (src) {
            // Load off-DOM to prevent broken image flashes
            const preload = new Image();
            preload.onload = () => {
              el.src = src;
              // Trigger a fade-in animation by removing the skeleton class or asserting opacity
              el.classList.remove('skeleton');
              el.classList.add('loaded');
            };
            preload.src = src;
            el.removeAttribute('data-src');
          }
          io.unobserve(el);
        }
      });
    }, { rootMargin: '300px 0px' }) // load slightly earlier
  : null;

export function lazyImage(imgEl, src) {
  if (!imgEl) return;
  if (!src) return;
  // Initialize as skeleton
  imgEl.classList.add('skeleton');
  imgEl.dataset.src = src;
  if (io) io.observe(imgEl);
  else {
    imgEl.src = src;
    imgEl.classList.remove('skeleton');
  }
}
