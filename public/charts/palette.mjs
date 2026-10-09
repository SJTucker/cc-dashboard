// Series colours and textures. Texture is the primary identity channel and colour
// the secondary one: the user is red-green colourblind. One table serves the SVG
// patterns and the CSS swatches.
import { svgEl } from '../dom.mjs';

// `dash` is the stroke-dasharray the log line chart draws each series with. It is
// the identity channel that survives colourblindness and greyscale printing, the
// same job `texture` does for the stacked bars. Colour is the secondary channel in
// both.
export const TOKEN_SERIES = [
  { key: 'input', label: 'Input', color: '#c98500', texture: 'diag', dash: '2 4' },
  { key: 'output', label: 'Output', color: '#3987e5', texture: 'diag-rev', dash: '9 4' },
  { key: 'cacheCreate', label: 'Cache write', color: '#d55181', texture: 'dots', dash: '9 4 2 4' },
  { key: 'cacheRead', label: 'Cache read', color: '#9085e9', texture: 'solid', dash: null },
];

// Validated with the dataviz skill's validate_palette.js against this dashboard's
// panel surface (#171d27, dark): every check passes, worst adjacent CVD ΔE 16.0
// (deutan). No red/green pair appears - the user is red-green colourblind. Texture
// is the primary identity channel here; colour is the secondary one.
const MODEL_STYLE = {
  opus: { color: '#d55181', texture: 'dots' },
  sonnet: { color: '#9085e9', texture: 'solid' },
  haiku: { color: '#c98500', texture: 'diag' },
  fable: { color: '#3987e5', texture: 'diag-rev' },
  mythos: { color: '#199e70', texture: 'cross' },
  other: { color: '#5c6779', texture: 'solid' },
};

// The payload carries the family key on every models[] entry and uses it for the
// byModel keys, so the matching rules live only in lib/pricing.js.
export function modelColor(family) {
  return (MODEL_STYLE[family] || MODEL_STYLE.other).color;
}

export function modelTexture(family) {
  return (MODEL_STYLE[family] || MODEL_STYLE.other).texture;
}

// One <defs> block per chart. A pattern is keyed by texture name AND colour,
// because an SVG pattern carries its own paint - two series sharing a texture at
// different colours need two pattern elements. It is also keyed by a chart scope:
// SVG ids are document-global, three charts can be on the page at once, and the
// token and model palettes reuse the same four hex values, so without a scope two
// charts would emit colliding ids for different patterns.
function patternId(scope, texture, color) {
  return `tex-${scope}-${texture}-${color.replace('#', '')}`;
}

// One vocabulary for both renderers. The charts paint SVG <pattern> elements; the
// legend swatches and the HTML mix bar paint CSS gradients. They were previously
// written out separately and drifted: the SVG and CSS diagonals ended up mirrored,
// so a legend swatch identified the wrong series. Both sides now come from here.
// Note the axis convention differs - SVG y grows downward, and a CSS gradient's
// bands run perpendicular to its angle - so the paired values below look unrelated
// but render the same way. Verify visually if you change either.
const TEXTURES = {
  // backslash "\"
  diag: {
    svg: (ink) => svgEl('path', { d: 'M0,0 l6,6', stroke: ink, 'stroke-width': 2 }),
    css: (color, ink) => `repeating-linear-gradient(45deg, ${color} 0 4px, ${ink} 4px 6px)`,
  },
  // forward slash "/"
  'diag-rev': {
    svg: (ink) => svgEl('path', { d: 'M0,6 l6,-6', stroke: ink, 'stroke-width': 2 }),
    css: (color, ink) => `repeating-linear-gradient(-45deg, ${color} 0 4px, ${ink} 4px 6px)`,
  },
  dots: {
    svg: (ink) => svgEl('circle', { cx: 3, cy: 3, r: 1.4, fill: ink }),
    css: (color, ink) => `radial-gradient(${ink} 1.4px, ${color} 1.5px) 0 0/6px 6px`,
  },
  cross: {
    svg: (ink) => svgEl('path', { d: 'M0,3 h6 M3,0 v6', stroke: ink, 'stroke-width': 1.2 }),
    // The first layer must be transparent where it is not ink, or it paints over the
    // second and the grid renders as plain horizontal stripes.
    css: (color, ink) => `repeating-linear-gradient(0deg, transparent 0 4px, ${ink} 4px 5px), repeating-linear-gradient(90deg, ${color} 0 4px, ${ink} 4px 5px)`,
  },
  solid: { svg: null, css: (color) => color },
};

const TEXTURE_INK = '#05070d';

// CSS `background` value for a texture, used by every legend swatch and the mix bar.
export function textureCss(texture, color) {
  const entry = TEXTURES[texture] || TEXTURES.solid;
  return entry.css(color, TEXTURE_INK);
}

export function appendPatternDefs(svg, scope, series) {
  const defs = svgEl('defs');
  const seen = new Set();

  for (const { texture, color } of series) {
    const id = patternId(scope, texture, color);
    if (seen.has(id)) continue;
    seen.add(id);

    const entry = TEXTURES[texture] || TEXTURES.solid;
    // 'solid' has no overlay and fillFor() returns the raw colour for it, so no
    // pattern element is ever referenced for it - skip emitting one.
    if (!entry.svg) continue;

    const pattern = svgEl('pattern', {
      id, width: 6, height: 6, patternUnits: 'userSpaceOnUse',
    });
    pattern.appendChild(svgEl('rect', { width: 6, height: 6, fill: color }));

    // The overlay is drawn in the page background colour so a texture reads as a
    // cut-out rather than a second hue - it stays legible in forced-colours mode
    // and in print.
    pattern.appendChild(entry.svg(TEXTURE_INK));

    defs.appendChild(pattern);
  }

  svg.appendChild(defs);
}

export function fillFor(scope, texture, color) {
  return texture === 'solid' ? color : `url(#${patternId(scope, texture, color)})`;
}

// CSS equivalent of the SVG patterns, for the HTML mix bar. Same texture table, so a
// family looks identical in the mix bar and in the chart.
export function segmentTexture(family) {
  const { color, texture } = MODEL_STYLE[family] || MODEL_STYLE.other;
  return `background:${textureCss(texture, color)}`;
}
