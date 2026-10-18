// YIN perde (pitch) algılama algoritması
// de Cheveigné & Kawahara, 2002. Tek sesli (monofonik) sinyal için.
//
// buffer: Float32Array zaman alanı örnekleri
// sampleRate: örnekleme hızı (Hz)
// opts.minFreq / maxFreq: aranacak frekans aralığı
// opts.threshold: mutlak eşik (düşük = daha seçici), tipik 0.10–0.20
//
// Dönüş: { freq, clarity } (clarity 0..1, yüksek = daha güvenilir) veya null

export function createYin(sampleRate, opts = {}) {
  const minFreq = opts.minFreq ?? 110;   // C3 (130.8 Hz) altında biraz pay
  const maxFreq = opts.maxFreq ?? 2300;  // C7 (2093 Hz) üstünde biraz pay
  const threshold = opts.threshold ?? 0.15;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  const tauMax = Math.ceil(sampleRate / minFreq);
  const diff = new Float32Array(tauMax + 2);

  return function detect(buffer) {
    // Entegrasyon penceresi: kalan örneklerin tamamı (tauMax kadar boşluk bırak)
    const W = Math.min(1024, buffer.length - tauMax - 2);
    if (W < 256) return null;

    // 1) Fark fonksiyonu d(tau)
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let sum = 0;
      for (let i = 0; i < W; i++) {
        const d = buffer[i] - buffer[i + tau];
        sum += d * d;
      }
      diff[tau] = sum;
    }

    // 2) Kümülatif ortalama ile normalize edilmiş fark (CMND)
    diff[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      running += diff[tau];
      diff[tau] = running === 0 ? 1 : (diff[tau] * tau) / running;
    }

    // 3) Mutlak eşiğin altındaki ilk yerel minimum
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (diff[t] < threshold) {
        while (t + 1 <= tauMax && diff[t + 1] < diff[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau === -1) return null;

    // 4) Parabolik interpolasyon ile hassas periyot
    const x0 = diff[tau - 1], x1 = diff[tau], x2 = diff[tau + 1];
    const denom = x0 + x2 - 2 * x1;
    const betterTau = denom !== 0 ? tau + (x0 - x2) / (2 * denom) : tau;

    return { freq: sampleRate / betterTau, clarity: 1 - x1 };
  };
}
