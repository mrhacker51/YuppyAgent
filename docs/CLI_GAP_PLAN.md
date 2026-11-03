# YuppyCode CLI — AgentSpace kıyasıyla boşluk analizi ve inşa planı

**Referans:** `https://muratify.com/products/agentspace` (v0.4.9, 2026-11-01 tarihinde okundu)
**Kod tabanı:** 13 crate, 55 Rust dosyası, ~17.000 satır, 172 test.
**`yuppy` komut yüzeyi bugün:** `run` · `chat` · `bench` · `version` · `agents` · `dept` · `task` · `bridge`

Bu doküman AgentSpace'in ürün omurgasını oluşturan yetenekleri tek tek alır, `yuppy` CLI'ın
onlardan hangisini gerçekten çalıştırdığını kod kanıtıyla yanına koyar ve eksikleri
sıralı, kabul ölçütü olan bir inşa planına çevirir.

---

## 0. E0 — Ajanlar arası iletişim (yapıldı)

Kullanıcı önceliği plandaki epic'lerden önceydi: *paralel ajanlar birbirleriyle
konuşamıyor*. Bu yüzden E0 olarak eklendi ve tamamlandı.

**Teşhis.** Paralel çalışmıyor değildi — `run_batch` görev başına `tokio::spawn`
+ global/departman semaphore'ı ile gerçekten eşzamanlı (4 × 3 s sahte görev
6,1 s'de bitti; görevlerin kendisi 3,0 s). Asıl eksik iki şeydi:

1. `yuppy task` bir partiye **tek motor** veriyordu (`--agent claude|codex`),
   yani "Claude ve Codex aynı anda" CLI'dan hiç mümkün değildi.
2. Fan-out ajanları birbirinden habersizdi: rol prompt'u sadece "başkasının
  işini tekrar yapma" diyordu, kanal yoktu. AjanSpace'in kendi kullanıcı
   şikâyetleriyle aynı boşluk ("ajanlar hâlâ main ajanı dinlemiyor").

**Kurulan.**

| Parça | Ne yapıyor |
|---|---|
| `crates/yuppycode-bus/src/store.rs` | SQLite kasa: üye tablosu, mesaj tablosu, okuma imleci, `wait` ile bloklayan bekleme, silinmiş üyeye mesaj reddi |
| `crates/yuppycode-bus/src/mcp_server.rs` | stdio MCP sunucusu: `yuppy_team`, `yuppy_send`, `yuppy_inbox`, `yuppy_wait`, `yuppy_history` |
| `yuppy mcp-bus` | Bu sunucuyu motor çocuğunun çocuğu olarak kaldırır |
| `yuppycode-agents` | Motor başına bağlantı: Claude `--mcp-config` + `--append-system-prompt`, Codex `-c mcp_servers.yuppy.*` (env dâhil) |
| `yuppy team` | Karışık motorlu ekip, canlı transkript, `--member ada=claude:backend` |
| `yuppy task --agent claude,codex --team` | Aynı partiye motor başına görev + bus |
| `yuppy msg ls/team/send/inbox/brief/clear` | İnsanın da taraf olduğu kanal |
| `/mission` (TUI) | Her rol bus'a `rol-görevno` adıyla bağlanır; trafik TUI günlüğüne akar |

**Kanıt (gerçek CLIs ile).** `claude -p` ile `codex exec` aynı bus üzerinde
konuştu: Claude kelimeyi `yuppy_send(to=nova)` ile gönderdi, Codex `yuppy_wait`
ile aldı, `word.txt` dosyasına baytı bozmadan yazdı (`maple\n`, 6 bayt) ve
Claude'a geri onayladı.

**Testten çıkan üç gerçek hata** (hepsi düzeltildi, testi var):

1. Claude Code araçları tam adıyla (`mcp__yuppy__yuppy_send`) çağırıyor; sunucu
   "unknown tool" diyordu → ad normalizasyonu.
2. `-p` modunda izin sorulacak kimse olmadığı için bus araçları var ama
   kullanılamaz durumdaydı → yalnızca `mcp__yuppy` kapsamı önden izinli
   (kapsam dar, `--no-auto-allow` ile kapatılabilir, çalışma anında basılır).
3. `wait(from=…)` filtresi mesajı **okuyup atıyordu** (kayıp) ve ajan kendi
   broadcast'ini "takım arkadaşından geldi" sayıyordu → `from` yalnızca uyanma
   koşuludur, teslim edilen küme hiç süzülmez; kendi mesajı artık inbox'a düşmez.

**Kalan sınırlar (dürüstçe):** bus tek makine/tek kullanıcı; biten üye
uyandırılmaz; motor kataloğu hâlâ 2 motor (E1), bu yüzden ekip üçüncü bir CLI
ajanı yalnızca elle `yuppy mcp-bus` bağlayarak yakalayabilir.

---

## 1. Referanstan çıkarılan yetenek omurgası

AgentSpace'in kendi sayfasında iddia ettiği her şey, altta yatan mekanizma adıyla birlikte:

| # | Yetenek | Sayfadaki karşılığı |
|---|---------|---------------------|
| A1 | Motor duvarı (BYOA) | 10 çalışan motor + motor-üstü sağlayıcılar + "herhangi bir CLI ajan". Katalog uygulamanın kendi kodundan üretiliyor; sayfa ile kod ayrışınca build kapısı kızarıyor. Motorların lead / worker yetkinlik seviyesi ayrı. |
| A2 | Kalıcı kimlik + hafıza | İsimli, rollü çalışanlar; oturumlar arası hafıza; "kaldığın yerden devam"; elle terfi ettirilen hafıza kuralları. |
| A3 | Görev panosu | `TASK-XXXX` kartları, `WORKING/WAITING` durumları, delegasyon + alt görev sayacı (`2/4 subtasks`), liderin işi bölmesi. |
| A4 | Kanıtlı kapanış | İş, sonuç raporu + delille kapanıyor ("typecheck + build green"). Onaylanan karar lideri anında görüp delegasyon yapıyor. |
| A5 | Otopilot / hands-off | Bir görev bitince sonraki başlar; masaüstü penceresi kapalıyken de ofis kurulmaya devam eder. |
| A6 | Kullanım sayacı + hesaplar | Token, motorun kendi oturum dosyasından okunur; API eşdeğeri fiyat basar; ölçülemeyeni `unpriced` yazar. **Kota yüzdesi barı uydurmaz.** Limitte boşta hesaba geçer, aynı konuşmayı taşır. Giriş durumu motorun kendi `status` komutundan okunur. |
| A7 | Terminal / ofis | Sınırsız split ağacı, sürüklenerek resize, isimli panel (pane başlığı = ajan adı), ofis sprite'ına tıkla → o ajanın terminali, canlı diff izleme. |
| A8 | Entegrasyon merkezi | 8 servis, şifreli kasa, yetenek kartları (servisin gerçek araç listesinden türetilir), dev/prod ortam kapsaması, üç dürüst durum: CONNECTED / SCOPE SHORT / NOT CONNECTED. |
| A9 | Telefon + özel ağ | Bind yalnızca Tailscale adresine; `0.0.0.0` kodda reddedilir; cihaz token'ı, tek tık iptal, kill switch; bekleyen onayları telefondan temizleme; foto/dosya ekleme. |
| A10 | Türkçe + ses | Arayüz Türkçe, sesli komut Türkçe morfolojisi için yazılmış. |

**Kritik gözlem:** A1–A6 bir *ürün omurgası*, A7–A10 bir *arayüz katmanı*. YuppyCode'un A7'de
(hosted PTY oturumları, split, köprü) rakip seviyesinde altyapısı var; omurgada (A1–A6) ise
henüz somut nesne modeli yok. Plan bu yüzden omurgaya öncelik veriyor.

---

## 2. YuppyCode bugün ne yapıyor (kod kanıtı)

| Alan | Gerçek durum | Kanıt |
|------|--------------|-------|
| Motorlar | Yalnızca 2 motor, enum'a gömülü | `crates/yuppycode-agents/src/lib.rs:25-31` (`AgentKind { ClaudeCode, Codex }`, `ALL: [AgentKind; 2]`) |
| Motor seçimi | `--terminal claude\|codex` dışında değer reddedilir | `main.rs` `parse_terminal_kinds` |
| Görev motoru | `yuppy task --agent claude\|codex` | `main.rs` `TaskArgs` |
| Görev nesnesi | Görevler bellek-içi; `TaskId` + durum akışı, kalıcı kart yok | `supervisor.rs` `upsert`, `SharedMeta` |
| Rapor | Raporun son 2000 karakteri bir sonraki prompt'a ekleniyor; diske rapor yazılmıyor | `supervisor.rs:30` `TAIL_CHARS = 2000`, `compose_report_prompt` |
| İzolasyon | `git worktree` + `yuppy/task-<id>` inceleme dalı, çakışan dosyalar raporlanır | `yuppycode-orchestrator/src/isolation.rs`, `supervisor.rs:223-273` |
| Token/maliyet | `chars / 4` sezgisi; oturum başına ledger, fiyat, motor-üstü toplamlar yok | `yuppycode-core/src/lib.rs:40-45` |
| Hesaplar | Yok | — |
| Onay (hosted CLI) | Native Claude/Codex izin istemleri birebir insana geçer; programatik yakalama/köprüden onay yok | `yuppycode-agents/src/lib.rs:87` |
| Onay (orchestrator) | `TaskState::AwaitingApproval` tanımlı ama runner hiç üretmiyor | `docs/PHASE2_REPORT.md:223`, `orchestrator/src/lib.rs:33` |
| Köprü | Loopback varsayılan, token+origin kontrolü, canlı terminal ekranı akışı, dept/layout, `TaskSubmit`/`TaskCancel` **çalışıyor** | `bridge/mod.rs:21-48`, `bridge/handlers.rs:57-58` |
| Uzaktan cihaz | Cihaz kaydı, iptal, kill switch, eşleştirme akışı yok | — |
| Yapılandırma | Yalnızca env + `dirs::config_dir()` altındaki HUD JSON; tek config dosyası yok | `yuppycode-hud/src/store.rs:35` |
| Zorlama | Departman `allowed_tools` ve rol `model`'i saklanıyor ama zamanlayıcı uygulamıyor | `README.md:275`, `hud/src/department.rs:47,108` |
| Kalıcılık | SQLite: workspaces/conversations/messages/audits/preferences — oturum listesini sorgulayan CLI yok | `yuppycode-memory/src/lib.rs:67-104` |
| Süreklilik | Her şey `yuppy` süreciyle doğup ölür; daemon/otopilot/cron yok | — |
| Bildirim | Yok | — |
| Ses / TR | Yok | — |

---

## 3. Boşluk matrisi

`YOK` = hiç yok · `KISMİ` = iskelet var, ürün değil · `VAR` = referansla ölçülebilir seviyede

| Yetenek | AgentSpace | yuppy bugün | Sınıf |
|---|---|---|---|
| Çoklu CLI motor (BYOA) | 10 + kendi motorunu ekle | 2, gömülü enum | **YOK** |
| Motor yetkinlik seviyesi (lead/worker) | var | yok | **YOK** |
| Ajan kimliği / kadro (roster) | isim+rol+motor+kalıcı hafıza | departman içinde satır, kalıcı kimlik yok | **KISMİ** |
| Görev panosu (kalıcı kartlar) | kart + durum + atanan | bellek-içi durum akışı | **KISMİ** |
| Delegasyon + alt görev | lider böler, `2/4` sayacı | fan-out var, alt görev kartı/hiyerarşisi yok | **KISMİ** |
| Kanıtlı kapanış (rapor+delil) | raporda komut + yeşil/kırmız | prompt kuyruğu, delil yok | **YOK** |
| Kullanım ledger (token + API eşdeğeri) | motorun kendi defterinden | `chars/4` | **YOK** |
| Hesaplar + limitte hesap değiştirme | var | yok | **YOK** |
| Otopilot / hands-off / daemon | var | yok | **YOK** |
| Canlı diff + anında izleme | var | dal bırakıyor, diff yüzeyi yok | **KISMİ** |
| Birleştirme (merge) yardımıcısı | — | yok (bilinçli insan kararı) | **YOK** |
| Entegrasyon merkezi + kasa | 8 servis, yetenek kartları | yalnızca MCP stdio | **YOK** |
| Uzaktan onay (telefondan) | var | hosted CLI onayı yakalanmıyor | **YOK** |
| Cihaz eşleştirme / kill switch | var | yok | **YOK** |
| Zamanlanmış görevler (cron) | yok sayılmaz; `schedule` yok | yok | **YOK** |
| Bildirim (yaklaşan onay / bitiş) | var | yok | **YOK** |
| Tarayıcı aracı + izin kapısı | gömülü tarayıcı | yok | **YOK** |
| Türkçe + sesli girdi | var | yok | **YOK** |
| İzolasyon (worktree, çakışma) | paralel oturum | worktree + çakışma raporu | **VAR** |
| Gerçek PTY + split + isimli panel | var | var (`--terminal`, `[`/`]`, `m`) | **VAR** |
| Güvenlik modeli (containment, redaksiyon) | diskte kalır | güçlü | **VAR** |

---

## 4. İnşa planı

Boyut: **S** ≈ 0.5–1 gün · **M** ≈ 2–4 gün · **L** ≈ 5–10 gün (tek geliştirici, tahmini).

### E1 — Motor kaydı: 2 motordan "herhangi bir CLI ajan"a  ·  `L` · önce bu

AjanSpace'in tüm ürün modeli "motor seninki" üzerine kurulu. Bu olmadan kadro, maliyet,
hesap ve delegasyonın hiçbiri gerçek anlama kavuşmuyor.

**Yapılacak**
- Yeni crate `yuppycode-engines`: `Engine` tanımı veri olur, enum değil.
  ```rust
  pub struct EngineSpec {
      pub id: String,            // "claude-code" | "codex" | "opencode" | kullanici-tanimi
      pub display: String,
      pub detect: Vec<String>,       // PATH'te aranacak program
      pub version_args: Vec<String>,
      pub interactive_args: Vec<String>,
      pub headless_args: Vec<String>,      // {prompt} yer tutuculu
      pub session_log: Option<LogReaderSpec>,   // A6 için: oturum dosyası+yol kalıbı
      pub status_args: Option<Vec<String>>,     // A6 için: giriş durumu okuma
      pub capability: Capability,      // Lead | LeadPartial | WorkerOnly
      pub cost_hint: Option<f64>,
  }
  ```
- Katalog üç kaynaktan toplanır: gömülü varsayılanlar → `$YUPPY_CONFIG_DIR/engines.d/*.toml`
  → tekil `--engine` bayrağı. Çakışmada son yazan kazanır ve `yuppy engines doctor` bunu söyler.
- Yetkinlik seviyesi zorlanır: `LeadPartial` bir motor lidere atanırsa uyarı, `WorkerOnly`
  atanırsa reddetme. Bugün `--agent claude|codex` string parse'ı bu kataloğa bağlanır.
- Komut yüzeyi:
  ```
  yuppy engines list [--json] [--enabled]
  yuppy engines probe [<id>]            # sürüm, PATH, yetkinlik, headless kabiliyeti
  yuppy engines add <id> --program <p> [--headless "<args>"] [--capability worker]
  yuppy engines rm <id>
  yuppy engines enable|disable <id>
  yuppy engines doctor                  # katalog ↔ doküman/durum ayrışmasını yakalar
  ```
- `yuppy agents` geriye dönük uyumlu kalır, artık kataloğun `Lead+` alt kümesini basar.
- **Build gate:** katalog ile `README.md`'deki motor tablosu birbirinden ayrışmışsa test kırılır
  (AgentSpace'in "build kapısı kızarır" ilkesinin CLI karşılığı).

**Kabul**
- `crates/yuppycode-engines/tests/`: kayıt-sonrası bir kullanici-tanimi motorun `task` ve
  `/mission` üzerinden gerçekten spawn olması; `WorkerOnly` motorun lidere atanamaması;
  bozuk TOML'un sessiz yutma yerine satır numaralı hatayla dönmesi.
- Katalog-doküman eşleşme testi.

---

### E2 — Kalıcı kadro ve ajan kimliği  ·  `M` · E1'e bağlı

AjanSpace'te iş "bana kod yaz" değil, "Ada'ya ver". Kadro olmadan pano ve rapor havada kalır.

**Yapılacak**
- Yeni crate `yuppycode-board`: `agents`, `tasks`, `task_links`, `reports`, `report_evidence`,
  `usage_events` tabloları (mevcut `yuppycode-memory` şemasına dokunmadan, ayrı dosya).
- `Agent` kimliği: `id`, `ad`, `rol`, `engine_id`, `model`, `dept`, `enabled`, `note`,
  `memory_path` (ajan-özel hafıza dosyası).
- `DepartmentRole` bu kimliğe taşınır; eski HUD JSON'u şema versiyonuyla migrasyon edilir.
- Komut yüzeyi:
  ```
  yuppy agent ls [--json] / show <ad> / add <ad> --role backend --engine codex [--model m]
  yuppy agent rm|enable|disable <ad>
  yuppy agent assign <ad> --dept <id>
  yuppy agent memory <ad> [--append <metin> | --show]
  ```
- `--agent claude` yerine `--agent <ad>|<engine-id>`; eski değerler çalışmaya devam eder.

**Kabul**
- Kadro satırı olmadan görev atanamaz; atanırsa net hata ("bilinen motor/ajan adı verin").
- İki `yuppy` süreci aynı kadroyu okur (SQLite WAL); migrasyon testi eski JSON'u korur.

---

### E3 — Görev panosu + delegasyon  ·  `L` · E2'ye bağlı

Bugün görevler süreçle birlikte ölüyor; AjanSpace'in tüm yönetim dili kalıcı kartlar üzerine kurulu.

**Yapılacak**
- Kart modeli: `TASK-<kısa-kimlik>`, başlık, açıklama, durum
  (`backlog | ready | working | waiting | review | done | failed`), atanan, departman,
  alt görev bağları (`task_links`), zaman damgaları, kök görev.
- Bugünkü `/mission` fan-out'u alt görev üretir: 1 ana kart + N rol kartı + 1 entegrasyon kartı.
  Böylece `2/4 subtasks` sayacı gerçek veri olur.
- Komut yüzeyi:
  ```
  yuppy board ls [--status working] [--assignee Ada] [--dept <id>] [--json]
  yuppy board add "<başlık>" [--desc "<açıklama>"] [--assign <ad>] [--parent TASK-X]
  yuppy board show TASK-X            # kart + alt görevler + son rapor + dal + diff stat
  yuppy board assign TASK-X <ad> / start TASK-X / note TASK-X "<metin>"
  yuppy board close TASK-X [--reason "<...>"] / reopen TASK-X
  yuppy board watch                  # taze kart olaylarını akıtır (kullanici Ctrl-C ile çıkar)
  yuppy board rm TASK-X
  ```
- TUI: `b` → pano görünümü (`b` bugün boşta; komut modu bağları `y n i x r t e m / [ ] 1-9 q` + `Tab`/`Esc`);
  `/board <alt komut>` TUI konsolundan aynı store'u kullanır.
- Protocol: `TaskUpsert` zaten var; kart başlığı/açılan/alt-görev sayacı alanları **additive**
  eklenir (v1 tel şekilleri byte-testleriyle korunuyor — yeni alan `Option` + `skip_serializing_if`).

**Kabul**
- `yuppy board add` ile oluşturulan kart, `yuppy` kapandıktan sonra `board ls`'te durur.
- `/mission` sonrası ana kart `review`'a geçer, tüm alt kartlar terminal durumda olmadan geçmez.
- Döngüsel `parent` bağı reddedilir (test).

---

### E4 — Kanıtlı kapanış: rapor + delil  ·  `M` · E3'e bağlı

AjanSpace'te iş "rapor + delil" ile kapanıyor; kullanıcı raporu okuyup kabul ediyor.
Bugün rapordan sadece 2000 karakter bir sonraki prompt'a ekleniyor.

**Yapılacak**
- Rapor artifact'ı: `.yuppy/reports/<TASK-ID>.md` + aynı içeriğin `reports` tablosuna indekslenmesi.
  Şablon: amaç · yapılan · değişen dosyalar · **deliller** (komut, exit code, özet) · riskler · sonraki adım.
- Delil kapısı: `yuppy board submit TASK-X --prove "cargo test --workspace" [--prove "..."]`
  komutları çalıştırır, exit code + kırpılmış çıktıyı rapora gömer; kırmızıysa kart `review`'a
  geçmez, `failed` kalır. Delilsiz submit ancak `--force` ile ve raporda açık ibareyle.
- Kabul akışı: `yuppy board accept TASK-X` / `reject TASK-X --reason "..."` —
  reject kartı `working`'e döndürür ve gerekçeyi ajanın bir sonraki prompt'una taşır.
- `compose_report_prompt` artık kuyruk yerine raporun yapısal özetini + dal/diff bilgisini kullanır.
- Komut yüzeyi: `yuppy report ls|show|export TASK-X [--format md|json]`.

**Kabul**
- Kabul edilmemiş kart `done` olamaz; `done` olan her kartın en az bir delil satırı vardır (test).
- Rapor, rapor dosyasından okunduğunda branch adı ve değişen dosya listesini içerir.

---

### E5 — Kullanım defteri ve dürüst maliyet sayacı  ·  `M` · E1'e bağlı

AjanSpace'in en ayırt edici dürüstlüğü: sayıyı uydurmuyor, motorun kendi defterini okuyor,
ölçemediğinde `unpriced` basıyor, kota yüzdesi barı çizmiyor.

**Yapılacak**
- `EngineSpec.session_log`: motorun oturum dosyasını okuyup `prompt/completion/cache token`,
  `model`, `başlangıç` çıkaran ayrıştırıcı (motor başına ayrı adaptör; `None` = ölçulemez).
- `usage_events` tablosu; `estimate_tokens` yalnızca **etiketli tahmin** olarak kalır ve
  asla ölçülmüş gibi basılmaz.
- Komut yüzeyi:
  ```
  yuppy usage [--session <id> | --task TASK-X | --all] [--since 7d] [--by-model] [--json]
  ```
  Çıktı: token, API eşdeğeri `$`, motor, model, kaynak (`engine-ledger` | `estimate` | `unpriced`).
- Fiyat tablosu `$YUPPY_CONFIG_DIR/pricing.toml`; fiyatı olmayan model `unpriced` yazar, `$0` değil.
- TUI üst başlığı: oturum + tüm oturumlar toplamları, aynı kaynak etiketiyle.

**Kabul**
- Ledger'da kaynağı olmayan hiçbir satır `$0.00` olarak görünmez (test).
- Motor defteri bozuk/eksikse komut hata vermez, `unpriced` der.

---

### E6 — Süreklilik: daemon + otopilot + takvim  ·  `L` · E3'e bağlı

"Oto pilot candır" — kullanıcı masada değilken iş devam etmeli. Bugün her şey TUI süreciyle ölür.

**Yapılacak**
- `yuppy daemon up|down|status|logs [-f]`: terminalsiz (headless) süreç; pano store'unu tek yazar olarak
  sürer, köprüyü (varsa) o taşır. SQLite `WAL` + `busy_timeout`; kilit çakışması net hata verir.
- Hands-off kuralı: bir görev terminal duruma geçince `ready` durumundaki sıradaki kartı alır
  (`--hands-off`, departman `conc` sınırı geçerli).
- Takvim: `yuppy schedule add "her gün 07:30" --task "..." --assign Ada`, `schedule ls/rm/pause`,
  `yuppy autopilot start|stop|status`.
- Yedekleme: daemon çökerken `working` kartlarını `waiting`'e düşürür ve rapora not yazar
  (kimse "yarım kaldı sanmasın").

**Kabul**
- Terminal kapatıldıktan sonra kartlar ilerlemeye devam eder; `board ls` dışarıdan okunabilir.
- İki daemon aynı anda çalışmaz (pid dosyası + kilit testi).
- `yuppy autopilot stop` o anki görevi iptal eder, kartı `waiting`'e bırakır.

---

### E7 — Diff, canlı izleme ve birleştirme yardımıcısı  ·  `M` · E3 ile paralel

Worktree + `yuppy/task-<id>` altyapısı hazır; kullanıcıya gösteren yüzey yok.

```
yuppy diff TASK-X [--stat | --patch | --file <yol>]
yuppy watch TASK-X            # dalın yeni commit'lerini + diff istatistiklerini akıtır
yuppy merge TASK-X --into <dal> [--dry-run]   # her zaman insan onaylı; --dry-run varsayılan
yuppy conflicts               # iki rolün birlikte dokunduğu dosyaların künye listesi
```
`supervisor.rs`'te üretilen çakışma uyarısı artık `yuppy conflicts`'ta ve kart detayında görünür.

**Kabul:** birleştirme asla kendiliğinden olmaz (`--dry-run` olmadan bile onay istemi);
`yuppy diff` bir rol kartının yalnızca kendi commit'lerini gösterir.

---

### E8 — Uzaktan onay ve cihaz yönetimi  ·  `L` · E6 ile koordineli

AjanSpace'de en çok övülen şeylerden biri: bekleyen onayı telefondan temizlemek.
Yuppy'de `ApprovalRequired` protokolde var ama hosted CLI'ın native izin istemleri yakalanmıyor.

**Yapılacak**
- `yuppycode-terminal` ekranında izin istemi sınıflandırıcısı (motor başına kalıp seti):
  yakalanan istem `ApprovalRequired` olayına, karar yazımı `TerminalInput`'a çevrilir.
  Kalıp eşleşmezse **onay uydurulmaz** — istem insana bırakılır ve "yakalanamadı" diye işaretlenir.
- Protocol'e additive: `ApprovalList`, `ApprovalResolved { approver, ts }`, `DeviceEvent`.
- Komut yüzeyi:
  ```
  yuppy approve ls / yuppy approve <id> / yuppy deny <id> --reason "..."
  yuppy pair            # tek kullanımlık kod + QR metni; köprüyü Tailscale adresine bağlar
  yuppy device ls|revoke <id>
  yuppy kill-switch on|off     # açıkken tüm uzaktan yolları kapatır, yerel çalışmaya dokunmaz
  ```
- Ağ: AgentSpace'in `0.0.0.0` reddi gibi — loopback dışı bind **yalnızca** RFC1918/100.64/10
  aralığında ve açık bir `--allow-non-loopback` + eşleştirme ile; `0.0.0.0`/`::` her hâlde reddedilir.
  Mevcut `YUPPY_BRIDGE_ALLOW_NON_LOOPBACK` env kapısı (`bridge/mod.rs:84`) buna göre daraltılır.
- Oturum görüntüsü: tam hücresel döküm yerine önce `read-along` (düz metin kuyruğu) — ucuz, güvenli,
  sonra hücresel.

**Kabul:** telefon/uzak uçtan onay verilen bir hosted-CLI istemi panele doğru tuşu yazar;
yakalanamayan bir istem "insana bırakıldı" olarak görünür, otomatik onay asla üretilmez;
kill-switch açıkken köprü uzaktan bağlanamaz.

---

### E9 — Entegrasyon merkezi + kasa  ·  `L` · E1 sonrası herhangi bir sırada

Bugün tek harici köprü MCP. AjanSpace'in "bir kez bağla, ajan gerisini halleder" katmanı yok.

**Yapılacak**
- `yuppycode-vault`: diskte şifreli anahtar kasası (OS keychain varsa o, yoksa `YUPPY_VAULT_KEY`
  ile AES-GCM). Anahtar asla loga, audit'e, protokol olayına ya da masked bile olsa durum
  sorgusuna girmez.
- Yetenek kartları: bağlanan servisin **gerçek** araç listesinden türetilir (MCP `tools/list` veya
  HTTP `capabilities`), elle yazılmaz.
- Üç dürüst durum, prompt'a enjekte edilir: `CONNECTED` / `CONNECTED · SCOPE SHORT (eksik: X)` /
  `NOT CONNECTED (bağlan: yuppy integration add X)`.
- Ortam kapsaması: `--env dev|prod`; prod anahtarları ayrı kayıt ve açık `--prod` bayrağı ister.
- Komut yüzeyi:
  ```
  yuppy integration ls|add <ad> [--key-env VAR|--key-stdin] [--env dev|prod]
  yuppy integration test <ad> / rm <ad>
  yuppy integration status <ad>        # kapsama + araç sayisi; anahtar yok
  ```
- Yerleşik katalog: Supabase, GitHub, Sentry, Stripe, PostHog, Vercel (MCP sunucu eşleşmeleriyle).

**Kabul:** anahtarsız/yanlış kapsamlı bir servis için ajan yanıtı "bağla, şunu yaparım" kalıbında
olur (test: durum sözlüğü → prompt enjeksiyonu); kasadan okunan değer hiçbir çıktı kanalında
görünmez (redaksiyon testi).

---

### E10 — Bildirimler  ·  `S`

```
yuppy notify on|off
yuppy notify add desktop|telegram|webhook [--on approval|done|failed] [--url ...]
```
Olay kaynakları: onay bekleniyor, kart `review`'a geçti,.delil kırmızı, daemon düştü.
Varsayılan kapalı; kanal yapılandırılmamışsa sessizce yerel log.

### E11 — CLI ergonomisi (üretim kalitesi)  ·  `M` · hemen başlanabilir

Bugünkü yüzey geliştirmeye göre, kullanmaya göre tasarlanmamış. Küçük ama maliyeti her gün artıyor:

- `config.toml`: bugünkü 10+ `YUPPY_*` env değişkeni tek dosyada; env önceliklidir, geriye uyumlu.
- `yuppy doctor`: PATH'deki motorlar, git deposu/worktree ön koşulu, SQLite yazılabilirliği,
  provider erişilebilirliği, köprü portu, izin modu — tek komutta, `--json` çıktılı.
- Tüm okuma komutlarına `--json`; `--quiet`; tutarlı çıkış kodları (0 ok, 1 hata, 2 kullanım, 3 kısmi).
- `yuppy completions <shell>` (`clap_complete`), `yuppy init` (`.yuppy/` + `.gitignore` + varsayılan kadro).
- `yuppy sessions ls|show|rm|resume` — `yuppycode-memory`'de duran konuşmalara CLI erişimi hiç yok.
- `yuppy task --retry TASK-X --from-report` (yarım kalan işi rapor üzerinden devam ettirme).
- `yuppy history` / `yuppy audit [--task TASK-X]` — `audits` tablosu dolu ama sorgulayan yok.

**E11 durumu (2026-11-02).** Kalıcılık tarafındaki iki madde yapıldı:
`yuppy sessions ls|show|rm` ve `yuppy audit [-c <konuşma>]` — `yuppycode-memory`'deki
`conversations/messages/audits` satırlarını sorgulayan ilk yüzey bunlar. Salt-okunur
sorgular `crates/yuppycode-memory/src/query.rs` içinde (`Memory` trait'ine dokunmadan),
komut yüzeyi `crates/yuppycode-cli/src/sessions.rs`. `--json` ve çıkış kodları
(0/1/2) bu yüzeyde tam; diğer okuma komutlarına henüz yayılmadı. `config.toml`,
`yuppy doctor`, `completions`, `init`, `history` ve `task --retry` hâlâ açık.

Bu iş testi sırasında gerçek bir hata çıktı: `SqliteMemory::migrate` açık bir
veritabanını **ikinci kez** açarken `UPDATE schema_version SET version = 1`
satırı iki işaretleme satırını birincil anahtarda çarpıştırıp açılışı çökertiyordu.
Motor tek açıcı olduğu için hiç görülmemişti; dışarıdan okuyan ilk komut gördü.
Artık versiyon okuması `MAX(version)`, işaretleme tek satıra yazılıyor, ve yeni
dosya-testi aynı dosyayı üç kez açıyor (`crates/yuppycode-memory` testleri).

### E12 — Referansın arayüz katmanı (P2)  ·  `L`

Sıra omurgada bitince: gömülü tarayıcı aracı + izin kapısı (A8'in "browser permission: click"
akışı), Türkçe arayüz + sesli girdi kancası (`yuppy say` — stdin'i prompt'a çevirir), ofis/HUD
gamification'ı, Tauri paketleme (Phase 3).

---

## 5. Sıra

```
E1 (motor kaydı) ──┬─> E2 (kadro) ──> E3 (pano) ──┬─> E4 (rapor+delil) ──> E6 (daemon+otopilot)
                   ├─> E5 (kullanım)              ├─> E7 (diff/watch)  ──┘
                   └─> E9 (entegrasyon)           └─> E8 (uzaktan onay) [E6 ile koordineli]
E11 (CLI ergonomisi) ── her fazla paralel, bağımlılıksız
E10 (bildirim)       ── E4/E6'dan sonra
E12 (arayüz katmanı) ── omurga bitince
```

Neden bu sıra: kadro ve pano yoksa raporun, maliyetin, otopilotun yazılacağı bir nesne yok.
Motor kaydı ise kadronun `engine_id`'sinden kullanım defterinin ayrıştırıcısına kadar her şeye
girdi olduğu için tek engel noktası — orayı veriye çevirmezsek sonraki her epic'e enum yayılır.

## 6. Mimari kurallar (mevcut kuralları bozmadan)

1. `yuppycode-core` dokunulmaz kalır: Ratatui, rusqlite, reqwest, tokio-process yok.
   Yeni kalıcılık `yuppycode-board`/`yuppycode-memory` içinde, motor katmanı `yuppycode-engines`'te,
   kasa `yuppycode-vault`'ta yaşar.
2. Protocol **additive** kalmaya devam eder: yeni alan `Option` + `skip_serializing_if`;
   v1 tel şekillerini byte-guard eden testler güncellenmez, yenisi eklenir.
3. Ölçülemeyeni uydurma: kota yüzdesi, sahte `$0`, olmayan token sayısı, eşleşmeyen onay
   kalıbı — hiçbiri üretilmez. Kaynak etiketi (`measured` / `estimate` / `unpriced`) zorunlu.
4. İzolasyon ilkesi korunur: orchestrator merge yapmaz, force-push yapmaz; `yuppy merge`
   yalnızca insanın açık onayıyla ve varsayılan `--dry-run` ile çalışır.
5. Native motor izin istemleri aşılmaz; uzaktan onay yalnızca **yakalanmış** istemler için
   karar yazar, yakalanamayan istem insana düşer.
6. Anahtarlar yalnızca kasada; prompt'a, loga, audit'e, protokol olayına sızmaz.
7. `vt100 0.15` / `ratatui 0.29` pini bozulmaz; terminal bağımlılığı
   `yuppycode-terminal` içinde izole kalmaya devam eder.

## 7. Hemen düzeltilebilecekler (kod değişikliği gerektirmeyen sürprizler)

| Bulgu | Düzeltme |
|---|---|
| `README.md:282` "`TaskSubmit`/`TaskCancel` hâlâ stub" diyor; `bridge/handlers.rs:57-58` implemente edilmiş | README güncellenir (veya stub'a döndürülen bir şey varsa o) |
| `README.md` "162 tests" | Gerçek: 172 `#[test]`; README düzeltilir veya "test sayısını" kaynaktan üreten bir test eklenir |
| README/Roadmap'ta Phase 2 frontend için "köprü ileride kurulacak" ifadesi köprü mevcutken bayat | Faz durumu tek yerden tutulur |
| `docs/PHASE2_REPORT.md` "bridge yok" diyor (satır 251, 322) | Köprü sonrası rapor güncellenir; tarihsel rapora "durum: bayat" notu |
| Motor listesi elle yazılıyor | E1'in katalog-üretimi testi bunu kalıcı olarak bağlar |
| README klavye tablosu `d` (departman döngüsü), `t` (Claude Code aç), `v` (Codex aç) diyor; hiçbiri bağlı değil — `app.rs:613,621`'de `t`/`e` kutu modunda CLI'a literal Tab/Esc gönderiyor, departman döngüsü `/dept`, CLI açma `/claude` `/codex` | Klavye tablosu `app.rs` bağlarıyla değiştirilir; komut-doküman eşleşme testi eklenir |

## 8. Kabul ölçütü (plan bitince nasıl anlaşılır)

Bir faz "bitti" sayılır ancak:

- `cargo test --workspace` geçer ve epic'in kabul testleri `crates/*/tests/` altında somuttur.
- Yeni/değişen her CLI yüzeyi `yuppy <komut> --help`'te görünür ve `--json` destekler.
- `yuppy doctor` yeni yapılandırma yüzeyini kontrol eder; `yuppy completions` yeni komutları basar.
- README'deki komut tablosu ile `--help` çıktısı eşleşir (test ile bağlanır).
- Uydurulmuş metrik iddiası yoktur: her sayının bir kaynağı vardır ya da `unpriced`/`estimate` yazar.
