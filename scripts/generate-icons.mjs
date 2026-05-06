/**
 * Generates the 3 PWA icons from the master SVG using `sharp`.
 * Run from repo root:
 *   npm install --no-save sharp
 *   node scripts/generate-icons.mjs
 */
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(__dirname, '..', 'shared', 'assets');
mkdirSync(ASSETS, { recursive: true });

const SVG_NORMAL = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="96" fill="url(#bg)"/>
  <path d="M128 144 L192 368 L256 224 L320 368 L384 144"
        stroke="#ffffff" stroke-width="40" fill="none"
        stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="384" cy="144" r="22" fill="#fbbf24"/>
</svg>`;

const SVG_MASK = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="translate(96 96) scale(0.625)">
    <path d="M128 144 L192 368 L256 224 L320 368 L384 144"
          stroke="#ffffff" stroke-width="40" fill="none"
          stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="384" cy="144" r="22" fill="#fbbf24"/>
  </g>
</svg>`;

async function emit(svg, size, name) {
    const out = resolve(ASSETS, name);
    await sharp(Buffer.from(svg))
        .resize(size, size, { fit: 'contain' })
        .png({ compressionLevel: 9 })
        .toFile(out);
    console.log(`✅ ${name} (${size}×${size})`);
}

await emit(SVG_NORMAL, 192, 'icon-192.png');
await emit(SVG_NORMAL, 512, 'icon-512.png');
await emit(SVG_MASK,   512, 'icon-maskable-512.png');
console.log('\nAll icons written to shared/assets/');
