// Lights the border of the panel under the pointer.

// Lights the border of the panel under the pointer in cyan, near the pointer (see
// .panel::before in style.css). One pointermove listener on #app serves every
// panel, throttled to one update per frame. It runs only for a pointer that can
// hover and when reduced motion is off. The header cards are not .panel, so they
// never light.
export function setupPanelLight() {
  if (!matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)').matches) return;
  const app = document.getElementById('app');
  let lit = null;
  let frame = 0;
  let last = null;
  app.addEventListener('pointermove', (e) => {
    last = e;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!last) return;
      const panel = last.target.closest ? last.target.closest('#app .panel') : null;
      if (panel !== lit) {
        if (lit) lit.classList.remove('lit');
        lit = panel;
        if (lit) lit.classList.add('lit');
      }
      if (!lit) return;
      const box = lit.getBoundingClientRect();
      lit.style.setProperty('--x', `${last.clientX - box.left}px`);
      lit.style.setProperty('--y', `${last.clientY - box.top}px`);
    });
  });
  app.addEventListener('pointerleave', () => {
    // A fast exit can land pointermove and pointerleave in one frame. Cancelling
    // the pending frame stops it from lighting the panel again after the leave.
    cancelAnimationFrame(frame);
    frame = 0;
    last = null;
    if (lit) lit.classList.remove('lit');
    lit = null;
  });
}
