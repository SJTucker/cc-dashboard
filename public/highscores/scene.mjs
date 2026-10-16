// The synthwave background of the High scores tab, ported from the approved
// mockup. Nodes are created only when buildScene() runs, so importing this module
// touches no DOM.
import { svgEl } from '../dom.mjs';

// A Park-Miller generator returning numbers in [0, 1). The same seed always gives
// the same sequence, so the skyline looks the same on every load.
function seededRandom(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const PREFIX = 'hs-';

// A gradient with the given stops ([offset, color, opacity?]), vertical unless
// `radial`. Ids carry PREFIX so they cannot clash with other SVGs on the page.
function gradient(id, stops, radial) {
  const g = svgEl(radial ? 'radialGradient' : 'linearGradient', radial ? { id: PREFIX + id } : { id: PREFIX + id, x1: 0, y1: 0, x2: 0, y2: 1 });
  for (const [offset, color, opacity] of stops) {
    const stop = svgEl('stop', { offset, 'stop-color': color });
    if (opacity !== undefined) stop.setAttribute('stop-opacity', opacity);
    g.appendChild(stop);
  }
  return g;
}

// The <defs> block: sky, sun and water gradients, the sun stripe mask, the glow
// filter and the tail-light gradient.
function buildDefs() {
  const defs = svgEl('defs');
  defs.append(
    gradient('sky', [[0, '#05020c'], [0.45, '#140630'], [0.7, '#3a0d55'], [0.72, '#2a0940']]),
    gradient('sun', [[0, '#ffb3ef'], [0.5, '#ff4fd8'], [1, '#9b3cff']]),
  );
  const mask = svgEl('mask', { id: PREFIX + 'sunStripes' });
  mask.appendChild(svgEl('rect', { x: 0, y: 0, width: 1440, height: 900, fill: '#fff' }));
  const stripes = svgEl('g', { fill: '#000' });
  for (const [y, h] of [[470, 5], [495, 7], [522, 9], [551, 11], [582, 13]]) {
    stripes.appendChild(svgEl('rect', { x: 900, y, width: 500, height: h }));
  }
  mask.appendChild(stripes);
  defs.appendChild(mask);
  defs.appendChild(gradient('water', [[0, '#2a0940'], [1, '#05020c']]));
  const filter = svgEl('filter', { id: PREFIX + 'glow' });
  filter.append(
    svgEl('feGaussianBlur', { stdDeviation: 4, result: 'b' }),
  );
  const merge = svgEl('feMerge');
  merge.append(svgEl('feMergeNode', { in: 'b' }), svgEl('feMergeNode', { in: 'SourceGraphic' }));
  filter.appendChild(merge);
  defs.appendChild(filter);
  defs.appendChild(gradient('tail', [[0, '#ff6fe0'], [1, '#ff4fd8', 0]], true));
  return defs;
}

// A <text> node for the neon signs.
function signText(x, y, fill, size, family, text) {
  const t = svgEl('text', { x, y, fill, 'font-size': size, 'text-anchor': 'middle', 'font-family': family });
  t.textContent = text;
  return t;
}

// The two neon signs, one on each side of the skyline.
function buildSigns() {
  const g = svgEl('g', { class: 'hs-signs', filter: `url(#${PREFIX}glow)` });
  g.appendChild(svgEl('rect', { x: 70, y: 330, width: 70, height: 200, fill: '#0b0419', stroke: '#4fd8ff', 'stroke-width': 3 }));
  ['夢', 'は', '終', '無'].forEach((ch, i) => g.appendChild(signText(105, 370 + i * 40, '#4fd8ff', 30, 'sans-serif', ch)));
  g.appendChild(svgEl('rect', { x: 1265, y: 490, width: 120, height: 125, fill: '#0b0419', stroke: '#ff4fd8', 'stroke-width': 3 }));
  ['CACHE', 'HITS', 'HIGHER'].forEach((w, i) => g.appendChild(signText(1325, 530 + i * 28, '#ff8be6', 20, 'VT323, monospace', w)));
  return g;
}

// The car at the bottom left with its glowing tail lights.
function buildCar() {
  const g = svgEl('g', { transform: 'translate(70 760)' });
  const glow = `url(#${PREFIX}glow)`;
  g.append(
    svgEl('path', { d: 'M0 60 L10 34 Q20 26 60 24 L110 6 Q150 -4 200 4 L250 22 Q300 26 330 36 L340 60 Z', fill: '#0d0620', stroke: '#4fd8ff', 'stroke-opacity': 0.5 }),
    svgEl('path', { d: 'M118 10 L150 2 Q180 0 205 8 L230 22 L120 24 Z', fill: '#1e0b3c', stroke: '#4fd8ff', 'stroke-opacity': 0.4 }),
    svgEl('rect', { x: 4, y: 38, width: 70, height: 8, rx: 3, fill: '#ff6fe0', filter: glow }),
    svgEl('ellipse', { cx: 40, cy: 44, rx: 70, ry: 22, fill: `url(#${PREFIX}tail)`, opacity: 0.7 }),
    svgEl('circle', { cx: 70, cy: 62, r: 18, fill: '#05020c', stroke: '#4fd8ff', 'stroke-opacity': 0.5 }),
    svgEl('circle', { cx: 270, cy: 62, r: 18, fill: '#05020c', stroke: '#4fd8ff', 'stroke-opacity': 0.5 }),
    svgEl('rect', { x: 0, y: 84, width: 200, height: 4, fill: '#ff4fd8', opacity: 0.35, filter: glow }),
  );
  return g;
}

// Builds the whole background SVG (viewBox 1440x900), ready to append to the
// screen. The random draws happen in the mockup's order so the skyline matches it.
function buildScene() {
  const rnd = seededRandom(7);
  const svg = svgEl('svg', { class: 'bg', viewBox: '0 0 1440 900', preserveAspectRatio: 'xMidYMax slice', 'aria-hidden': 'true' });
  const stars = svgEl('g', { fill: '#cfe9ff' });
  const far = svgEl('g', { fill: '#1e0b3c' });
  const near = svgEl('g', { fill: '#0b0419' });
  const windows = svgEl('g');
  const reflect = svgEl('g', { opacity: 0.35 });
  const grid = svgEl('g', { stroke: '#ff4fd8', 'stroke-opacity': 0.35, 'stroke-width': 1.5 });

  for (let i = 0; i < 90; i++) {
    stars.appendChild(svgEl('circle', { cx: rnd() * 1440, cy: rnd() * 360, r: rnd() * 1.3 + 0.2, opacity: rnd() * 0.7 + 0.2 }));
  }

  // One row of buildings between x0 and x1; `lit` rows also get windows.
  const skyline = (g, x0, x1, hmin, hmax, wmin, wmax, lit) => {
    for (let x = x0; x < x1;) {
      const w = wmin + rnd() * (wmax - wmin), h = hmin + rnd() * (hmax - hmin);
      g.appendChild(svgEl('rect', { x, y: 648 - h, width: w, height: h }));
      reflect.appendChild(svgEl('rect', { x, y: 648, width: w, height: h * 0.45, fill: '#1e0b3c' }));
      if (rnd() < 0.3) g.appendChild(svgEl('rect', { x: x + w / 2 - 1, y: 648 - h - 30, width: 2, height: 30 }));
      if (lit) {
        for (let wy = 648 - h + 10; wy < 640; wy += 12) {
          for (let wx = x + 5; wx < x + w - 6; wx += 9) {
            if (rnd() < 0.22) windows.appendChild(svgEl('rect', { x: wx, y: wy, width: 4, height: 5, fill: rnd() < 0.6 ? '#4fd8ff' : '#ff8be6', opacity: 0.25 + rnd() * 0.5 }));
          }
        }
      }
      x += w + rnd() * 6;
    }
  };
  skyline(far, 0, 470, 140, 330, 30, 70, false);
  skyline(far, 980, 1440, 140, 300, 30, 70, false);
  skyline(near, -10, 330, 90, 300, 40, 90, true);
  skyline(near, 1060, 1450, 90, 270, 40, 90, true);

  for (let i = -24; i <= 24; i++) grid.appendChild(svgEl('line', { x1: 720 + i * 30, y1: 648, x2: 720 + i * 180, y2: 900 }));
  for (let i = 1; i < 9; i++) {
    const y = 648 + Math.pow(i / 8, 2.2) * 252;
    grid.appendChild(svgEl('line', { x1: 0, y1: y, x2: 1440, y2: y }));
  }

  svg.append(
    buildDefs(),
    svgEl('rect', { width: 1440, height: 900, fill: `url(#${PREFIX}sky)` }),
    stars,
    svgEl('circle', { cx: 1150, cy: 470, r: 170, fill: `url(#${PREFIX}sun)`, mask: `url(#${PREFIX}sunStripes)`, filter: `url(#${PREFIX}glow)`, opacity: 0.95 }),
    far, near, windows,
    buildSigns(),
    svgEl('rect', { x: 0, y: 648, width: 1440, height: 252, fill: `url(#${PREFIX}water)` }),
    reflect, grid,
    svgEl('line', { x1: 0, y1: 648, x2: 1440, y2: 648, stroke: '#ff8be6', 'stroke-width': 2, filter: `url(#${PREFIX}glow)` }),
    buildCar(),
  );
  return svg;
}

export { seededRandom, buildScene };
