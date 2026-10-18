// Ekran klavyesi giriş kaynağı: klavyeye dokununca nota olayı üretir.
// Piyano başında değilken uygulamayı denemek için kullanışlı.

export class TouchInput {
  constructor() {
    this.onEvent = () => {};
    this.enabled = true;
  }

  press(midi) {
    if (this.enabled) this.onEvent('noteon', { midi, velocity: 0.8 });
  }

  release(midi) {
    if (this.enabled) this.onEvent('noteoff', { midi });
  }
}
