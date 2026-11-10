// QR transfer: split a message into frames, draw them, and reassemble them from a camera feed.
/* global qrcode, jsQR */

const PREFIX = 'HS1';
const CHUNK = 520; // characters per QR frame — keeps codes at a density iPad cameras read easily
const FRAME_RE = /^HS1\|([a-z0-9]+)\|(\d+)\|(\d+)\|([jz])\|([\s\S]*)$/;

if (typeof qrcode !== 'undefined' && qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs['UTF-8']) {
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const canCompress = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function deflateB64(str) {
  const stream = new Blob([new TextEncoder().encode(str)]).stream().pipeThrough(new CompressionStream('deflate'));
  return bytesToB64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function inflateB64(b64) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack compressed QR data. Update iPadOS / Safari.');
  const stream = new Blob([b64ToBytes(b64)]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Response(stream).text();
}

// obj -> array of frame strings
export async function encodeMessage(obj) {
  const json = JSON.stringify(obj);
  let enc = 'j', payload = json;
  if (canCompress && json.length > 300) {
    try {
      const z = await deflateB64(json);
      if (z.length < json.length * 0.9) { enc = 'z'; payload = z; }
    } catch (e) { /* fall back to plain */ }
  }
  const chars = Array.from(payload);
  const n = Math.max(1, Math.ceil(chars.length / CHUNK));
  const id = Math.random().toString(36).slice(2, 7);
  const frames = [];
  for (let i = 0; i < n; i++) {
    frames.push(`${PREFIX}|${id}|${i + 1}|${n}|${enc}|${chars.slice(i * CHUNK, (i + 1) * CHUNK).join('')}`);
  }
  return frames;
}

// Collects frames (any order, duplicates OK) and calls onMessage(obj) when a message is complete.
export class Assembler {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.parts = new Map();   // id -> {n, enc, chunks: []}
    this.done = new Set();
  }

  reset() { this.parts.clear(); this.done.clear(); }

  async push(text) {
    const m = FRAME_RE.exec(text);
    if (!m) return { status: 'foreign' };
    const [, id, iS, nS, enc, chunk] = m;
    const i = Number(iS), n = Number(nS);
    if (this.done.has(id)) return { status: 'dup', id, have: n, n };
    let p = this.parts.get(id);
    if (!p) { p = { n, enc, chunks: new Array(n).fill(null) }; this.parts.set(id, p); }
    if (i >= 1 && i <= p.n) p.chunks[i - 1] = chunk;
    const have = p.chunks.filter(c => c !== null).length;
    if (have < p.n) return { status: 'partial', id, have, n: p.n, chunks: p.chunks.map(c => c !== null) };
    this.parts.delete(id);
    this.done.add(id);
    const payload = p.chunks.join('');
    const json = p.enc === 'z' ? await inflateB64(payload) : payload;
    const obj = JSON.parse(json);
    await this.onMessage(obj);
    return { status: 'complete', id, have, n: p.n };
  }
}

// Draws text as a QR code onto a canvas (always black on white, with quiet zone).
export function drawQR(canvas, text, maxPx) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const total = count + quiet * 2;
  const scale = Math.max(2, Math.floor(maxPx / total));
  const size = total * scale;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  return { modules: count, size };
}

function decodeBytes(code) {
  try {
    if (code.binaryData && code.binaryData.length) return new TextDecoder('utf-8').decode(new Uint8Array(code.binaryData));
  } catch (e) { /* fall through */ }
  return code.data || '';
}

// Camera scanner using jsQR.
export class Scanner {
  constructor(video, onText) {
    this.video = video;
    this.onText = onText;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.running = false;
    this.last = '';
    this.lastAt = 0;
  }

  static supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
  }

  async start(facing = 'environment') {
    if (!Scanner.supported()) throw new Error('Camera needs HTTPS (or localhost) and a browser with camera support.');
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    const v = this.video;
    v.setAttribute('playsinline', '');
    v.muted = true;
    v.srcObject = this.stream;
    await v.play();
    this.running = true;
    this.loop();
  }

  loop() {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState >= 2 && v.videoWidth) {
      const scale = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
      if (this.canvas.width !== w) { this.canvas.width = w; this.canvas.height = h; }
      this.ctx.drawImage(v, 0, 0, w, h);
      const img = this.ctx.getImageData(0, 0, w, h);
      const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
      if (code) {
        const text = decodeBytes(code);
        const now = Date.now();
        if (text && (text !== this.last || now - this.lastAt > 2000)) {
          this.last = text; this.lastAt = now;
          try { this.onText(text); } catch (e) { console.error(e); }
        }
      }
    }
    this.timer = setTimeout(() => requestAnimationFrame(() => this.loop()), 60);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }
}
