# 词境 WordSense (wordsense-desktop)

System-wide text-selection → AI dictionary popup (PopClip-like), built with Tauri v2 + vanilla JS for macOS & Windows.

## Project

- Stack: Tauri v2 (Rust) backend + plain ES-module JS frontend (Vite 6, no framework, no TypeScript).
- Two webview windows defined in `src-tauri/tauri.conf.json`:
  - `panel` → `index.html`: frameless, transparent, always-on-top, hidden at launch. Two modes: small pill button (≤160px logical width) ↔ full panel (380×480).
  - `settings` → `settings.html`: hidden until opened from tray.
- Rust entry: `src-tauri/src/main.rs` → `lib.rs::run()` (tray, command registration, spawns selection monitor thread).
- AI lookups go to any OpenAI-compatible `/chat/completions` endpoint via `@tauri-apps/plugin-http` (bypasses CORS).

## Commands

- `npm install` — install frontend deps
- `npm run tauri dev` — full app dev mode (auto-runs Vite on port 5173, strictPort)
- `npm run tauri build` — release bundle → `src-tauri/target/release/bundle/`
- `npm run dev` / `npm run build` — frontend only (Vite serve / build to `dist/`)
- `cargo check` (run inside `src-tauri/`) — quick Rust compile check; macOS-only deps are `#[cfg]`-gated out on Windows
- CI: `.github/workflows/build.yml` — on push/PR builds Windows NSIS/MSI (Node 22 + stable Rust, `npm run tauri build`), uploads `src-tauri/target/release/bundle/**`
- No tests, linters, or formatters are configured.

## Architecture

- `src-tauri/src/lib.rs` — tray menu (left-click opens settings), Tauri commands (`show_panel_at`, `hide_panel`, `open_settings`), per-OS non-activating panel setup, starts selection monitor thread. Registers `single-instance` (2nd launch → focus existing settings window) and `global-shortcut`; the settings window's `×` is intercepted (`CloseRequested` → hide, not destroy) and rebuilt if ever gone.
- `src-tauri/src/selection/` — OS-global selection detection. `mod.rs` = abstraction + `SelectionPayload` + Rust-side floating-button hit test (static `Mutex<Option<ButtonRect>>`, ±8px margin). `macos.rs` = Accessibility API; `windows.rs` = low-level mouse hook + UI Automation `ITextPattern`. Emits payload event to the `panel` window.
- `src/main.js` — panel window state machine (`button` | `panel` | `hidden`), selection event handling, DPI-aware dragging.
- `src/lookup.js` — API call + retry + two-level cache (memory `Map` + plugin-store `cache.json`, 7-day TTL), in-flight dedup.
- `src/lib/core.js` — pure functions (`buildPrompt`, `parseLlmJson`, settings defaults); deliberately free of Tauri imports — it is kept in sync with a browser-extension copy.
- `src/panel.js` / `src/settings.js` — panel rendering / settings UI.

## Conventions

- UI text, comments, and the AI prompt/output are Simplified Chinese. The LLM must return the strict JSON schema defined in `buildPrompt` (`src/lib/core.js`); `parseLlmJson` tolerates fences/BOM/trailing commas.
- Frontend: vanilla JS, 2-space indent, single quotes — match existing style (no linter).
- Rust: commands return `Result<T, String>` via `.map_err(|e| e.to_string())`; diagnostics via `log::info!`/`warn!`; platform code strictly behind `#[cfg(target_os = ...)]`.
- DPI: logical vs physical pixels matter everywhere (Retina/HiDPI scaling); button hit-testing is done in Rust using logical px.
- Settings persist on the frontend via tauri-plugin-store (`settings.json` store) — `src-tauri/src/config.rs` is currently unreferenced/legacy; don't assume it is wired up.
- Tauri permissions live in `src-tauri/capabilities/default.json`; new plugins/commands must be allowed there.

## Notes

- Root-level `test_*.js`, `test_*.swift`, `inspect_ax.swift` are scratch experiments, not part of the build — leave them alone / keep out of feature diffs.
- `.gitignore` covers `node_modules/`, `dist/`, `src-tauri/target/`, `.DS_Store`, `.reasonix/`, `reasonix.toml`.
- Declared but currently unused: `arboard` (Rust clipboard), global-shortcut (plugin registered in `lib.rs` + permissions granted in capabilities, but no shortcut is registered in JS or Rust). Reuse them before adding equivalents.
- PowerShell console may mojibake UTF-8 Chinese in source files — files themselves are fine; prefer file tools over `Get-Content` when encoding matters.
- 本机编译：msys64 的 mingw64 gcc 工具链完整可用（rustup default 为 windows-gnu），`cargo check` 可通过。但项目路径含中文 `E:\下载\` 会让 mingw ld 报 `cannot find *.rlib`；`subst` 盘符映射无效（rustc/cargo 会把路径 canonicalize 回真实路径）。可行做法：把 `src-tauri`（排除 `target/`）复制到纯 ASCII 路径（如 `%TEMP%\wordsense-check`）再 `cargo check`（约 2 分钟）。更彻底的修复：装 VS Build Tools 后 `rustup default stable-x86_64-pc-windows-msvc`。`src-tauri/target/release` 里的 `.dylib` 是 macOS 产物，不代表本机构建过。
