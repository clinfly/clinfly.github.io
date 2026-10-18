// Giriş katmanı: oyunun geri kalanı nota olaylarının nereden geldiğini bilmez.
// Her kaynak (mikrofon, Web MIDI, ekran klavyesi) aynı olayları yayar:
//   'noteon'  -> { midi, velocity, source, freq? }
//   'noteoff' -> { midi, source }
//   'pitch'   -> { freq, midi, cents, clarity, rms } (sadece mikrofon, akort ekranı için)
//   'level'   -> { rms } (mikrofon seviye göstergesi için)

export class InputManager extends EventTarget {
  constructor() {
    super();
    this.sources = new Map();
  }

  add(name, source) {
    source.onEvent = (type, detail) => this.emit(type, { ...detail, source: name });
    this.sources.set(name, source);
    return source;
  }

  get(name) {
    return this.sources.get(name);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, fn) {
    const h = (e) => fn(e.detail);
    this.addEventListener(type, h);
    return () => this.removeEventListener(type, h);
  }
}
