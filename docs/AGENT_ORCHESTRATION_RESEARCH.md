# Benzer proje incelemesi: jcode ve Ruflo (claude-flow)

YuppyCode'un misyon-orkestrasyon tasarımını doğrulamak ve uygulanabilir
fikirleri ayıklamak için incelenen iki açık kaynak proje:
**[1jehuang/jcode](https://github.com/1jehuang/jcode)** (Rust, ~21k yıldız)
ve **[ruvnet/ruflo](https://github.com/ruvnet/ruflo)** (eski adıyla
claude-flow / "ruffle", npm + MCP, ~80k yıldız). İnceleme tarihi: 2026-11-02.

## jcode — çoklu ajan "harness"i

Tek bir sunucu süreci düzineden fazla gerçek kodlama ajanını barındırıyor;
başına CLI'leri sarmalamak yerine kendi TUI'sini yazmışlar. Öne çıkan
sayılar: oturun başına ~3.3 MB ek RAM, ilk girdiye kadar ~19 ms
(karşılaştırma: Claude Code 3.5 sn).

### Bizim için uygulanabilir fikirler

1. **Dosya çakışma bildirimi (en değerli fikir).** jcode'da A ajanı, B
   ajanının okuduğu bir dosyayı düzenlediğinde sunucu B'yi uyarıyor; B
   diff'e bakıp çakışma olup olmadığını kontrol ediyor. Biz çalışan
   CLI'lerin *içini* izleyemediğimiz için aynısını yapamayız; karşılığı
   **claim kanalı**: işçi `yuppy_claim <dosya>` çağırır, bus aynı dosyayı
   isteyen ikinci üyeyi ve lead'i uyarır. Mevcut bus şemasına bir tablo +
   MCP aracıyla eklenir (bus'ta doğal bir "kim neye sahip" kavramı yok).
2. **Aynı depoda sunuculu koordinasyon.** jcode tüm oturumları tek
   sunucuda barındırıp DM / repo-yayını / herkes-yayını kanalları veriyor.
   YuppyCode'un bus'ı (DM + `*` yayını + `lead`) aynı modelin sade hâli;
   mimari doğrulanıyor. Fark: biz oturumları PTY'de *gerçek* CLI olarak
   çalıştırıyoruz, jcode kendi ajan motorunu yazıyor.
3. **Koordinatörün kendi ekibini kurması.** jcode'da ana ajan swarm aracıyla
   kendi işçilerini doğurup koordinatöre dönüşüyor. Bizde bu rolü TUI
   conductor'ı + lead yapıyor; kullanıcının komutu zaten mission'a döndüğü
   için ayrıca "ajanın ajan doğurması"na şu an gerek yok.

## Ruflo (claude-flow) — MCP tabanlı meta-harness

`npx ruflo init` ile Claude Code'un içine MCP sunucusu, hook'lar, sürü
koordinasyonu, vektör bellek ve "misyon" kavramı enjekte ediyor. 314 MCP
aracı, 100+ hazır ajan, konsol (cockpit), federasyon.

### Bizim için uygulanabilir fikirler

1. **Misyon + durum panosu.** Ruflo'nun Missions/Events/Cost sayfaları,
   bizim MISSION board + `[bus]` akışı + `m1 2/3 reported` durum satırının
   aynı fikri; doğruluyor. Maliyet/token sayacı dışarıdan (PTY'den) güvenilmez
   ölçülür — bilerek yapmıyoruz.
2. **Hook'larla arka plan koordinasyonu** ("init'ten sonra normal
   kullanın, yönlendirmeyi hook yapar"). Bizim `parallel_on` + otomatik
   mission fan-out'u aynı sezgi: kullanıcı hiçbir komut öğrenmiyor.
3. **Görev sonrası otomatik işçiler** (audit, testgaps). Kısa vadede
   karşılığı: mission entegrasyon notuna "eksik kalan dilim" tespiti
   eklemek; planlama sezgilerimiz test rolünü zaten hedefe göre seçiyor.
4. **Yapmamayacaklar:** 314 araçlık yüzey, npm bağımlılık yığını, makine
   federasyonu. YuppyCode'un avantajı iki gerçek CLI + tek SQLite bus +
   beş `yuppy_*` aracıyla dar kalması.

## Öncelik sırası (uygulanacaklar)

| # | Fikir | Kaynak | Maliyet | Durum |
|---|-------|--------|---------|-------|
| 1 | Görev bazlı rol dilimleri (aynı prompt kopyası değil) | jcode/Ruflo ayrımı | — | **yapıldı** (`mission.rs`) |
| 2 | Lead kimliği + bus üzerinden rapor + entegrasyon notu | Ruflo missions | — | **yapıldı** (`open_lead`, `MissionWatch`) |
| 3 | `yuppy_claim <dosya>`: dosya sahipliği / çakışma uyarısı | jcode swarm | bus tablosu + 1 MCP aracı | öneri |
| 4 | Mission geçmişi (`yuppy mission history`) — plan + rapor arşivi | Ruflo memory | bus sorgusu | öneri |
| 5 | Entegrasyon notunda "sessiz rol" tespiti → yeniden dispatch | Ruflo workers | app.rs | **yapıldı** (kısmî) |
