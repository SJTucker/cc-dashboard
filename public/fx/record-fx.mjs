// A short pixel-art fight inside the sticky header bar, played when today sets a
// record. Two animations exist (an ice ninja freezes and shatters the Claude
// character, or a soldier shoots it). A narrow bar, or reduced motion, shows only
// the gold record text. Nothing here touches the DOM until playRecordFx is called.
import { PALETTE, NINJA, SOLDIER, RIFLE, CLAUDE, BLOOD, FROZEN, WHITE } from './sprites.mjs';

const FIGHT_MS = 8400; // one record; each further record adds RECORD_MS
const RECORD_MS = 1500; // how long each record shows when there are several
const TEXT_MS = 4000; // text mode, one record
const MIN_FIGHT_WIDTH = 640;
const FADE_OUT_MS = 400;
const SHOTS = [1700, 1850, 2000, 2250];
const RIFLE_ICON = '<svg width="34" height="10" viewBox="0 0 34 10" fill="#fff"><rect x="0" y="3" width="22" height="3"/><rect x="22" y="2" width="12" height="2"/><rect x="5" y="6" width="3" height="4"/><rect x="12" y="6" width="3" height="3"/><rect x="0" y="2" width="5" height="6"/></svg>';
const RANK_ICON = '<svg width="40" height="44" viewBox="0 0 40 44"><g fill="#ffd65a" stroke="#000" stroke-width="1.5"><path d="M4 4 L20 14 L36 4 L36 12 L20 22 L4 12 Z"/><path d="M4 16 L20 26 L36 16 L36 24 L20 34 L4 24 Z"/><path d="M4 28 L20 38 L36 28 L36 34 L20 44 L4 34 Z" opacity=".55"/></g></svg>';

let playing = null;

// Returns 'text' when reduced motion is on or the bar is narrower than 640 px,
// and 'fight' otherwise, because the fight needs room for both characters.
export function fxMode({ width, reducedMotion }) {
  return reducedMotion || width < MIN_FIGHT_WIDTH ? 'text' : 'fight';
}

// Returns 'fatality' for the lower half of random() and 'headshot' for the upper.
export function pickAnimation(random = Math.random) {
  return random() < 0.5 ? 'fatality' : 'headshot';
}

const clamp = (k) => Math.max(0, Math.min(1, k));
const lerp = (a, b, k) => a + (b - a) * clamp(k);
const span = (t, a, b) => (t - a) / (b - a);

// Creates an element with a class, optional text and optional markup.
function make(tag, className, text, html) {
  const e = document.createElement(tag);
  e.className = className;
  if (text) e.textContent = text;
  if (html) e.innerHTML = html;
  return e;
}

// Fades and shakes a text cue in over [a, b): it eases in over 120 ms, fades out
// over its last 200 ms, and pops from 1.8x to 1x with an optional shake.
function cue(el, t, a, b, shake, base = 'translate(-50%, -50%)') {
  const on = t >= a && t < b;
  el.style.opacity = on ? Math.min(clamp(span(t, a, a + 120)), clamp((b - t) / 200)) : 0;
  if (!on) return;
  const pop = 1 + Math.max(0, 1 - span(t, a, a + 180)) * 0.8;
  const dx = shake && t - a < 400 ? Math.sin(t / 18) * 3 : 0;
  el.style.transform = `${base} translateX(${dx}px) scale(${pop})`;
}

// Draws a character grid with one fillRect per pixel. map swaps colour keys.
function sprite(ctx, rows, x, y, s, map) {
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      let ch = rows[r][c];
      if (ch === '.') continue;
      if (map) ch = map[ch] || ch;
      ctx.fillStyle = PALETTE[ch];
      ctx.fillRect(Math.round(x + c * s), Math.round(y + r * s), s, s);
    }
  }
}

// Returns one red particle per pixel of the grid, thrown up and sideways.
function burst(x, y, rows, s, spread) {
  const out = [];
  rows.forEach((row, r) => [...row].forEach((ch, c) => {
    if (ch === '.') return;
    out.push({ x: x + c * s, y: y + r * s, vx: (c - 7) * spread + Math.random() * 60 + 30, vy: -120 - Math.random() * 160, col: BLOOD[Math.floor(Math.random() * BLOOD.length)] });
  }));
  return out;
}

// Draws the particles dt seconds after the burst. They stop on the floor.
function drawBurst(ctx, ps, dt, ground) {
  for (const p of ps) {
    ctx.fillStyle = p.col;
    ctx.fillRect(p.x + p.vx * dt, Math.min(ground - 3, p.y + p.vy * dt + 400 * dt * dt), 3, 3);
  }
}

// Sets the record text for the cue's current slot. Records show in turn from
// startAt, RECORD_MS each, and the last one stays until the arena fades.
function recordIndex(t, startAt, n) {
  return Math.max(0, Math.min(n - 1, Math.floor((t - startAt) / RECORD_MS)));
}

function setRecord(g, t, startAt) {
  const i = recordIndex(t, startAt, g.records.length);
  if (g.shown === i) return;
  g.shown = i;
  g.nameEls.forEach((e) => { e.textContent = g.records[i].title; });
  g.scoreEls.forEach((e) => { e.textContent = g.records[i].score; });
}

// Draws one frame of the fatality at t ms. g holds the canvas, size and cues.
function fatality(t, g) {
  const { ctx, W, H, el, end } = g;
  const cx = W / 2, ground = H - 4, nH = 20 * 3, cH = 40;
  const homeX = cx - 210, claudeX = cx + 150, cy = ground - cH;
  const fade = end - FADE_OUT_MS;
  g.overlay.style.opacity = t < 250 ? t / 250 : t > fade ? clamp(1 - (t - fade) / FADE_OUT_MS) : 1;
  ctx.clearRect(0, 0, W, H);
  ctx.globalAlpha = t > 5600 ? clamp(1 - (t - 5600) / 300) : 1;
  let nx = homeX, pose = 'stand';
  if (t < 900) { nx = lerp(-60, homeX, t / 900); pose = Math.floor(t / 120) % 2 ? 'walk' : 'stand'; }
  else if (t >= 2200 && t < 2800) pose = 'throw';
  else if (t >= 3200 && t < 3450) { nx = lerp(homeX, claudeX - 52, span(t, 3200, 3450)); pose = Math.floor(t / 80) % 2 ? 'walk' : 'stand'; }
  else if (t >= 3450 && t < 3800) { nx = claudeX - 52; pose = 'kick'; }
  else if (t >= 3800 && t < 4200) nx = lerp(claudeX - 52, homeX, span(t, 3800, 4200));
  else if (t >= 4200) pose = 'win';
  sprite(ctx, NINJA[pose], nx, ground - nH, 3);
  if (t < 2650) {
    const sway = Math.sin(t / 140) * 3;
    sprite(ctx, CLAUDE, claudeX + sway, cy, 4);
    for (let k = 0; k < 3; k++) {
      const a = t / 220 + k * 2.09;
      ctx.fillStyle = PALETTE.Y;
      ctx.fillRect(claudeX + 26 + sway + Math.cos(a) * 18, cy - 8 + Math.sin(a) * 4, 3, 3);
    }
  } else if (t < 3550) {
    ctx.fillStyle = 'rgba(160,230,255,.25)';
    ctx.fillRect(claudeX - 6, cy - 8, 68, cH + 8);
    ctx.strokeStyle = '#c8f6ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(claudeX - 6, cy - 8, 68, cH + 8);
    sprite(ctx, CLAUDE, claudeX, cy, 4, FROZEN);
  } else {
    g.parts = g.parts || burst(claudeX, cy, CLAUDE, 4, 18);
    drawBurst(ctx, g.parts, (t - 3550) / 1000, ground);
  }
  if (t >= 2300 && t < 2650) {
    const bx = lerp(nx + 48, claudeX, span(t, 2300, 2650)), by = ground - nH + 26;
    for (let j = 0; j < 5; j++) {
      ctx.fillStyle = `rgba(150,230,255,${0.6 - j * 0.11})`;
      ctx.beginPath();
      ctx.arc(bx - j * 12, by, 7 - j, 0, 7);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  el.flash.style.opacity = t >= 3550 && t < 3750 ? 1 - span(t, 3550, 3750) : 0;
  cue(el.finish, t, 900, 2200, true);
  cue(el.fatality, t, 4000, 5600, true);
  setRecord(g, t, 5900);
  cue(el.record, t, 5900, fade, false);
}

// Draws one frame of the headshot at t ms.
function headshot(t, g) {
  const { ctx, W, H, el, end } = g;
  const cx = W / 2, ground = H - 4, sH = 20 * 3, cH = 40;
  const homeX = cx - 230, claudeX = cx + 150;
  const fade = end - FADE_OUT_MS;
  g.overlay.style.opacity = t < 250 ? t / 250 : t > fade ? clamp(1 - (t - fade) / FADE_OUT_MS) : 1;
  ctx.clearRect(0, 0, W, H);
  ctx.globalAlpha = t > 4600 ? clamp(1 - (t - 4600) / 300) : 1;

  // The soldier walks in, aims, fires and lowers the rifle.
  let sx = homeX, pose = 'aim';
  if (t < 900) { sx = lerp(-70, homeX, t / 900); pose = Math.floor(t / 120) % 2 ? 'walk' : 'aim'; }
  const lastShot = SHOTS.filter((s) => t >= s).pop();
  const recoil = lastShot !== undefined && t - lastShot < 70 ? -3 : 0;
  if (t > 3300) pose = 'low';
  sprite(ctx, SOLDIER[pose], sx + recoil, ground - sH, 3);
  const low = pose === 'low';
  const rx = sx + recoil + 7 * 3 - (low ? 6 : 0), ry = ground - sH + 7 * 3 + (low ? 9 : 0);
  sprite(ctx, RIFLE, rx, ry, 3);
  const barrelX = rx + 22 * 3, barrelY = ry + 2 * 3 + 1;

  // The Claude character hops until hit, flashes white on each hit, bursts on the last.
  const hop = t < 1600 ? Math.abs(Math.sin(t / 160)) * 10 : 0, cy = ground - cH - hop;
  const killAt = SHOTS[SHOTS.length - 1] + 70;
  if (t < killAt) {
    const hit = SHOTS.some((s) => t >= s + 70 && t < s + 150);
    sprite(ctx, CLAUDE, claudeX + (hit ? 3 : 0), cy, 4, hit ? WHITE : null);
  } else {
    g.parts = g.parts || burst(claudeX, cy, CLAUDE, 4, 26);
    const dt = (t - killAt) / 1000;
    drawBurst(ctx, g.parts, dt, ground);
    for (let k = 0; k < 6; k++) {
      const r = 6 + dt * 40 + k * 2, a = clamp(0.5 - dt * 0.5);
      ctx.fillStyle = `rgba(150,20,30,${a * 0.6})`;
      ctx.beginPath();
      ctx.arc(claudeX + 28 + Math.cos(k) * dt * 50, cy + 20 - dt * 30 - k * 3, r, 0, 7);
      ctx.fill();
    }
  }

  // The crosshair closes on the target before the first shot.
  if (t >= 900 && t < killAt + 200) {
    const k = clamp(span(t, 900, 1500)), r = lerp(40, 14, k), tx = claudeX + 28, ty = ground - cH / 2 - 4;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(tx, ty, r, 0, 7);
    ctx.stroke();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.beginPath();
      ctx.moveTo(tx + dx * (r - 6), ty + dy * (r - 6));
      ctx.lineTo(tx + dx * (r + 6), ty + dy * (r + 6));
      ctx.stroke();
    }
  }

  // A muzzle flash, tracer and hit marker for each shot.
  for (const s of SHOTS) {
    const kill = s === SHOTS[SHOTS.length - 1];
    if (t >= s && t < s + 60) {
      ctx.fillStyle = '#fff3b0';
      ctx.beginPath();
      ctx.moveTo(barrelX, barrelY - 6);
      ctx.lineTo(barrelX + 16, barrelY);
      ctx.lineTo(barrelX, barrelY + 6);
      ctx.fill();
    }
    if (t >= s && t < s + 80) {
      const k = span(t, s, s + 80);
      ctx.strokeStyle = 'rgba(255,230,150,.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(lerp(barrelX, claudeX, k - 0.3), barrelY);
      ctx.lineTo(lerp(barrelX, claudeX + 10, k), barrelY + 4 * k);
      ctx.stroke();
    }
    if (t >= s + 70 && t < s + (kill ? 400 : 200)) {
      const hx = claudeX + 28, hy = ground - cH / 2 - 4, gap = kill ? 12 : 8;
      ctx.strokeStyle = kill ? '#ff3b3b' : '#ffffff';
      ctx.lineWidth = kill ? 3 : 2;
      for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        ctx.beginPath();
        ctx.moveTo(hx + dx * 4, hy + dy * 4);
        ctx.lineTo(hx + dx * gap, hy + dy * gap);
        ctx.stroke();
      }
    }
  }

  // "+100" floats up from the kill.
  if (t >= killAt && t < killAt + 1100) {
    const k = span(t, killAt, killAt + 1100);
    ctx.globalAlpha = clamp(1.4 - k * 1.4) * (t > 4600 ? 0 : 1);
    ctx.font = "16px 'Black Ops One'";
    ctx.fillStyle = '#ffd65a';
    ctx.fillText('+100', claudeX + 70, ground - cH - 4 - k * 20);
  }
  ctx.globalAlpha = 1;

  cue(el.killfeed, t, killAt + 100, 4600, false, '');
  cue(el.headshot, t, killAt + 300, 4400, true);
  setRecord(g, t, 4900);
  cue(el.record, t, 4900, fade, false);
  el.xp.style.width = `${clamp(span(t, 5100, 6300)) * 100}%`;
}

// Builds the cue elements for one animation inside overlay and returns them.
function buildCues(overlay, kind) {
  const el = { flash: make('div', 'fx-flash') };
  overlay.append(el.flash);
  if (kind === 'fatality') {
    el.finish = make('div', 'fx fx-mk fx-finish', 'FINISH HIM!');
    el.fatality = make('div', 'fx fx-mk fx-fatality', 'FATALITY');
    el.record = make('div', 'fx fx-mk fx-gold', '', 'NEW RECORD · <span class="fx-name"></span> · <span class="fx-score"></span>');
    overlay.append(el.finish, el.fatality, el.record);
  } else {
    el.killfeed = make('div', 'fx fx-cod fx-killfeed', '', `<span class="fx-attacker">SOLDIER</span>${RIFLE_ICON}<span class="fx-victim">CLAUDE</span>`);
    el.headshot = make('div', 'fx fx-cod fx-headshot', 'HEADSHOT');
    el.record = make('div', 'fx fx-cod fx-rankup', '', `${RANK_ICON}<div class="fx-rank-text"><small>NEW RECORD</small><b><span class="fx-name"></span> · <span class="fx-score"></span></b><div class="fx-xp"><i></i></div></div>`);
    overlay.append(el.killfeed, el.headshot, el.record);
    el.xp = el.record.querySelector('.fx-xp i');
  }
  return el;
}

// Shows the gold NEW RECORD text only: 4 s for one record, 1.5 s each for several.
// Calls done when the last record has been shown.
function runText(overlay, records, done) {
  const line = make('div', 'fx fx-mk fx-gold fx-text');
  line.style.opacity = 1;
  overlay.append(line);
  let i = 0;
  const step = () => {
    if (i >= records.length) return done();
    line.textContent = `NEW RECORD · ${records[i].title} · ${records[i].score}`;
    const ms = records.length === 1 ? TEXT_MS : RECORD_MS;
    i += 1;
    setTimeout(step, ms);
  };
  step();
}

// Plays the animation inside topbar and resolves once the overlay is removed. A
// call while one plays returns the same promise. records are display strings,
// { title, score }. The canvas is sized to the bar and the loop follows elapsed
// time, so the millisecond marks hold even when frames are dropped.
export function playRecordFx(topbar, records, { random = Math.random, reducedMotion } = {}) {
  if (playing) return playing;
  const list = records && records.length ? records : [{ title: '', score: '' }];
  const reduced = reducedMotion ?? (globalThis.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)').matches : false);
  const rect = topbar.getBoundingClientRect();
  const overlay = make('div', 'record-fx');
  overlay.setAttribute('aria-hidden', 'true');
  const canvas = make('canvas', 'fx-canvas');
  let mode = fxMode({ width: rect.width, reducedMotion: reduced });
  const ctx = mode === 'fight' ? canvas.getContext('2d') : null;
  if (mode === 'fight' && !ctx) mode = 'text';
  topbar.append(overlay);

  playing = new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      overlay.remove();
      playing = null;
      resolve();
    };
    if (mode === 'text') {
      overlay.className = 'record-fx record-fx-text';
      overlay.style.opacity = 1;
      runText(overlay, list, finish);
      return;
    }
    const kind = pickAnimation(random);
    overlay.className = `record-fx ${kind}`;
    overlay.append(canvas);
    const g = { ctx, overlay, canvas, records: list, shown: -1, parts: null, W: 0, H: 0, end: FIGHT_MS + RECORD_MS * (list.length - 1) };
    g.el = buildCues(overlay, kind);
    g.nameEls = [...overlay.querySelectorAll('.fx-name')];
    g.scoreEls = [...overlay.querySelectorAll('.fx-score')];
    const draw = kind === 'fatality' ? fatality : headshot;
    let start = null;
    const frame = (now) => {
      // Any drawing error ends the animation, so the promise resolves and the overlay goes.
      try {
        if (start === null) start = now;
        const t = now - start;
        if (t >= g.end) return finish();
        const w = topbar.clientWidth, h = topbar.clientHeight, d = globalThis.devicePixelRatio || 1;
        if (w !== g.W || h !== g.H) {
          g.W = w;
          g.H = h;
          canvas.width = w * d;
          canvas.height = h * d;
          ctx.setTransform(d, 0, 0, d, 0, 0);
          ctx.imageSmoothingEnabled = false;
        }
        draw(t, g);
        requestAnimationFrame(frame);
      } catch {
        finish();
      }
    };
    requestAnimationFrame(frame);
  });
  return playing;
}
