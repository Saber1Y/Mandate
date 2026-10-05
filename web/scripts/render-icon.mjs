#!/usr/bin/env node
/**
 * Render the Mandate favicon.
 *
 * Next serves app/icon.png and app/apple-icon.png as the favicon and the Apple touch icon, and they
 * are generated from the same geometry as <Mark/> in components/ui/Logo.tsx so the browser tab and
 * the nav can never drift apart.
 *
 * The raster is drawn here rather than by rasterising the SVG because `sharp` on this machine has no
 * SVG delegate: it accepts SVG input and emits a blank image without erroring, which is exactly the
 * kind of silent failure that ships a white favicon. Drawing the ring and the dot directly cannot
 * fail that way, and the assertion at the end fails loudly if the output is ever blank.
 *
 * Usage: node scripts/render-icon.mjs
 */

import sharp from "sharp";
import {writeFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Keep in step with --color-accent in app/globals.css. */
const ACCENT = {r: 15, g: 118, b: 110};
const BACKGROUND = {r: 255, g: 255, b: 255};

/**
 * The mark, in the same 32-unit space as the SVG in components/ui/Logo.tsx.
 *
 * A ring of radius 10.4 centred at 16,16 with a wedge removed for the opening, and a filled dot of
 * radius 4.1 at the centre. `gapStart`/`gapEnd` are the angles of the opening in degrees, measured the
 * same way as the SVG arc flags: clockwise from 3 o'clock in a y-down space.
 *
 * These numbers are derived from the arc in components/ui/Logo.tsx
 * (`M25.6 20.2A10.4 10.4 0 1 1 20.2 25.6`): its endpoints sit at 23.6deg and 66.4deg, and
 * large-arc=1 sweep=1 draws the complement, so the opening is exactly that 42.8deg wedge. Change one
 * and you must change the other.
 */
const RING = {cx: 16, cy: 16, r: 10.4, width: 3.1, gapStart: 23.6, gapEnd: 66.4};
const DOT = {cx: 16, cy: 16, r: 4.1};

/** Distance from point p to segment ab, for stroke rendering. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Coverage of one pixel by the mark, 0..1.
 *
 * Supersampled 4x4 because a hard analytic edge test at 32px produces jaggies that look broken in a
 * browser tab. Cheap enough at favicon sizes and avoids needing an SVG rasteriser.
 */
function coverage(px, py) {
  let hits = 0;
  const samples = 4;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const x = px + (sx + 0.5) / samples;
      const y = py + (sy + 0.5) / samples;
      if (distToSegment(x, y, DOT.cx, DOT.cy, DOT.cx, DOT.cy) <= DOT.r) {
        hits++;
        continue;
      }
      const dist = distToSegment(x, y, RING.cx, RING.cy, RING.cx + RING.r, RING.cy);
      if (Math.abs(dist - RING.r) > RING.width / 2) continue;
      // Angle of the sample relative to the ring centre, in degrees clockwise from 3 o'clock.
      let deg = (Math.atan2(y - RING.cy, x - RING.cx) * 180) / Math.PI;
      if (deg < 0) deg += 360;
      if (deg >= RING.gapStart && deg <= RING.gapEnd) continue;
      hits++;
    }
  }
  return hits / (samples * samples);
}

function render(size) {
  const scale = size / 32;
  const data = Buffer.alloc(size * size * 4);
  const half = RING.width / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ux = (x + 0.5) / scale;
      const uy = (y + 0.5) / scale;
      const a = coverage(ux, uy);
      const i = (y * size + x) * 4;
      // Composite mark over white so the PNG is opaque and looks right on any tab colour.
      data[i] = Math.round(BACKGROUND.r * (1 - a) + ACCENT.r * a);
      data[i + 1] = Math.round(BACKGROUND.g * (1 - a) + ACCENT.g * a);
      data[i + 2] = Math.round(BACKGROUND.b * (1 - a) + ACCENT.b * a);
      data[i + 3] = 255;
    }
  }
  return {data, size, half};
}

const targets = [
  {file: "app/icon.png", size: 512},
  {file: "app/apple-icon.png", size: 180},
];

for (const {file, size} of targets) {
  const {data} = render(size);
  const input = sharp(data, {raw: {width: size, height: size, channels: 4}});

  // Guard against the silent-blank failure that motivated drawing this by hand.
  const stats = await input.stats();
  const painted = size * size - stats.channels[0].min;
  if (painted < size * size * 0.01) {
    throw new Error(`render-icon: ${file} came out blank (only ${painted} non-white pixels).`);
  }

  const buffer = await input.png().toBuffer();
  writeFileSync(path.join(root, file), buffer);
  console.log(`render-icon: ${file} (${size}x${size}, ${buffer.length} bytes)`);
}