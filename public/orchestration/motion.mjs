// Motion for the Orchestration tab, using the values in the design spec's motion
// table. Each helper takes { animate } and does nothing when it is false, so the
// first render and a switch of orchestration stay still. Under
// prefers-reduced-motion every helper keeps the opacity change and drops blur and
// translate. Nothing here runs at import time.
export const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function canAnimate(node) {
  return typeof node.animate === 'function';
}

// Fades node from 0 to 1 over 160ms (a worker card's step list).
export function fadeIn(node, { animate }) {
  if (!animate || !canAnimate(node)) return;
  node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: EASE });
}

// Moves a new node in from 6px above over 240ms (a new board post). opacity is
// the resting opacity, 0.6 for a post still waiting to be confirmed.
export function enter(node, { animate, opacity = 1 }) {
  if (!animate || !canAnimate(node)) return;
  const from = reducedMotion() ? { opacity: 0 } : { opacity: 0, transform: 'translateY(-6px)' };
  const to = reducedMotion() ? { opacity } : { opacity, transform: 'none' };
  node.animate([from, to], { duration: 240, easing: EASE });
}

// Replaces node's content with text. Text that changed fades out over 90ms and
// back in over 160ms, with blur(2px) so the two texts do not read as overlapping.
// write(node, text) sets the content, textContent by default. A change that
// arrives during a fade cancels it and starts again from the new text.
export function swapText(node, text, { animate, write = (n, t) => { n.textContent = t; } }) {
  if (node.dataset.swapped === text) return;
  node.dataset.swapped = text;
  node._swapFade?.cancel();
  node._swapFade = null;
  if (!animate || !canAnimate(node)) {
    write(node, text);
    return;
  }
  const blur = reducedMotion() ? {} : { filter: 'blur(2px)' };
  const clear = reducedMotion() ? {} : { filter: 'blur(0)' };
  const out = node.animate([{ opacity: 1, ...clear }, { opacity: 0, ...blur }], { duration: 90, easing: 'ease-out', fill: 'forwards' });
  node._swapFade = out;
  out.onfinish = () => {
    write(node, text);
    out.cancel();
    node._swapFade = node.animate([{ opacity: 0, ...blur }, { opacity: 1, ...clear }], { duration: 160, easing: EASE });
  };
}
