// Piyano sesi: gerçek piyano kayıtları (sounds/*.mp3, her küçük üçlüde bir örnek)
// en yakın örnek playbackRate ile perdeye çekilir. Örnekler yüklenene kadar basit sentez çalar.

const SAMPLE_NAMES = ['C', 'Ds', 'Fs', 'A'];
const SAMPLE_PC = [0, 3, 6, 9];

export class PianoSound {
  constructor() {
    this.ctx = null;
    this.buffers = new Map(); // midi -> AudioBuffer
    this.loading = null;
  }

  ensure() {
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch { this.ctx = null; }
    if (this.ctx && !this.loading) this.loading = this.load();
    return this.ctx;
  }

  async load() {
    const jobs = [];
    for (let oct = 3; oct <= 7; oct++) {
      SAMPLE_NAMES.forEach((name, i) => {
        const midi = (oct + 1) * 12 + SAMPLE_PC[i];
        if (midi > 96) return;
        jobs.push(
          fetch(`sounds/${name}${oct}.mp3`)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
            .then((buf) => new Promise((res, rej) => this.ctx.decodeAudioData(buf, res, rej)))
            .then((ab) => this.buffers.set(midi, ab))
            .catch(() => {})
        );
      });
    }
    await Promise.all(jobs);
  }

  // duration: saniye (verilirse nota o kadar sonra yumuşakça susar)
  play(midi, { duration = null, volume = 0.9, when = 0 } = {}) {
    if (!this.ensure()) return;
    const t = this.ctx.currentTime + 0.005 + when;
    let best = null;
    for (const m of this.buffers.keys()) if (best === null || Math.abs(m - midi) < Math.abs(best - midi)) best = m;
    if (best === null || Math.abs(best - midi) > 3) return this.synth(midi, t, duration);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.get(best);
    src.playbackRate.value = Math.pow(2, (midi - best) / 12);
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.ctx.destination);
    src.start(t);
    if (duration) {
      const end = t + Math.max(0.15, duration);
      g.gain.setValueAtTime(volume, end);
      g.gain.exponentialRampToValueAtTime(0.0001, end + 0.25);
      src.stop(end + 0.3);
    }
  }

  // Yedek: örnekler yüklenmemişse basit sentez
  synth(midi, t, duration) {
    const ctx = this.ctx;
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const decay = Math.min(duration ? duration + 0.3 : 9, Math.max(0.8, 2.6 - (midi - 48) * 0.035));
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.3, t + 0.006);
    out.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    out.connect(ctx.destination);
    [[1, 1], [2, 0.5], [3, 0.3], [4, 0.15]].forEach(([h, a]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f * h;
      g.gain.value = a;
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + decay + 0.05);
    });
  }
}
