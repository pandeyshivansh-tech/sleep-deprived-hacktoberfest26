import { useEffect, useRef } from 'react';

// A quiet halftone field behind the app: a grid of dots whose size drifts slowly
// with 3D gradient noise, and swells a little near the pointer. A trimmed port of
// kokonutui's Dot Field (MIT, @dorianbaffier, https://kokonutui.com): the spring
// "membrane" physics and click shockwaves are left out on purpose, so the field
// stays a background and not a toy. It pauses when the tab is hidden and draws a
// single still frame under prefers-reduced-motion.

const SPACING = 22;
const NOISE_SCALE = 260;
const NOISE_SPEED = 0.05;
const TONE_STEP = 3; // noise is sampled on every third dot and blended between
const FRAME_MS = 40; // about 25 frames a second is plenty for a slow drift
const BUCKETS = 8;
const POINTER_RADIUS = 150;

function createNoise(seed) {
  const p = Array.from({ length: 256 }, (_, i) => i);
  let state = seed >>> 0 || 1;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = 255; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i += 1) perm[i] = p[i & 255];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  const grad = (hash, x, y, z) => {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    let v = z;
    if (h < 4) v = y;
    else if (h === 12 || h === 14) v = x;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  };
  return (x, y, z) => {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);
    const fz = z - Math.floor(z);
    const u = fade(fx);
    const v = fade(fy);
    const w = fade(fz);
    const A = perm[X] + Y;
    const AA = perm[A] + Z;
    const AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y;
    const BA = perm[B] + Z;
    const BB = perm[B + 1] + Z;
    return lerp(
      lerp(lerp(grad(perm[AA], fx, fy, fz), grad(perm[BA], fx - 1, fy, fz), u), lerp(grad(perm[AB], fx, fy - 1, fz), grad(perm[BB], fx - 1, fy - 1, fz), u), v),
      lerp(lerp(grad(perm[AA + 1], fx, fy, fz - 1), grad(perm[BA + 1], fx - 1, fy, fz - 1), u), lerp(grad(perm[AB + 1], fx, fy - 1, fz - 1), grad(perm[BB + 1], fx - 1, fy - 1, fz - 1), u), v),
      w,
    );
  };
}

export default function DotField({ seed = 7 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const noise = createNoise(seed);
    const pointer = { x: -9999, y: -9999 };
    let width = 0;
    let height = 0;
    let cols = 0;
    let rows = 0;
    let raf = 0;
    let last = 0;
    let time = 0;
    let color = 'rgb(233, 234, 230)';

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(width / SPACING) + 2;
      rows = Math.ceil(height / SPACING) + 2;
      color = getComputedStyle(canvas).color;
    };

    const draw = () => {
      const z = time * NOISE_SPEED;
      const coarseCols = Math.ceil(cols / TONE_STEP) + 2;
      const coarseRows = Math.ceil(rows / TONE_STEP) + 2;
      const coarse = new Float32Array(coarseCols * coarseRows);
      for (let j = 0; j < coarseRows; j += 1) {
        for (let i = 0; i < coarseCols; i += 1) {
          const nx = (i * TONE_STEP * SPACING) / NOISE_SCALE;
          const ny = (j * TONE_STEP * SPACING) / NOISE_SCALE;
          const n = noise(nx, ny, z) * 0.75 + noise(nx * 2.1 + 9.3, ny * 2.1 + 3.7, z * 1.3) * 0.25;
          coarse[j * coarseCols + i] = Math.min(1, Math.max(0, 0.5 + n * 1.1));
        }
      }
      const maxRadius = SPACING * 0.34;
      const paths = Array.from({ length: BUCKETS }, () => new Path2D());
      const used = new Uint8Array(BUCKETS);
      for (let j = 0; j < rows; j += 1) {
        const cj = Math.floor(j / TONE_STEP);
        const fy = j / TONE_STEP - cj;
        for (let i = 0; i < cols; i += 1) {
          const ci = Math.floor(i / TONE_STEP);
          const fx = i / TONE_STEP - ci;
          const a = cj * coarseCols + ci;
          const top = coarse[a] + (coarse[a + 1] - coarse[a]) * fx;
          const bottom = coarse[a + coarseCols] + (coarse[a + coarseCols + 1] - coarse[a + coarseCols]) * fx;
          let amount = 0.1 + 0.62 * (top + (bottom - top) * fy);
          const x = i * SPACING;
          const y = j * SPACING;
          const d = Math.hypot(x - pointer.x, y - pointer.y);
          if (d < POINTER_RADIUS) amount += 0.5 * (1 - d / POINTER_RADIUS) ** 2;
          const bucket = Math.round(Math.min(1, amount) * (BUCKETS - 1));
          if (bucket === 0) continue;
          const r = (maxRadius * bucket) / (BUCKETS - 1);
          paths[bucket].moveTo(x + r, y);
          paths[bucket].arc(x, y, r, 0, Math.PI * 2);
          used[bucket] = 1;
        }
      }
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      for (let b = 1; b < BUCKETS; b += 1) {
        if (!used[b]) continue;
        ctx.globalAlpha = 0.18 + (0.3 * b) / (BUCKETS - 1);
        ctx.fill(paths[b]);
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      if (now - last < FRAME_MS) return;
      time += last ? Math.min((now - last) / 1000, 0.1) : 0;
      last = now;
      draw();
    };
    const start = () => {
      if (!raf && !reduce && document.visibilityState === 'visible') raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    const onMove = (event) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    };
    const onResize = () => {
      resize();
      draw();
    };

    resize();
    draw();
    start();
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    if (!reduce) window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      stop();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointermove', onMove);
    };
  }, [seed]);

  return <canvas ref={canvasRef} className="dotfield" aria-hidden="true" />;
}
