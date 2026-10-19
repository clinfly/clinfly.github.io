// Nota yardımcıları: MIDI numarası <-> isim <-> frekans
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Klavye aralığı: C3 (48) – C7 (96)
export const LOW_MIDI = 48;
export const HIGH_MIDI = 96;

export const isBlack = (midi) => [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
export const pitchClass = (midi) => NOTE_NAMES[((midi % 12) + 12) % 12];
export const octave = (midi) => Math.floor(midi / 12) - 1;
export const midiToName = (midi) => pitchClass(midi) + octave(midi);
export const midiToFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
export const freqToMidiFloat = (freq) => 69 + 12 * Math.log2(freq / 440);

// Görünen nota adı: 'letter' (C D E) veya 'solfege' (Do Re Mi)
const SOLFEGE = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
let labelStyle = 'letter';
export const setLabelStyle = (s) => { labelStyle = s === 'solfege' ? 'solfege' : 'letter'; };
export const noteLabel = (midi) => (labelStyle === 'solfege' ? SOLFEGE : NOTE_NAMES)[((midi % 12) + 12) % 12];
export const noteLabelOct = (midi) => noteLabel(midi) + octave(midi);
