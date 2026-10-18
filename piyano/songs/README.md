# Şarkılar

Bu klasöre `.mid` dosyaları koy. Uygulama Interstellar için şu dosyayı arar:

    songs/interstellar.mid

Dosya yoksa uygulama "MIDI dosyasını yükle" butonu gösterir; telefondan seçilen dosya o cihazda saklanır.

İpucu: İki ayrı izi (track) olan piyano MIDI'leri en iyi sonucu verir. İz adında "Right/Sağ/RH" ve
"Left/Sol/LH" geçiyorsa eller buna göre atanır; yoksa perdesi yüksek olan iz sağ el kabul edilir.
Tek izli dosyada orta C (C4) ve üstü sağ el, altı sol el sayılır.

Yeni şarkı eklemek için `js/song.js` içindeki `LIBRARY` listesine bir satır ekle.
