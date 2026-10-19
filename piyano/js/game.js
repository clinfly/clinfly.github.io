// Oyun mantığı: zaman akışı, bekleme modu, doğru/yanlış değerlendirme ve skor.
// Çizimden ve giriş kaynağından bağımsızdır.

const HIT_WINDOW = 0.3;     // sn (şarkı zamanı): notanın çizgiye bu kadar yakınken basılması kabul
const GROUP_EPS = 0.06;     // aynı anda başlayan notalar (akor) bir grup sayılır

export class Game {
  // opts: { hands: 'R' | 'L' | 'both', speed: 0.5 | 0.75 | 1, wait: boolean, octaveTolerant: boolean }
  constructor(song, opts) {
    this.song = song;
    this.opts = opts;
    this.notes = song.notes.map((n) => ({
      ...n,
      state: 'pending', // 'pending' | 'hit' | 'missed'
      required: !opts.listen && (opts.hands === 'both' || n.hand === opts.hands),
      demo: !!opts.listen,
    }));
    this.required = this.notes.filter((n) => n.required);
    this.songTime = 0;
    this.realTime = 0;
    this.waiting = false;
    this.waitGroup = [];
    this.paused = false;
    this.finished = false;
    this.wrong = 0;
    this.hits = []; // { expected (şarkı sn), actual (gerçek sn) }
    this.nextIdx = 0; // ilk bekleyen zorunlu notanın indeksi (required dizisinde)
    this.streak = 0;    // art arda doğru nota sayısı
    this.maxStreak = 0;
    this.loop = null;   // { a, b } şarkı saniyesi: bölüm tekrarı
    this.loopCount = 0;
    this.lastJudge = null; // son basışın değerlendirmesi (ekranda kısa yazı)

    // Adımlar: aynı anda çalınacak zorunlu notalar bir adım (tek nota veya akor)
    this.steps = [];
    for (const n of this.required) {
      const last = this.steps[this.steps.length - 1];
      if (last && n.time - last.time < GROUP_EPS) last.notes.push(n);
      else this.steps.push({ time: n.time, notes: [n] });
    }
    this.steps.forEach((st, i) => st.notes.forEach((n) => { n.step = i; }));
  }

  // İlk tamamlanmamış adımın indeksi
  currentStep() {
    const next = this.advancePointer();
    return next ? next.step : this.steps.length;
  }

  get progress() {
    return Math.min(1, this.songTime / this.song.duration);
  }

  advancePointer() {
    while (this.nextIdx < this.required.length && this.required[this.nextIdx].state !== 'pending') this.nextIdx++;
    return this.required[this.nextIdx];
  }

  update(dt) {
    if (this.paused || this.finished) return;
    this.realTime += dt;
    const target = this.songTime + dt * this.opts.speed;
    let next = this.advancePointer();

    // Bölüm tekrarı: B noktasına gelince A'ya dön
    if (this.loop && target >= this.loop.b && (!next || next.time >= this.loop.b)) {
      this.seek(this.loop.a);
      this.loopCount++;
      return;
    }

    if (this.opts.wait && next && target >= next.time) {
      // Bekleme modu: nota çizgiye geldi, doğru tuş basılana kadar dur
      this.songTime = next.time;
      this.waiting = true;
      this.waitGroup = this.required.filter((n) => n.state === 'pending' && n.time <= next.time + GROUP_EPS);
    } else {
      this.songTime = target;
      this.waiting = false;
      this.waitGroup = [];
      if (!this.opts.wait) {
        for (let i = this.nextIdx; i < this.required.length; i++) {
          const n = this.required[i];
          if (n.time > this.songTime - HIT_WINDOW) break;
          if (n.state === 'pending') { n.state = 'missed'; this.streak = 0; }
        }
      }
    }
    if (!this.advancePointer() && this.songTime >= this.song.duration) this.finished = true;
  }

  // Şu an çalınması beklenen notalar (klavyede ipucu olarak gösterilir)
  expectedNotes() {
    if (this.waiting) return this.waitGroup;
    return this.required.filter(
      (n) => n.state === 'pending' && Math.abs(n.time - this.songTime) <= HIT_WINDOW
    );
  }

  // Şarkıda belirli bir zamana atla (ileri/geri sarma).
  // Atlanan notalar skora sayılmaz; geri sarınca o kısım yeniden çalınabilir.
  seek(t) {
    t = Math.max(0, Math.min(this.song.duration, t));
    for (const n of this.notes) {
      if (n.time >= t - 0.01) n.state = 'pending';
      else if (n.state === 'pending') n.state = 'skipped';
    }
    this.hits = this.hits.filter((h) => h.expected < t - 0.01);
    this.songTime = t;
    this.nextIdx = 0;
    this.waiting = false;
    this.waitGroup = [];
    this.finished = false;
    this.seeked = true;
  }

  // Bir tuşa basıldı. Dönüş: 'correct' | 'wrong' | 'free'
  // secondary: akorda ikinci/üçüncü algılanan nota (eşleşmezse ceza verilmez)
  noteOn(midi, secondary = false) {
    if (this.paused || this.finished) return 'free';
    const matches = (n) =>
      n.midi === midi || (this.opts.octaveTolerant && (n.midi - midi) % 12 === 0);

    const window = this.waiting
      ? this.waitGroup.filter((n) => n.state === 'pending')
      : this.required.filter((n) => n.state === 'pending' && Math.abs(n.time - this.songTime) <= HIT_WINDOW);

    const candidates = window.filter(matches);
    if (candidates.length) {
      candidates.sort((a, b) => Math.abs(a.time - this.songTime) - Math.abs(b.time - this.songTime));
      const n = candidates[0];
      n.state = 'hit';
      this.hits.push({ expected: n.time, actual: this.realTime });
      this.streak++;
      this.maxStreak = Math.max(this.maxStreak, this.streak);
      // Zamanlama: bekleme modunda ritim aranmaz
      const off = this.songTime - n.time; // + geç, - erken
      let label = 'Doğru!';
      if (!this.waiting && !secondary) {
        if (Math.abs(off) < 0.09) label = 'Harika!';
        else if (Math.abs(off) < 0.18) label = 'İyi';
        else label = off > 0 ? 'Geç' : 'Erken';
      }
      if (!secondary) this.lastJudge = { label, kind: 'correct', midi: n.midi, at: performance.now() };
      return 'correct';
    }
    if (window.length && !secondary) {
      this.wrong++;
      this.streak = 0;
      this.lastJudge = { label: 'Yanlış', kind: 'wrong', midi, at: performance.now() };
      return 'wrong';
    }
    return 'free'; // beklenen bir nota yokken basıldı: ceza yok
  }

  results() {
    const total = this.required.filter((n) => n.state !== 'skipped').length;
    const hit = this.required.filter((n) => n.state === 'hit').length;
    const accuracy = total + this.wrong ? (hit / (total + this.wrong)) * 100 : 0;

    // Ritim: ardışık vuruşlar arasındaki süreyi beklenen süreyle karşılaştır.
    // Akorlar tek vuruş sayılır (aynı beklenen zaman).
    const groups = [];
    for (const h of [...this.hits].sort((a, b) => a.expected - b.expected)) {
      const last = groups[groups.length - 1];
      if (last && h.expected - last.expected < GROUP_EPS) continue;
      groups.push(h);
    }
    let sum = 0, count = 0;
    for (let i = 1; i < groups.length; i++) {
      const exp = (groups[i].expected - groups[i - 1].expected) / this.opts.speed;
      const act = groups[i].actual - groups[i - 1].actual;
      if (exp > 4) continue; // uzun duraklamalar ritmi bozmasın
      sum += Math.max(0, 1 - Math.abs(act - exp) / Math.max(exp, 0.3));
      count++;
    }
    const rhythm = count ? (sum / count) * 100 : hit ? 100 : 0;

    return {
      accuracy: Math.round(accuracy),
      rhythm: Math.round(rhythm),
      seconds: Math.round(this.realTime),
      hit,
      total,
      wrong: this.wrong,
      maxStreak: this.maxStreak,
      missed: this.required.filter((n) => n.state === 'missed').length,
    };
  }
}
