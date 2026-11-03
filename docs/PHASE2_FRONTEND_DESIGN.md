# Phase 2 Frontend Tasarım Raporu: 3D AI Command Center

Tarih: 2026-10-31
Konu: YuppyCode/Jarvis için Next.js + TypeScript + Three.js/WebGL tabanlı 3D komuta merkezi frontend tasarımı.
Durum: Tasarım aşaması — implementasyon başlamadan önce onay bekleniyor.
Bağımlı commit: `c3833cd`

---

## 1. Mevcut durum incelemesi

### 1.1 Rust çekirdeğinde gerçekten uygulanan özellikler

Milestone A–H sonunda aşağıdaki özellikler çalışır durumda ve test edilmiştir:

| Özellik | Durum | Kanıt |
|---------|-------|-------|
| PTY terminal oturumları (`yuppycode-terminal`) | ✅ Çalışır | 8 test; gerçek Claude/Codex çıktısı |
| Claude Code ve Codex adaptörleri (`yuppycode-agents`) | ✅ Çalışır | `yuppy agents` doğrulaması |
| Ratatui içinde canlı CLI oturumları (`yuppycode-tui`) | ✅ Çalışır | Manuel TUI testi |
| Departman kayıt/defteri (`yuppycode-hud`) | ✅ Çalışır | 6 varsayılan departman; CRUD |
| HUD layout modeli ve persistence | ✅ Çalışır | JSON kaydet/yükle |
| Görev planlayıcısı (`yuppycode-orchestrator`) | ✅ Çalışır | 9 test; gerçek git worktree |
| Protokol v2 (`yuppycode-protocol`) | ✅ Çalışır | 119 testin içinde v1/v2 uyumluluk |
| `yuppy task` CLI komutu | ✅ Çalışır | `--worktree`, `--max-parallel`, `--timeout-secs` |
| `yuppy dept` CLI komutu | ✅ Çalışır | list/show/clone/enable/disable/move/rm |

### 1.2 Sadece altyapı olarak hazırlanan özellikler

Aşağıdaki özelliklerin veri tipleri, protokol mesajları ve Rust API'leri hazır, ancak **henüz çalışan bir uçtan-uca frontend köprüsü yok**:

- **WebSocket/IPC bridge server:** `ClientRequest` ve `ServerPayload` tipleri tanımlı, fakat bunları taşıyan bir socket sunucusu implemente edilmedi.
- **`AwaitingApproval` görev durumu:** `TaskStateDto::AwaitingApproval` protokolde var, ancak `ProcessTaskRunner` bu durumu henüz üretmiyor (sahte telemetry üretilmemesi için).
- **Named layouts:** `HudStore::save_layout` / `load_layout` var, ama CLI/TUI'da isimlendirilmiş layout komutu yok.
- **Departman `allowed_tools` ve `model` kısıtlamaları:** Veride tutuluyor, fakat planlayıcı tarafından zorlanmıyor.
- **Fare olayları:** Hosted CLI oturumlarına mouse iletilmiyor.
- **Windows/ConPTY:** Linux'da test edilmedi.

### 1.3 Doğrulanmış son durum

```bash
cargo test --workspace          # 119 passed, 0 failed
cargo clippy --workspace --all-targets -- -D warnings  # 0 warning
cargo fmt --check               # clean
git log --oneline -1            # c3833cd docs: Phase 2 implementation report + updated README
```

---

## 2. Bridge mimarisi

### 2.1 Seçenekler karşılaştırması

| Seçenek | Artıları | Eksileri | Uygunluk |
|---------|----------|----------|----------|
| **A. WebSocket (localhost)** | Tarayıcıdan doğrudan bağlantı; Tauri'de de çalışır; anlaşılır ve debug edilebilir. | TCP port açılması; güvenlik duvarı/CSRF/CORS dikkat gerektirir. | **Önerilen** |
| **B. Unix domain socket / named pipe (IPC)** | Daha hızlı, daha güvenli, port yok. | Tarayıcı doğrudan bağlanamaz; Tauri sidecar veya proxy gerekir. | Phase 3 Tauri için uygundur, şimdilik ek karmaşıklık. |
| **C. Hibrit: WebSocket + IPC** | Esnek; Tauri IPC + web fallback. | İki transport katmanı yazmak gerekir. | Gelecekte geçiş için uygun, ancak ilk aşamada maliyetli. |

### 2.2 Öneri: WebSocket (localhost)

İlk Phase 2 frontend için **WebSocket over localhost** seçilmelidir. Gerekçeler:

1. Next.js uygulaması tarayıcıda çalıştığında doğrudan `ws://127.0.0.1:<port>` bağlantısı kurabilir.
2. Tauri Phase 3'te aynı WebSocket endpoint'e bağlanabilir veya yerel IPC'ye geçiş yapılabilir.
3. Mevcut protokol (`Envelope + ServerPayload/ClientRequest`) zaten transport-agnostic tasarlandı.
4. Debug ve geliştirme kolaydır; `websocat`, tarayıcı DevTools, vs. ile izlenebilir.

### 2.3 Bridge sunucusunun Rust tarafında konumu

Yeni bir crate açmak yerine, mevcut `yuppycode-cli` crate'i içerisine bir alt modül (`bridge`) eklenmeli ve `yuppy bridge` komutu ile başlatılmalıdır. Böylece:

- `yuppycode-core`, `yuppycode-protocol` ve `yuppycode-orchestrator` gibi ağır bağımlılıklar zaten CLI'da mevcut.
- Ayrı bir binary/deploy edilecek parça yönetimi azalır.
- Tauri Phase 3'te aynı bridge kodu `yuppycode-cli` sidecar olarak çalıştırılabilir.

Gerekli yeni bağımlılıklar: `tokio-tungstenite` ve `tokio` zaten var.

### 2.4 Bridge görevleri

1. WebSocket bağlantılarını kabul et.
2. Gelen JSON mesajlarını `ClientRequest` olarak deserialize et.
3. `AgentEngine`, `TerminalManager`, `HudStore`, `Orchestrator` gibi Rust servislerine ilet.
4. Giden olayları `Envelope` içinde `ServerPayload` olarak serialize edip gönder.
5. Reconnection desteği: her client bağlandığında `AgentInventory`, mevcut layout, aktif departman ve çalışan terminal ekranlarını yeniden gönder.
6. Sürümleme: `PROTOCOL_VERSION` uyuşmazsa bağlantı reddet ve nedenini bildir.

### 2.5 Örnek mesajlar

#### Client → Server

**Terminal açma:**
```json
{
  "type": "open_terminal",
  "agent": "claude-code",
  "label": "main",
  "department": "software-development"
}
```

**Terminal girişi:**
```json
{
  "type": "terminal_input",
  "session_id": "s1",
  "bytes": "ls -la\r"
}
```

**Görev başlatma:**
```json
{
  "type": "task_submit",
  "tasks": [
    {
      "id": "t1",
      "title": "Review README",
      "prompt": "Review README.md and suggest improvements.",
      "cli": "claude-code",
      "department": "code-review-testing",
      "isolation": "worktree",
      "timeout_secs": 600
    }
  ]
}
```

**Departman güncelleme:**
```json
{
  "type": "department_upsert",
  "department": {
    "id": "custom-research",
    "name": "Custom Research",
    "icon": "🔬",
    "agents": [{"cli": "claude-code"}],
    "max_concurrency": 2,
    "enabled": true
  }
}
```

#### Server → Client

**Zarf şeklinde terminal ekranı:**
```json
{
  "version": 2,
  "seq": 42,
  "ts_ms": 1767244800000,
  "payload": {
    "type": "terminal_screen",
    "session_id": "s1",
    "rows": 24,
    "cols": 80,
    "cursor": [5, 2],
    "cursor_visible": true,
    "generation": 128,
    "cells": [
      {"ch": "h", "fg": {"t": "default"}, "bg": {"t": "default"}, "bold": false, ...},
      ...
    ]
  }
}
```

**Görev durumu:**
```json
{
  "version": 2,
  "seq": 43,
  "ts_ms": 1767244800100,
  "payload": {
    "type": "task_state",
    "task_id": "t1",
    "state": "running",
    "detail": "preparing git worktree"
  }
}
```

**Review artifact:**
```json
{
  "type": "task_integration",
  "task_id": "t1",
  "branch": "yuppy/task-t1",
  "changed_files": ["README.md"],
  "committed": true
}
```

**Çakışma uyarısı:**
```json
{
  "type": "task_conflict",
  "task_a": "t1",
  "task_b": "t2",
  "path": "src/main.rs"
}
```

### 2.6 Mevcut kodda hazır olanlar ve yapılacaklar

| Hazır olan | Yapılacak |
|------------|-----------|
| `ClientRequest` / `ServerPayload` tipleri | `tokio-tungstenite` ile WebSocket sunucusu |
| `Envelope` zarf formatı | `yuppy bridge` alt komutu |
| `AgentEvent → ServerPayload` dönüşümü (TUI'da var) | Bridge → engine/orchestrator/terminal yönlendirmesi |
| `TerminalScreen` DTO'ları | Client'ta grid renderer |
| `DepartmentDto`, `LayoutDto`, `TaskSpecDto` | UI state yönetimi ve formlar |

---

## 3. UI tasarım planı

### 3.1 Ekran yerleşimi

```
┌───────────────────────────────────────────────────────────────────────┐
│  [LOGO]  YUPPYCODE / JARVIS      [status: connected] [rss] [tasks]   │
├──────────────┬──────────────────────────────┬─────────────────────────┤
│              │                              │                         │
│  SOL HUD     │      MERKEZ 3D SAHNE         │    SAĞ HUD              │
│              │                              │                         │
│  - Departman │   Holografik Jarvis          │  - Seçili Agent Detay   │
│  - Agent     │   Avatar / Beyin             │  - Görev Durumu         │
│  - Görev     │                              │  - Loglar               │
│    Kuyruğu   │   (mouse: döndür/zoom/pan)   │  - Metrikler            │
│  - Proje     │                              │                         │
│    Seçimi    │                              │                         │
│              │                              │                         │
├──────────────┴──────────────────────────────┴─────────────────────────┤
│  ALT BÖLÜM: Terminal Panelleri (Claude Code / Codex)                  │
│  [Tab: Claude] [Tab: Codex] [+]                                       │
│  +---------------------------------------------------------------+    │
│  | ~ $                                                           |    │
│  |                                                               |    │
│  +---------------------------------------------------------------+    │
└───────────────────────────────────────────────────────────────────────┘
```

### 3.2 Bölgeler ve fonksiyonları

#### Merkez: 3D Jarvis Sahnesi
- Büyük, yumuşak animasyonlu holografik avatar veya nöron-beyin formu.
- Aktif görev sayısına, görev durumuna ve telemetry'e göre parçacık yoğunluğu/renk değişir.
- Boşta: yavaş mavi/camgöbeği dalgalanma.
- Görev çalışırken: turuncu/mor veri akışı hızlanır.
- Hata: kırmızı pulse.
- Mouse: sol tık + sürükle = döndür, scroll = zoom, sağ tık + sürükle = pan.

#### Sol HUD
- **Departmanlar:** Listeleme, aktif departman vurgusu, enable/disable toggle.
- **Agent listesi:** Hangi CLI'lar kurulu (`AgentInventory`).
- **Görev kuyruğu:** Çalışan, bekleyen ve tamamlanan görevler.
- **Proje seçimi:** Çalışma dizini / workspace seçimi.

#### Sağ HUD
- **Seçili agent detayları:** İsim, versiyon, durum.
- **Görev durumu:** Seçili görevin ilerlemesi, logları, çıktı özeti.
- **Metrikler:** token/s, TTFT, RSS, aktif tool call sayısı.

#### Alt Bölüm: Terminal Panelleri
- Her açık terminal için bir sekme.
- Grid tabanlı gerçek terminal çıktısı; ANSI renk desteği.
- Focus olan panele klavye girişi iletilir.
- Sekmeler sürüklenebilir, paneller yeniden boyutlandırılabilir, sabitlenebilir.

### 3.3 Temel kullanıcı akışları

1. **Uygulamayı aç:** WebSocket bağlantısı kurulur; `AgentInventory`, departmanlar ve varsayılan layout yüklenir.
2. **Departman seç:** Sol HUD'dan bir departmana tıkla; sağ HUD o departmanın agent ve görevlerini gösterir.
3. **Terminal aç:** Sol HUD'da "+ Claude" veya "+ Codex" butonuna tıkla; alt bölümde yeni sekme açılır.
4. **Görev başlat:** Sağ HUD'da prompt gir, isolation seç, "Run" butonu; görev kuyruğuna eklenir.
5. **Görev izle:** Görev durumu ve logları sağ HUD'da canlı güncellenir.
6. **Review:** Tamamlanan görevin `TaskIntegration` kartına tıkla; branch ve değişen dosyalar gösterilir.
7. **Layout kaydet:** Paneller istenilen şekilde düzenlenir; "Save Layout" ile sunucuya `LayoutSave` gönderilir.

---

## 4. Bileşen ağacı ve klasör yapısı

```
ui/                         # Next.js uygulama kökü (önerilen konum)
├── app/
│   ├── page.tsx            # Ana 3D komuta merkezi sayfası
│   ├── layout.tsx          # Global providers, theme
│   └── globals.css         # Tailwind + CSS variables
├── components/
│   ├── canvas/
│   │   ├── JarvisScene.tsx       # Three.js sahne kökü
│   │   ├── HologramBrain.tsx     # 3D obje + parçacıklar
│   │   ├── DataFlowParticles.tsx # Canlı bağlantı çizgileri
│   │   └── SceneControls.tsx     # OrbitControls wrapper
│   ├── hud/
│   │   ├── LeftHud.tsx
│   │   ├── RightHud.tsx
│   │   ├── DepartmentList.tsx
│   │   ├── AgentInventory.tsx
│   │   ├── TaskQueue.tsx
│   │   ├── TaskDetail.tsx
│   │   ├── MetricsPanel.tsx
│   │   └── LogStream.tsx
│   ├── terminal/
│   │   ├── TerminalWorkspace.tsx
│   │   ├── TerminalTabBar.tsx
│   │   ├── TerminalGrid.tsx       # ANSI grid renderer
│   │   ├── TerminalInput.tsx      # Focus + key forwarding
│   │   └── Cursor.tsx
│   ├── layout/
│   │   ├── DockablePanel.tsx
│   │   ├── ResizableSplit.tsx
│   │   └── PanelHeader.tsx
│   └── shared/
│       ├── ConnectionBadge.tsx
│       ├── StatusPill.tsx
│       └── Button.tsx
├── hooks/
│   ├── useBridge.ts         # WebSocket bağlantısı ve mesaj gönderimi
│   ├── useTerminalManager.ts
│   ├── useDepartments.ts
│   ├── useTaskQueue.ts
│   └── useTelemetry.ts
├── lib/
│   ├── protocol.ts          # ClientRequest/ServerPayload TypeScript tipleri
│   ├── color.ts             # ANSI → RGB dönüşümü
│   ├── layoutStore.ts       # Layout persistence (localStorage + server)
│   └── validators.ts        # Form validasyonları
├── stores/
│   └── commandCenterStore.ts # Zustand global state
├── types/
│   └── index.ts
├── public/
│   └── fonts/
└── tests/
    ├── protocol.spec.ts
    ├── TerminalGrid.spec.tsx
    └── bridge.spec.ts
```

---

## 5. Kullanılacak kütüphaneler ve gerekçeleri

| Kategori | Kütüphane | Neden |
|----------|-----------|-------|
| Framework | **Next.js 14+ (App Router)** | SSR/SSG, API routes, Tauri entegrasyonuna uygun. |
| Language | **TypeScript** | Protokol tipleri için güvenlik. |
| 3D | **React Three Fiber (R3F) + Three.js** | Deklaratif 3D sahne, React yaşam döngüsüne uygun. |
| 3D yardımcı | **@react-three/drei** | OrbitControls, efektler, yükleme yardımcıları. |
| Post-processing | **@react-three/postprocessing** | Bloom, glow, motion blur gibi holografik efektler. |
| State | **Zustand** | Hafif, TypeScript dostu, performanslı. |
| Styling | **Tailwind CSS** | Koyu sci-fi tema için hızlı UI. |
| Terminal grid | **Özel renderer** | `TerminalCellDto` dizisini `<span>` grid'e çevirmek yeterli; xterm.js gerekmez çünkü emülasyon Rust'ta. |
| WebSocket | **Native WebSocket** | Basit, ek bağımlılık yok. |
| Formlar | **React Hook Form + zod** | Departman/task formları için validasyon. |
| Test | **Vitest + @testing-library/react + MSW** | Hızlı test, mock WebSocket. |
| Lint/Format | **ESLint + Prettier** | Standart. |

### Neden xterm.js kullanılmıyor?

Terminal emülasyonu Rust'ta `vt100` ile yapılıyor ve `TerminalScreen` olarak gönderiliyor. Frontend sadece grid blit ediyor. Bu yüzden `xterm.js` eklemek gereksiz yere ağırlık ve protokol dışı bir emülatör çiftliği yaratır.

---

## 6. Güvenlik, performans ve test stratejisi

### 6.1 Güvenlik

- **Localhost only:** Bridge varsayılan olarak `127.0.0.1` üzerinde dinlemeli; `--bridge-host` ile override edilebilir.
- **Origin kontrolü:** WebSocket sunucusu `Origin` header'ını doğrulamalı; beklenmeyen origin reddetmeli.
- **Protokol sürümü:** `PROTOCOL_VERSION` uyuşmazsa bağlantı reddedilmeli.
- **Rate limiting:** `TerminalInput` ve `TaskSubmit` için basit rate limit (örn. 100 msg/sn/client).
- **Dosya yolu güvenliği:** Workspace seçimi Rust tarafında canonicalize edilmeli; frontend sadece server'a relative path göndermeli.
- **Secret koruması:** API anahtarları, tokenlar asla protocol üzerinden client'a gönderilmemeli.

### 6.2 Performans

- **Terminal grid optimizasyonu:**
  - Sadece `generation` değiştiğinde yeniden render et.
  - Sadece görünür pikselleri DOM'a koy; virtualize et.
  - Değişmeyen hücreleri memoize et (`React.memo` + shallow compare).
- **3D sahne optimizasyonu:**
  - Parçacık sayısını sınırla (örn. 2000); düşük performanslı modda 500'e düşür.
  - `useFrame` içinde ağır hesaplama yapma.
  - `instancedMesh` kullan.
- **Düşük performans modu:**
  - Kullanıcı ayarlarında veya otomatik FPS düşüşü algılandığında 3D efektleri azalt.
  - `prefers-reduced-motion` medya sorgusuna saygı göster.
- **Bridge backpressure:**
  - `TerminalScreen` mesajları throttled (max 30 FPS).
  - Büyük payload'lar için binary JSON veya MessagePack gelecekte düşünülebilir; ilk aşamada text JSON yeterli.

### 6.3 Test stratejisi

| Seviye | Araç | Kapsam |
|--------|------|--------|
| Birim | Vitest | Protocol tip dönüşümleri, ANSI renk mapper, state reducers. |
| Bileşen | @testing-library/react | TerminalGrid, DepartmentList, TaskQueue render. |
| Entegrasyon | MSW + mock WebSocket | `useBridge` hook, mesaj akışı, reconnect. |
| E2E | Playwright | Gerçek `yuppy bridge` başlatıp tarayıcıda login akışı. |
| Rust tarafı | `cargo test` | Bridge handler'ları, protocol serialization. |

---

## 7. Milestone'lara ayrılmış uygulama planı

### Milestone H1: Bridge altyapısı
- `tokio-tungstenite` ile `yuppy bridge` komutu.
- WebSocket sunucusu başlatma, client bağlantı/kopuş yönetimi.
- `AgentInventory` gönderimi.
- **Doğrulama:** `websocat` ile bağlanıp inventory mesajı alınmalı.

### Milestone H2: Protokol tip mirası (frontend)
- `ui/` Next.js projesi scaffolding'i.
- `protocol.ts` tiplerinin elle veya `json-schema-to-typescript` ile oluşturulması.
- `useBridge` hook: connect, send, reconnect, heartbeat.
- **Doğrulama:** TypeScript derleme hatasız; mock sunucuya ping/pong testi.

### Milestone H3: Sol + Sağ HUD (veri bağlı)
- Departman listesi, agent envanter, görev kuyruğu, metrik panelleri.
- Sahte veri yok; tüm veriler Rust bridge'den gelmeli.
- **Doğrulama:** E2E testte gerçek departmanlar listelenmeli.

### Milestone H4: 3D Jarvis sahnesi
- R3F sahne, hologram brain/avatar, parçacık sistemi.
- Telemetry'e göre renk/hız değişimi.
- **Doğrulama:** Lighthouse/performans audit; 60 FPS hedefi (düşük modda 30 FPS fallback).

### Milestone H5: Terminal panelleri
- `TerminalGrid` ve `TerminalWorkspace`.
- Klavye girişi, resize, interrupt, close.
- Sekme yönetimi.
- **Doğrulama:** Gerçek Claude Code/Codex oturumu açılıp tarayıcıdan yazılabilmeli.

### Milestone H6: Görev yönetimi
- Task submit, cancel, state tracking, integration/conflict kartları.
- Review branch ve değişen dosyaları gösterme.
- **Doğrulama:** `yuppy task` ile başlatılan görev frontend'de izlenebilmeli.

### Milestone H7: Layout, sürükle-bırak, düzen kaydetme
- Dockable/resizable paneller.
- Layout save/load.
- Düşük performans modu.
- **Doğrulama:** Kullanıcı layout değişikliği kaydedip yeniden açınca geri gelmeli.

### Milestone H8: Tauri geçiş hazırlığı
- WebSocket endpoint konfigürasyonu dışarıdan verilebilir hale getir.
- Protokolün IPC'ye geçişi için abstraction katmanı taslağı.
- Dokümantasyon güncelleme.
- **Doğrulama:** `cargo test --workspace` ve frontend test suiti hâlâ geçiyor.

---

## 8. Her aşamada doğrulama

Her milestone sonunda şunlar çalıştırılacak:

```bash
# Rust tarafı
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check

# Frontend tarafı
cd ui
npm run typecheck
npm run lint
npm run test
npm run build

# Entegrasyon (manuel veya Playwright)
# 1. yuppy bridge --port 9090
# 2. npm run dev
# 3. Tarayıcıda http://localhost:3000 aç
# 4. Bridge bağlı badge'i yeşil görmek
# 5. Terminal açmak, görev başlatmak, layout kaydetmek
```

### Kabul kriterleri (Definition of Done)

- [ ] Rust testleri 119+ olmalı; yeni bridge testleri eklenmeli.
- [ ] Frontend test coverage ≥ %60 (başlangıç için).
- [ ] Gerçek Claude Code ve Codex oturumları tarayıcıda açılabilir.
- [ ] Görev başlatma, izleme, iptal ve review akışları çalışır.
- [ ] Layout değişiklikleri kaydedilir ve geri yüklenir.
- [ ] Hiçbir sahte agent durumu, simüle CLI çıktısı veya yalnızca görsel sahte etkileşim yok.
- [ ] `cargo fmt` ve ESLint/Prettier temiz.

---

## 9. Açık kararlar ve onay beklenen noktalar

Aşağıdaki kararlar implementasyondan önce senin onayınla netleşmeli:

1. **Bridge transport:** WebSocket (localhost) seçeneğini onaylıyor musun? Yoksa IPC/hibrit mi tercih edersin?
2. **Proje konumu:** Next.js uygulaması `ui/` altına mı gelsin? (alternatif: `frontend/`, `web/`)
3. **3D avatar:** Holografik "beyin" formu mu, yoksa Iron Man tarzı bir asistan yüzü/avatarı mı olsun?
4. **Departman listesi:** Mevcut 6 varsayılan dışında kendi departmanını ekleme akışı; form mu, JSON editörü mü?
5. **Terminal grid:** Performans için `canvas` tabanlı renderer mı, yoksa DOM `<span>` grid mi? (öneri: DOM grid ile başla, 60 FPS altına düşerse canvas'a geç)
6. **Renk teması:** Mavi/camgöbeği (Jarvis) mu, yoksa farklı bir palet mi?

Bu raporu onayladığında, ilk milestone (H1: bridge altyapısı) için ayrıntılı plan sunulacak ve kodlamaya başlanacaktır.

---

*Bu belge tasarım aşamasındadır. Implementasyon başlamadan önce kullanıcı onayı gereklidir.*
