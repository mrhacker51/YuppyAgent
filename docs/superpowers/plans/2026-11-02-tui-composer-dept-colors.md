# TUI Composer + Department Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Referans görsele uygun TUI: tui-textarea 0.7 ile çok satırlı prompt composer'ı ve departman başına renkli panel çerçeveleri.

**Architecture:** `tui_textarea::Textarea` `TuiApp`'ta editör motoru olarak yaşar; `ViewModel.input: String` + yeni `input_cursor` alanına senkronlanır (crate sözleşmesi: view-model saf kalır, render `fn(&ViewModel)`). Departman renkleri `theme.rs`'te id→renk haritası olarak yaşar; HUD modeli değişmez. Claude/Codex PTY entegrasyonuna (terminals.rs) dokunulmaz.

**Tech Stack:** ratatui 0.29 (sabit), crossterm 0.28 (sabit), tui-textarea 0.7.0 (tek yeni bağımlılık; ratatui ^0.29 + crossterm ^0.28 uyumlu, MIT).

**Spec:** Kullanıcı talebi + `referans_gorsel.jpeg`: renkli departman çerçeveleri (main=cyan, test=green, read=red), çok satırlı composer (Enter=gönder, Alt+Enter/Ctrl+J=yeni satır — kullanıcı onayladı), mevcut modal'lar kalır (tui-popup YOK — kullanıcı onayladı).

## Global Constraints

- ratatui 0.29.0 / crossterm 0.28.1 değişmez (vt100 0.15 + unicode-width pini bilinçli).
- Yeni bağımlılık yalnız `tui-textarea = "0.7"` (default features: crossterm backend). tui-input, tui-popup eklenmez.
- ViewModel ratatui türü içermez; `Textarea` yalnız `TuiApp`'ta.
- `terminals.rs`, `yuppycode-agents`, PTY/passthrough mantığı değişmez.
- `theme.rs` renk aşırma sistemi (TrueColor/Ansi/Mono) bozulmaz; her yeni renk `c()` üzerinden geçer.
- Claude Code / Codex permission prompt'ları ve mevcut tuş davranışları (passthrough, Esc, Ctrl+C) korunur.
- Her commit `cargo test -p yuppycode-tui` geçer halde olur; yalnız dokunulan dosyalar `git add` edilir (kullanıcının working tree'sinde başka değişiklikler var).

## Review Focus

- **Paste çok satırlı metin:** `Event::Paste` günah çıkarmaz — yapıştırılan `\n` composer'da satır bölmeli (terminaller bracketed paste kapatabilir; crossterm Paste event'i editor'e satır satır girmeli). Test: Task 2.
- **KeyKind Release/Repeat:** crosstermRelease event'leri editor'e girmemeli (çift karakter bug'ı). Test: Task 2.
- **model.input ↔ editor drift:** Testler ve `complete_slash`/Esc/`/` prefill doğrudan `model.input` yazarsa textarea senkrondan kalır; tek giriş kapısı `set_input()` olmalı. Test: Task 2.
- **Bilinmeyen departman id'leri:** Kullanıcının kayıtlı config'indeki custom dept'ler paletten kararlı (aynı id → hep aynı renk) bir hash ile renk almalı; crash/renksiz olmamalı. Test: Task 1.
- **Dar terminalde composer:** 20 sütun altında wrap + caret hâlâ doğru satırda çizilmeli; prompt yüksekliği `prompt_height` ile event tail'in min 1 satırını asla yememeli. Test: Task 2.

---

### Task 1: tui-textarea dependency + departman renk paleti (theme.rs)

**Files:**
- Modify: `crates/yuppycode-tui/Cargo.toml` (deps section)
- Modify: `crates/yuppycode-tui/src/theme.rs` (palette section, tests)
- Modify: `Cargo.lock` (cargo tarafından)

**Interfaces:**
- Produces: `theme::dept_color(Option<&str>) -> Color` (Task 3 kullanır); `theme::dim_rgb(Color, f32) -> Color`.
- Produces: workspace'te `tui_textarea` crate'i derlenir.

- [ ] **Step 1: Failing test yaz** — `theme.rs` test modülüne:

```rust
#[test]
fn department_ids_map_to_stable_distinct_colors() {
    let _g = GUARD.lock().unwrap_or_else(|e| e.into_inner());
    set_level(ColorLevel::TrueColor);
    // Bilinen id'ler görseldeki kimlikleri taşır.
    assert_eq!(dept_color(None), dept_color(Some("software-development"))); // main=cyan
    assert_eq!(dept_color(Some("code-review-testing")), dept_color(Some("research")).into()); // farklı
    let ids = ["software-development", "code-review-testing", "research", "youtube-content", "finance", "custom"];
    let mut seen = std::collections::HashSet::new();
    for id in ids { assert!(seen.insert(dept_color(Some(id))), "{id} rengi başkasıyla çakıştı"); }
    // Bilinmeyen id: kararlı (aynı id → aynı renk) ve palet renklerinden biri.
    let unknown1 = dept_color(Some("my-custom-dept"));
    assert_eq!(unknown1, dept_color(Some("my-custom-dept")));
    assert_ne!(unknown1, Color::Reset);
}
```

(Not: `code-review-testing` ile `research` renklerinin farklı olduğu assertion'ı gerçek eq/ne çiftleriyle yazılır — yukarıdaki `.into()` placeholder'ı implementer düzeltir: `assert_ne!(dept_color(Some("code-review-testing")), dept_color(Some("research")));`)

- [ ] **Step 2: Testin düştüğünü doğrula** — `cargo test -p yuppycode-tui department_ids` → FAIL (`dept_color` bulunamadı).

- [ ] **Step 3: Uygula** — `Cargo.toml`'a `tui-textarea = "0.7"` ekle; `theme.rs` palette bölümüne:
  - `pub const DEPT_PALETTE: [Color; 6]` — Rgb değerleriyle (aşırma matematiği için): software-development=`Rgb(0,229,238)` (cyan), code-review-testing=`Rgb(80,250,123)` (green), research=`Rgb(255,85,85)` (red), youtube-content=`Rgb(189,147,249)` (purple), finance=`Rgb(255,196,0)` (amber), custom=`Rgb(114,135,253)` (blue).
  - `pub fn dept_color(Option<&str>) -> Color`: None → software-development rengi (MAIN her zaman cyan); bilinen id → palet; bilinmeyen → `DefaultHasher` ile id'den kararlı palet indeksi.
  - `pub fn dim_rgb(Color, f32) -> Color`: Rgb kanallarını oranla kısar; Rgb olmayan girdiyi `c()`-uyumlu olduğu gibi döndürür.
  - Mono/Ansi aşırması: çağıran taraf `c()` kullanır (palette sabitleri ham kalır, mevcut desen).

- [ ] **Step 4: Testin geçtiğini doğrula** — `cargo test -p yuppycode-tui` → theme testleri PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/yuppycode-tui/Cargo.toml Cargo.lock crates/yuppycode-tui/src/theme.rs
git commit -m "feat(tui): department color palette + tui-textarea dep

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Çok satırlı composer (tui-textarea entegrasyonu)

**Files:**
- Modify: `crates/yuppycode-tui/src/app.rs` (TuiApp alanları ~line 253, handle_input ~line 1750-1826, complete_slash ~line 2617, test modülü)
- Modify: `crates/yuppycode-tui/src/view_model.rs` (ViewModel ~line 260, Default ~line 330)
- Modify: `crates/yuppycode-tui/src/render.rs` (render_cmd_bar ~line 490, draw_prompt ~line 528, prompt_height ~line 585, render_console ~line 467)

**Interfaces:**
- Consumes: `tui_textarea::Textarea<'static>` (`input(impl Into<Input>)`, `insert_newline()`, `lines() -> &[String]`, `cursor() -> (usize, usize)`, `set_lines(&[&str])`, `cursor_up/down/left/right`, `cancel_selection` yok — selection kullanılmaz).
- Produces: `TuiApp::set_input(&mut self, &str)` (tek giriş kapısı: editor'ü yeniden yazar + `model.input`'i senkronlar); `TuiApp::sync_input(&mut self)` (editor → `model.input` + `model.input_cursor`).
- Produces: `ViewModel.input_cursor: (usize, usize)` (row, col) — render caret çizer.
- Produces: `prompt_height(model, width)` çok satırı hesaba katar (satır sayısı + son satırın wrap'i, event tail'e ≥1 satır bırakmak için caller cap'ler).

- [ ] **Step 1: Failing testler yaz** — `app.rs` test modülüne (mevcut test desenini takip et: `make_test_app` benzeri helper varsa onu kullan):

```rust
#[test]
fn alt_enter_and_ctrl_j_open_a_new_line_and_enter_submits_all_lines() {
    // app kur, focus = Input; "birinci" yaz → Alt+Enter → "ikinci" yaz.
    // model.input == "birinci\nikinci"; input_cursor == (1, 6).
    // Enter → submit edilen metin iki satırı \n ile içerir; editor boşalır.
}

#[test]
fn paste_with_newlines_lands_in_the_composer_as_lines() {
    // handle_input'a crossterm Event::Paste("a\nb\nc") ver;
    // model.input üç satır olur; cursor sonda.
}

#[test]
fn set_input_is_the_single_gate_model_and_editor_stay_in_sync() {
    // app.set_input("/mission test"); model.input doğru;
    // ardından bir char key event'i → metin sonuna eklenir (editor eski buffer'da değil).
}

#[test]
fn release_key_events_are_ignored_by_the_composer() {
    // KeyEventKind::Release ile char 'x' → model.input değişmez.
}

#[test]
fn prompt_height_covers_wrapped_lines_and_keeps_the_event_tail_alive() {
    // 3 satırlık, satırları dar genişlikte wrap eden input →
    // prompt_height satır sayısı + wrap'leri sayar; render_console
    // constraint'i tail'e ≥1 satır bırakır (20 sütun terminalde dene).
}
```

- [ ] **Step 2: Testlerin düştüğünü doğrula** — `cargo test -p yuppycode-tui alt_enter` vb. → FAIL (alan/metot yok).

- [ ] **Step 3: Uygula:**
  - `TuiApp` alanı: `editor: tui_textarea::Textarea<'static>` (`Textarea::new` ile; `set_placeholder_text` yok — hint render'da).
  - `sync_input()`: `model.input = self.editor.lines().join("\n")`, `model.input_cursor = self.editor.cursor()`.
  - `set_input(&s)`: `set_lines(s.lines().collect veya [""])` + `sync_input()`.
  - `handle_input`: `Focus::Input` iken ve `key.kind != Release` iken `Alt+Enter`/`Ctrl+J` → `insert_newline()`; `Enter` → mevcut submit bloğu (`model.input` yerine `editor.lines().join("\n")`); `Backspace`/`Char`/Up/Down/Left/Right/Home/End → `self.editor.input(key)` (crossterm feature Input dönüşümü) + `sync_input()`; mevcut davranışlar korunur (Esc temizle → `set_input("")`, `/` prefill → `set_input("/")`, `complete_slash` → `set_input(&format!("{pick} "))`).
  - `Event::Paste(s)`: focus Input iken editor'e `Input`'larla değil — textarea'nın paste desteği yoksa satırlara bölüp `insert_str` benzeri uygulama; her mutasyondan sonra `sync_input()` (crossterm `Event::Paste` mevcut event döngüsünde ele alınmalı; `spawn_input_thread` bracketed paste açıksa event gelir, değilse multiline char akışı zaten satır böler — iki yol da `model.input`'te `\n` üretmeli).
  - `view_model.rs`: `input_cursor: (usize, usize)` alanı + Default `(0,0)`.
  - `render.rs` `draw_prompt`: `model.input.lines()` satırlarını çizer; caret'ı `input_cursor` konumunda (satır içinde col. karakteri ters video/highlight) çizer; hint yalnız boş inputta. `prompt_height`: `lines().len()` + her satırın width'e göre wrap'i; `render_console`/`render_cmd_bar` caller'da min 1 satır tail garantisi (Constraint hesabı) korunur.
  - Mevcut testlerin `app.model.input = "..."` yazan satırları `app.set_input("...")`'a çevrilir (tek giriş kapısı kuralı).

- [ ] **Step 4: Testlerin geçtiğini doğrula** — `cargo test -p yuppycode-tui` → tümü PASS (mevcut Türkçe input testi dahil).

- [ ] **Step 5: Commit**

```bash
git add crates/yuppycode-tui/src/app.rs crates/yuppycode-tui/src/view_model.rs crates/yuppycode-tui/src/render.rs
git commit -m "feat(tui): multiline composer via tui-textarea (Alt+Enter/Ctrl+J newline)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Departman renkli paneller + kalın çerçeveler (görseldeki imza kimlik)

**Files:**
- Modify: `crates/yuppycode-tui/src/render.rs` (render_agent_box ~658, render_agent_card ~762, render_idle_box ~843, render_board ~1090, render_dept_pills ~1298)
- Modify: `crates/yuppycode-tui/src/theme.rs` (border helper)

**Interfaces:**
- Consumes: `theme::dept_color`, `theme::dim_rgb` (Task 1); `TerminalTab.dept`, `AgentTile.dept`, `DeptRow.id` (mevcut alanlar).
- Produces: `theme::dept_border(Option<&str>, focused: bool) -> Style` — focused → BOLD palet rengi; unfocused → `dim_rgb(renk, 0.5)`.
- Produces: canlı oturum panelleri `BorderType::Thick` + departman rengi (görseldeki kalın çerçeve); idle launcher'lar Rounded kalır.

- [ ] **Step 1: Failing test yaz** — `theme.rs` test modülüne:

```rust
#[test]
fn dept_border_uses_the_department_color_and_dims_when_unfocused() {
    let _g = GUARD.lock().unwrap_or_else(|e| e.into_inner());
    set_level(ColorLevel::TrueColor);
    let focused = dept_border(Some("code-review-testing"), true);
    let idle = dept_border(Some("code-review-testing"), false);
    assert_eq!(focused.fg, Some(c(Color::Rgb(80, 250, 123))));
    assert!(focused.add_modifier.contains(Modifier::BOLD));
    assert_ne!(idle.fg, focused.fg); // kısık ton
}
```

- [ ] **Step 2: Testin düştüğünü doğrula** — `cargo test -p yuppycode-tui dept_border` → FAIL.

- [ ] **Step 3: Uygula** — `theme.rs`'e `dept_border`; render sitelerinde `theme::border_focused()/theme::border()` ikilisini `theme::dept_border(tab.dept.as_deref(), focused)` ile değiştir; başlık stilleri de dept rengini alır (focused başlık = palet rengi BOLD; mevcut `theme::header()` MAIN'te kalır). `render_agent_box`'ta canlı oturum kutusu her zaman `BorderType::Thick` alır (`promoted` yalnız başlık vurgusunu etkiler). `render_dept_pills` ve `render_board` dept satırları aynı eşleme. Ad-hoc (dept yok) paneller cyan kalır.

- [ ] **Step 4: Testin geçtiğini doğrula** — `cargo test -p yuppycode-tui` → PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/yuppycode-tui/src/render.rs crates/yuppycode-tui/src/theme.rs
git commit -m "feat(tui): department-colored thick pane borders (main cyan / test green / read red)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Canlı oturum başlığında cwd + git:[branch - diffstat] (görseldeki başlık satırı)

**Files:**
- Create: `crates/yuppycode-tui/src/gitinfo.rs` (örnekleyici + ayrıştırıcılar + arka plan thread'i)
- Modify: `crates/yuppycode-tui/src/lib.rs` (mod bildirimi)
- Modify: `crates/yuppycode-tui/src/terminals.rs` (yalnız okuma: ManagedTerminal.cwd'yi expose eden bir erişimci eklenir — PTY mantığı değişmez)
- Modify: `crates/yuppycode-tui/src/view_model.rs` (TerminalTab'a `git: Option<GitInfoView>`)
- Modify: `crates/yuppycode-tui/src/app.rs` (cache sahipliği + refresh_terminals_view doldurur + render başlığı)

**Interfaces:**
- Produces: `gitinfo::GitInfo { branch: String, changed: u32, insertions: u64, deletions: u64 }`; `gitinfo::parse_branch(&str) -> Option<String>`; `gitinfo::parse_shortstat(&str) -> Option<(u32, u64, u64)>` (files, insertions, deletions).
- Produces: `gitinfo::GitInfoCache::new() -> Self`; `watch(&self, cwd: &Path)`; `snapshot(&self, cwd: &Path) -> Option<GitInfo>`; arka planda std::thread 5 sn'de bir `git -C <cwd> rev-parse --abbrev-ref HEAD` + `git -C <cwd> diff --shortstat HEAD` + `git -C <cwd> status --porcelain` çalıştırır, Arc<Mutex<HashMap>>'a yazar; repo değilse None.
- Produces: `view_model::GitInfoView { branch, changed, insertions, deletions }` (saf veri); `TerminalTab.git: Option<GitInfoView>`.
- Consumes: `ManagedTerminal`'ın oturum cwd'si (mevcut alan; yeni `pub fn cwd(&self) -> Option<&Path>` erişimcisi).

- [ ] **Step 1: Failing testler yaz** — `gitinfo.rs` içinde:

```rust
#[test]
fn parses_a_branch_line() {
    assert_eq!(parse_branch("feat/h1-bridge\n"), Some("feat/h1-bridge".into()));
    assert_eq!(parse_branch(""), None);
}

#[test]
fn parses_a_shortstat_line() {
    // " 3 files changed, 351 insertions(+), 12 deletions(-)" → (3, 351, 12)
    assert_eq!(parse_shortstat(" 3 files changed, 351 insertions(+), 12 deletions(-)"), Some((3, 351, 12)));
    assert_eq!(parse_shortstat(""), Some((0, 0, 0))); // temiz ağaç: boş çıktı → sıfırlar
}

#[test]
fn samples_a_real_temp_repo() {
    // tempfile ile repo kur: git init, commit, bir dosya değiştir →
    // sample(&dir) branch="main|master", changed>=1, insertions>=1 döner.
}
```

ve `app.rs` test modülünde: başlık formatı testi — `git` dolu bir tab'da kutu başlığı `git:[branch - N files changed, +I -D]` içerir (render düzeyinde span metni).

- [ ] **Step 2: Testlerin düştüğünü doğrula** — `cargo test -p yuppycode-tui gitinfo` → FAIL (modül yok).

- [ ] **Step 3: Uygula** — `gitinfo.rs` (std::process::Command, 5 sn loop, cwd seti Arc<Mutex<HashSet>>; git yok/repo yok → None, hata asla UI'ya sızmaz); `app.rs`'te TuiApp alanı `git_cache: gitinfo::GitInfoCache`, oturum açılınca `watch`, `refresh_terminals_view`'te `TerminalTab.git` doldurulur; `render.rs::render_agent_box` başlığa ` · git:[{branch} - {N} files changed, +{I} -{D}]` ekler (değişiklik 0 ise yalnız branch).

- [ ] **Step 4: Testlerin geçtiğini doğrula** — `cargo test -p yuppycode-tui` → PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/yuppycode-tui/src/gitinfo.rs crates/yuppycode-tui/src/lib.rs crates/yuppycode-tui/src/terminals.rs crates/yuppycode-tui/src/view_model.rs crates/yuppycode-tui/src/app.rs crates/yuppycode-tui/src/render.rs
git commit -m "feat(tui): live session headers with cwd git branch + diffstat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Tam doğrulama (fmt + check + tüm testler)

**Files:** değişiklik yok — doğrulama.

- [ ] **Step 1:** `cargo fmt --all` — diff yoksa bitti; varsa biçimlendir.
- [ ] **Step 2:** `cargo check --workspace` → hatasız.
- [ ] **Step 3:** `cargo test --workspace` → tümü PASS; hata varsa düzelt-yeniden koş (Task sahibi olduğun dosyalardaki kırılmaları sen düzeltirsin).
- [ ] **Step 4:** `cargo clippy -p yuppycode-tui -- -D warnings` (toolchain'de kurulu; temiz değilse yalnız kendi satırlarını düzelt).
- [ ] **Step 5:** Son commit'ler temiz; `git log --oneline -3` raporla.
