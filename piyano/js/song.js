// Şarkı yükleme: .mid dosyasını @tonejs/midi ile çözer ve oyunun kullandığı
// basit nota listesine çevirir: { midi, time, duration, hand: 'R' | 'L' }

/* global Midi */
import { LOW_MIDI, HIGH_MIDI } from './notes.js';

export const LIBRARY = [
  {
    id: 'interstellar',
    title: 'Interstellar – Main Theme',
    artist: 'Hans Zimmer',
    url: 'songs/interstellar.mid',
  },
];

const STORE_PREFIX = 'piano.song.';

export async function loadSong(entry) {
  // 1) Önce kullanıcının yüklediği dosya (cihazda saklanır)
  const stored = loadStored(entry.id);
  if (stored) return parseMidi(stored, entry);
  // 2) Sonra songs/ klasöründeki dosya
  try {
    const res = await fetch(entry.url, { cache: 'no-cache' });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      if (looksLikeMidi(buf)) return parseMidi(buf, entry);
    }
  } catch { /* çevrimdışı veya dosya yok */ }
  return null; // arayüz "MIDI dosyasını yükle" butonunu gösterir
}

export async function importSongFile(entry, file) {
  const buf = await file.arrayBuffer();
  if (!looksLikeMidi(buf)) throw new Error('Bu bir MIDI (.mid) dosyası değil.');
  const song = parseMidi(buf, entry); // önce çözülebildiğinden emin ol
  try { localStorage.setItem(STORE_PREFIX + entry.id, toBase64(buf)); } catch { /* yer yoksa sadece bu oturum */ }
  return song;
}

export function forgetStored(entry) {
  try { localStorage.removeItem(STORE_PREFIX + entry.id); } catch { /* yok say */ }
}

function loadStored(id) {
  try {
    const b64 = localStorage.getItem(STORE_PREFIX + id);
    return b64 ? fromBase64(b64) : null;
  } catch { return null; }
}

function looksLikeMidi(buf) {
  const h = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  return String.fromCharCode(...h) === 'MThd';
}

// Hangi iz (track) hangi el? Önce iz isimlerine bak, sonra iz sırasına, en son perdeye.
function assignHands(tracks) {
  const withNotes = tracks.filter((t) => t.notes.length);
  const byName = (re) => withNotes.find((t) => re.test(t.name || ''));
  let right = byName(/right|sağ|sag|\brh\b|treble|upper/i);
  let left = byName(/left|sol|\blh\b|bass|lower/i);
  if (!right && !left && withNotes.length >= 2) {
    // Ortalama perdesi yüksek olan iz sağ el
    const avg = (t) => t.notes.reduce((s, n) => s + n.midi, 0) / t.notes.length;
    const sorted = [...withNotes].sort((a, b) => avg(b) - avg(a));
    right = sorted[0];
    left = sorted[1];
  }
  return { right, left, withNotes };
}

export function parseMidi(buf, entry) {
  const midi = new Midi(buf);
  const { right, left, withNotes } = assignHands(midi.tracks);
  const notes = [];
  for (const track of withNotes) {
    for (const n of track.notes) {
      let hand;
      if (track === right) hand = 'R';
      else if (track === left) hand = 'L';
      else hand = n.midi >= 60 ? 'R' : 'L'; // tek iz: orta C'ye göre böl
      // Klavye aralığı (C3–C7) dışındaki notaları oktav kaydırarak içeri al
      let m = n.midi;
      while (m < LOW_MIDI) m += 12;
      while (m > HIGH_MIDI) m -= 12;
      notes.push({ midi: m, time: n.time, duration: Math.max(0.08, n.duration), hand });
    }
  }
  notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
  // Baştaki sessizliği kırp ama 2 sn hazırlık payı bırak
  const first = notes.length ? notes[0].time : 0;
  const shift = 2 - first;
  notes.forEach((n, i) => { n.time += shift; n.id = i; });
  const end = notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0);
  return { ...entry, notes, duration: end + 1, bpm: midi.header.tempos[0]?.bpm ?? 120 };
}

function toBase64(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}
