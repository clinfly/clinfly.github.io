// Web MIDI giriş kaynağı (USB/Bluetooth MIDI klavye için).
// Not: iPhone Safari şu an Web MIDI desteklemiyor; Chrome/Edge (masaüstü/Android) destekler.
// Oyun bu kaynağı mikrofonla aynı şekilde kullanır, ek kod gerekmez.

export class MidiInput {
  constructor() {
    this.onEvent = () => {};
    this.access = null;
  }

  static get supported() {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  async start() {
    if (!MidiInput.supported) throw new Error('Bu tarayıcı Web MIDI desteklemiyor.');
    this.access = await navigator.requestMIDIAccess();
    const bind = () => {
      for (const input of this.access.inputs.values()) {
        input.onmidimessage = (msg) => this.handle(msg.data);
      }
    };
    bind();
    this.access.onstatechange = bind;
    return [...this.access.inputs.values()].map((i) => i.name);
  }

  handle([status, note, velocity]) {
    const cmd = status & 0xf0;
    if (cmd === 0x90 && velocity > 0) this.onEvent('noteon', { midi: note, velocity: velocity / 127 });
    else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) this.onEvent('noteoff', { midi: note });
  }

  stop() {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) input.onmidimessage = null;
    this.access = null;
  }
}
