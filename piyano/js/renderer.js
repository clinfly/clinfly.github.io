// Çizim: düşen nota çubukları + yatay kaydırılabilir piyano klavyesi (tek canvas).
// Canvas görünür alanda sabit durur (position: sticky); içindeki "spacer" klavyenin
// tam genişliğini verir, kaydırma miktarı scrollLeft'ten okunur.

import { LOW_MIDI, HIGH_MIDI, isBlack, pitchClass, midiToName } from './notes.js';

export const COLORS = {
  bg: '#0d1017',
  lane: 'rgba(255,255,255,0.035)',
  laneLine: 'rgba(255,255,255,0.07)',
  right: '#4ea8ff',
  rightDark: '#2366b8',
  left: '#ff9f43',
  leftDark: '#b8641c',
  other: 'rgba(160,170,190,0.28)',
  hit: '#2ee59d',
  wrong: '#ff4d5e',
  hitLine: '#e8ecf5',
  whiteKey: '#f4f5f8',
  whiteKeyShade: '#d7dae2',
  blackKey: '#1b1e26',
  label: '#59606f',
};

const LOOKAHEAD = 3; // ekranın üstünden çizgiye kadar kaç saniyelik nota görünsün

export class Renderer {
  constructor(scroller, canvas, spacer) {
    this.scroller = scroller;
    this.canvas = canvas;
    this.spacer = spacer;
    this.ctx = canvas.getContext('2d');
    this.keyFlash = new Map(); // midi -> { kind: 'correct'|'wrong'|'neutral', until }
    this.held = new Map();     // midi -> kind (basılı tutulan tuş)
    this.resize();
  }

  resize() {
    const w = this.scroller.clientWidth;
    const h = this.scroller.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';

    // Beyaz tuş genişliği: telefonda yatayda ~2 oktav görünsün
    const whiteCount = this.countWhites();
    this.whiteW = Math.max(36, Math.min(64, w / 15));
    if (this.whiteW * whiteCount < w) this.whiteW = w / whiteCount; // geniş ekranda tamamı sığsın
    this.totalW = this.whiteW * whiteCount;
    this.spacer.style.width = this.totalW + 'px';

    this.keyH = Math.max(100, Math.min(190, h * 0.32));
    this.hitY = h - this.keyH;
    this.pxPerSec = (this.hitY - 10) / LOOKAHEAD;
    this.buildKeys();
  }

  countWhites() {
    let c = 0;
    for (let m = LOW_MIDI; m <= HIGH_MIDI; m++) if (!isBlack(m)) c++;
    return c;
  }

  buildKeys() {
    this.keys = new Map();
    let wi = 0;
    for (let m = LOW_MIDI; m <= HIGH_MIDI; m++) {
      if (isBlack(m)) {
        const bw = this.whiteW * 0.6;
        this.keys.set(m, { x: wi * this.whiteW - bw / 2, w: bw, black: true });
      } else {
        this.keys.set(m, { x: wi * this.whiteW, w: this.whiteW, black: false });
        wi++;
      }
    }
  }

  // Ekran koordinatından (canvas içi x,y) tuşu bul
  keyAt(x, y) {
    if (y < this.hitY) return null;
    const ax = x + this.scroller.scrollLeft;
    const blackBottom = this.hitY + this.keyH * 0.62;
    if (y < blackBottom) {
      for (const [m, k] of this.keys) if (k.black && ax >= k.x && ax <= k.x + k.w) return m;
    }
    for (const [m, k] of this.keys) if (!k.black && ax >= k.x && ax < k.x + k.w) return m;
    return null;
  }

  flash(midi, kind, ms = 450) {
    this.keyFlash.set(midi, { kind, until: performance.now() + ms });
  }

  // Bir notayı görünür alana getir (yumuşak kaydırma)
  ensureVisible(midis) {
    if (!midis.length) return;
    let lo = Infinity, hi = -Infinity;
    for (const m of midis) {
      const k = this.keys.get(m);
      if (!k) continue;
      lo = Math.min(lo, k.x);
      hi = Math.max(hi, k.x + k.w);
    }
    const left = this.scroller.scrollLeft;
    const margin = this.whiteW * 1.5;
    let target = null;
    if (lo < left + margin) target = lo - margin;
    else if (hi > left + this.w - margin) target = hi - this.w + margin;
    if (target !== null) {
      target = Math.max(0, Math.min(this.totalW - this.w, target));
      this.scroller.scrollLeft += (target - left) * 0.12;
    }
  }

  centerOn(midi) {
    const k = this.keys.get(midi);
    if (k) this.scroller.scrollLeft = Math.max(0, k.x - this.w / 2);
  }

  // state: { notes, songTime, expected (Set<midi>), expectedHand (Map<midi,hand>), waiting }
  draw(state = {}) {
    const { ctx, dpr } = this;
    const now = performance.now();
    const sx = this.scroller.scrollLeft;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.save();
    ctx.translate(-sx, 0);

    this.drawLanes(sx);
    if (state.notes) this.drawNotes(state, sx);
    this.drawHitLine(sx, state.waiting);
    this.drawKeyboard(state, now, sx);
    ctx.restore();
  }

  drawLanes(sx) {
    const { ctx } = this;
    for (const [m, k] of this.keys) {
      if (k.x + k.w < sx || k.x > sx + this.w) continue;
      if (k.black) {
        ctx.fillStyle = COLORS.lane;
        ctx.fillRect(k.x, 0, k.w, this.hitY);
      }
      const pc = m % 12;
      if (pc === 0 || pc === 5) {
        ctx.fillStyle = COLORS.laneLine;
        ctx.fillRect(k.x, 0, 1, this.hitY);
      }
    }
  }

  drawNotes({ notes, songTime, order }, sx) {
    const { ctx } = this;
    const topTime = songTime + (this.hitY / this.pxPerSec);
    ctx.font = `600 ${Math.max(10, Math.min(14, this.whiteW * 0.28))}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const badges = [];
    for (const n of notes) {
      if (n.time > topTime) break; // notalar zamana göre sıralı
      if (n.time + n.duration < songTime - 1) continue;
      const k = this.keys.get(n.midi);
      if (!k || k.x + k.w < sx || k.x > sx + this.w) continue;

      const yBottom = this.hitY - (n.time - songTime) * this.pxPerSec;
      const len = Math.max(14, n.duration * this.pxPerSec - 2);
      const yTop = yBottom - len;
      if (yTop > this.hitY) continue;
      const pad = k.black ? 1 : 3;
      const x = k.x + pad, w = k.w - pad * 2;

      let fill, edge;
      if (n.state === 'hit') { fill = COLORS.hit; edge = '#17a86f'; }
      else if (n.state === 'missed') { fill = COLORS.wrong; edge = '#a8202e'; }
      else if (!n.required) { fill = COLORS.other; edge = 'rgba(255,255,255,0.12)'; }
      else if (n.hand === 'R') { fill = COLORS.right; edge = COLORS.rightDark; }
      else { fill = COLORS.left; edge = COLORS.leftDark; }

      const clipBottom = Math.min(yBottom, this.hitY);
      const hgt = clipBottom - yTop;
      if (hgt <= 0) continue;
      roundRect(ctx, x, yTop, w, hgt, Math.min(6, w / 3));
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = edge;
      ctx.stroke();

      if (hgt > 16 && w > 14) {
        ctx.fillStyle = n.required && n.state === 'pending' ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.6)';
        ctx.fillText(pitchClass(n.midi), x + w / 2, clipBottom - 3);
      }
      if (order?.has(n.id)) badges.push([x + w / 2, yTop, w, order.get(n.id)]);
    }
    this.drawBadges(badges);
  }

  // Sıra numaraları en üstte çizilir (üst üste gelen tekrar notalarda kaybolmasın)
  drawBadges(badges) {
    const { ctx } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [cx, yTop, w, num] of badges) {
      const r = Math.max(8, Math.min(11, w * 0.32));
      const cy = Math.max(r + 2, yTop - r - 3);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = num === 1 ? '#ffd65a' : 'rgba(232,236,245,0.92)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0d1017';
      ctx.stroke();
      ctx.fillStyle = '#0d1017';
      ctx.fillText(String(num), cx, cy + 0.5);
    }
    ctx.textBaseline = 'bottom';
  }

  drawHitLine(sx, waiting) {
    const { ctx } = this;
    const grad = ctx.createLinearGradient(0, this.hitY - 14, 0, this.hitY);
    const glow = waiting ? 'rgba(255,214,90,0.35)' : 'rgba(120,170,255,0.18)';
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, glow);
    ctx.fillStyle = grad;
    ctx.fillRect(sx, this.hitY - 14, this.w, 14);
    ctx.fillStyle = waiting ? '#ffd65a' : COLORS.hitLine;
    ctx.fillRect(sx, this.hitY - 2, this.w, 2);
  }

  keyColor(midi, now, state) {
    const f = this.keyFlash.get(midi);
    const held = this.held.get(midi);
    const kind = held || (f && f.until > now ? f.kind : null);
    if (kind === 'correct') return COLORS.hit;
    if (kind === 'wrong') return COLORS.wrong;
    if (kind === 'neutral') return '#8fb8ff';
    return null;
  }

  // Basılması beklenen tuş: dolu renk yerine el renginde çerçeve (basılan tuşla karışmasın)
  expectedColor(midi, state) {
    if (!state.expectedHand?.has(midi)) return null;
    return state.expectedHand.get(midi) === 'R' ? COLORS.right : COLORS.left;
  }

  outline(x, y, w, h, color) {
    const { ctx } = this;
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.setLineDash([6, 4]);
    roundRect(ctx, x + 2.5, y + 2.5, w - 5, h - 5, 4);
    ctx.stroke();
    ctx.restore();
  }

  drawKeyboard(state, now, sx) {
    const { ctx } = this;
    const y = this.hitY;
    const H = this.keyH;
    const bH = H * 0.62;

    // Beyaz tuşlar
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const [m, k] of this.keys) {
      if (k.black || k.x + k.w < sx || k.x > sx + this.w) continue;
      const c = this.keyColor(m, now, state);
      const ex = c ? null : this.expectedColor(m, state);
      ctx.fillStyle = c || COLORS.whiteKey;
      ctx.fillRect(k.x + 1, y, k.w - 2, H - 2);
      if (ex) this.outline(k.x + 1, y, k.w - 2, H - 2, ex);
      ctx.fillStyle = COLORS.whiteKeyShade;
      ctx.fillRect(k.x + 1, y + H - 8, k.w - 2, 6);

      // Nota adı (C tuşlarında oktav numarası da)
      const pc = m % 12;
      ctx.fillStyle = c ? '#0d1017' : ex || COLORS.label;
      ctx.font = `${pc === 0 ? 700 : 600} ${Math.max(10, Math.min(15, k.w * 0.3))}px system-ui, -apple-system, sans-serif`;
      ctx.fillText(pc === 0 ? midiToName(m) : pitchClass(m), k.x + k.w / 2, y + H - 14);
    }

    // Siyah tuşlar
    for (const [m, k] of this.keys) {
      if (!k.black || k.x + k.w < sx || k.x > sx + this.w) continue;
      const c = this.keyColor(m, now, state);
      ctx.fillStyle = c || COLORS.blackKey;
      roundRect(ctx, k.x, y, k.w, bH, 3);
      ctx.fill();
      const ex = c ? null : this.expectedColor(m, state);
      if (ex) this.outline(k.x, y, k.w, bH, ex);
      if (!c) {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(k.x + 3, y + bH - 8, k.w - 6, 4);
      }
      if (k.w > 22) {
        ctx.fillStyle = c ? '#0d1017' : 'rgba(255,255,255,0.45)';
        ctx.font = `600 ${Math.max(8, Math.min(11, k.w * 0.3))}px system-ui, -apple-system, sans-serif`;
        ctx.fillText(pitchClass(m), k.x + k.w / 2, y + bH - 12);
      }
    }

    // Klavye üst gölgesi
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(sx, y, this.w, 3);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
