# Yupcode / Jarvis — AgentSpace command center (source archive)

Bu arşiv, `/opt/yuppycode` projesinin temizlenebilir kaynaklarını içerir.
Derleme artefaktarı (target/, node_modules/, out/) ve `.git` klasörü
ayrılmıştır — disk alanından tasarruf etmek için çıkarıldı.

## İçinde ne var

- `crates/` — Rust backend (bridge, terminal, orchestrator, agents, tui…)
- `ui/` — Next.js + Tailwind AgentSpace komuta merkezi (10 modül)
- `desktop/src-tauri/` — Tauri 2 masa/desktop kabı (.deb + .AppImage hedefi)
- `scripts/` — build + smoke script'leri
- `docs/` — plan ve desktop dokümanları
- `referans_gorsel.jpeg` — orijinal referans düzen görseli

## Derleme (yeni makinede)

```bash
# 1. Sistem bağımlılıkları (Debian/Ubuntu)
sudo apt-get install --no-install-recommends \
  pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev \
  build-essential curl file

# 2. Rust + pnpm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # veya zaten var
corepack enable
pnpm install --frozen-lockfile   # ui/ ve desktop/ içinde

# 3. Backend + frontend + paketler
source "$HOME/.cargo/env"
scripts/build_bundles.sh          # .deb + .AppImage → desktop/src-tauri/target/release/bundle/

# 4. Testler
cargo test --workspace
pnpm -C ui lint && pnpm -C ui test && pnpm -C ui exec tsc --noEmit
```

## Çalıştırma

- **Masaüstünde:** `desktop/src-tauri/target/release/bundle/appimage/YuppyCode_*.AppImage`
  (veya `.deb`’i `dpkg -i` ile kur). Shell kendi `yuppy bridge` sidecar’ını
  `{rastgele port}` üzerinde başlatır; token bellekte kalır.
- **Tarayıcıda:** `pnpm -C ui dev` → `http://localhost:3434`; bridge’i
  `yuppy bridge --host 127.0.0.1 --port 9090` olarak başlatıp ekrana çıkan
  token’ı Ayarlar’a yapıştır.

## Bilinen sınırlar

- Bridge v2’de chat, dosya tarayıcı, memory CRUD, skills editörü, kod editörü
  ve reports API’si yok; bu modüller dürüst "not exposed" durumunda.
- Terminal çıktısı yalnızca görünür ekran snapshot’ı olarak geliyor; uzun
  scrollback geçmişi backend’den gelmiyor.
- Yalnızca yüklü CLI’lar (Claude Code, Codex) canlı terminal olabilir; 4/8/12
  processes bu ortamda değil.
- `lto=false`, `codegen-units=4`: 4 GB RAM’li makinelerde LTO link zamanı
  OOM yapmaz.