use super::SelectionPayload;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};

// ── Global state for the low-level mouse hook callback ──────────────────────

static MOUSE_UP_DETECTED: AtomicBool = AtomicBool::new(false);
static MOUSE_X: AtomicI32 = AtomicI32::new(0);
static MOUSE_Y: AtomicI32 = AtomicI32::new(0);
static MOUSE_DOWN_X: AtomicI32 = AtomicI32::new(0);
static MOUSE_DOWN_Y: AtomicI32 = AtomicI32::new(0);
static LAST_UP_MS: AtomicU64 = AtomicU64::new(0);
static LAST_UP_X: AtomicI32 = AtomicI32::new(0);
static LAST_UP_Y: AtomicI32 = AtomicI32::new(0);
/// 最近一次 trigger-lookup（点击按钮查词）的时间戳。
/// 面板弹出过渡期内（800ms），同一次点击的收尾不应把刚弹出的面板清掉。
static LAST_TRIGGER_MS: AtomicU64 = AtomicU64::new(0);

// ── Mouse hook (runs in a dedicated thread with its own message loop) ───────

#[cfg(target_os = "windows")]
mod hook {
    use super::*;
    use windows::Win32::Foundation::*;
    use windows::Win32::UI::WindowsAndMessaging::*;

    /// Raw MSLLHOOKSTRUCT layout – only the fields we need.
    #[repr(C)]
    struct MsllHookStruct {
        pt_x: i32,
        pt_y: i32,
        // remaining fields are unused
    }

    pub(super) unsafe extern "system" fn mouse_hook_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code >= 0 {
            let data = &*(lparam.0 as *const MsllHookStruct);
            if wparam.0 == WM_LBUTTONDOWN as usize {
                MOUSE_DOWN_X.store(data.pt_x, Ordering::SeqCst);
                MOUSE_DOWN_Y.store(data.pt_y, Ordering::SeqCst);
            } else if wparam.0 == WM_LBUTTONUP as usize {
                MOUSE_X.store(data.pt_x, Ordering::SeqCst);
                MOUSE_Y.store(data.pt_y, Ordering::SeqCst);
                MOUSE_UP_DETECTED.store(true, Ordering::SeqCst);
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    /// Installs a system-wide low-level mouse hook and runs a Windows
    /// message loop to keep it alive. **Blocks forever.**
    pub(super) fn run_hook_loop() {
        unsafe {
            let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), None, 0)
                .expect("Failed to install low-level mouse hook");

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = UnhookWindowsHookEx(hook);
        }
    }
}

// ── UI Automation: read selected text from the focused element ──────────────

#[cfg(target_os = "windows")]
fn get_selected_text_uia() -> Option<(String, String)> {
    use windows::Win32::System::Com::*;
    use windows::Win32::UI::Accessibility::*;

    unsafe {
        // COM must be initialised on this thread.
        // UIA 客户端推荐 MTA：monitor 线程没有消息泵，STA 下跨 apartment 调用
        // （如目标应用挂起时）会卡住甚至死锁。
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let uia: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;

        let focused = uia.GetFocusedElement().ok()?;

        // Try TextPattern first (richest source of selection info)
        let pattern = focused
            .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            .ok();

        if let Some(text_pattern) = pattern {
            let ranges = text_pattern.GetSelection().ok()?;
            let count = ranges.Length().ok()?;
            if count > 0 {
                let range = ranges.GetElement(0).ok()?;
                let bstr = range.GetText(500).ok()?;
                let text = bstr.to_string();
                if text.trim().is_empty() {
                    return None;
                }

                // Context: clone the selection range, expand it to the
                // enclosing paragraph, then extract a sentence-level window
                // around the selection (mirrors the macOS implementation).
                let mut context = String::new();

                if let Ok(para) = range.Clone() {
                    if para.ExpandToEnclosingUnit(TextUnit_Paragraph).is_ok() {
                        if let Ok(para_bstr) = para.GetText(1200) {
                            let para_text = para_bstr.to_string();
                            if !para_text.trim().is_empty() {
                                context = extract_context_around(&para_text, &text);
                            }
                        }
                    }
                }

                // Fallback: widen the selection itself by ±150 characters
                if context.trim().is_empty() {
                    if let Ok(ext) = range.Clone() {
                        let _ = ext.MoveEndpointByUnit(
                            TextPatternRangeEndpoint_Start,
                            TextUnit_Character,
                            -150,
                        );
                        let _ = ext.MoveEndpointByUnit(
                            TextPatternRangeEndpoint_End,
                            TextUnit_Character,
                            150,
                        );
                        if let Ok(ext_bstr) = ext.GetText(600) {
                            let s = ext_bstr.to_string();
                            if !s.trim().is_empty() {
                                context = truncate_chars(s.trim(), 400);
                            }
                        }
                    }
                }

                return Some((text, context));
            }
        }

        // UIA 拿不到选区（自绘 UI 的应用没有 TextPattern）：返回 None，
        // 由调用方的剪贴板兜底（clipboard_fallback_text）接管。
        None
    }
}

// ── Clipboard fallback: for self-drawn-UI apps without UIA TextPattern ─────

/// 模拟一次 Ctrl+C，把前台应用的当前选区复制进剪贴板。
unsafe fn send_ctrl_c() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL,
    };

    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };

    let inputs = [
        key(VK_CONTROL, false),
        key(VIRTUAL_KEY(b'C' as u16), false),
        key(VIRTUAL_KEY(b'C' as u16), true),
        key(VK_CONTROL, true),
    ];
    let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    sent == inputs.len() as u32
}

/// 终端类窗口黑名单：Ctrl+C 在终端里是 SIGINT，绝不能模拟。
unsafe fn is_terminal_window() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow};

    const BLACKLIST: [&str; 4] = [
        "ConsoleWindowClass",            // conhost（cmd / 旧版控制台）
        "CASCADIA_HOSTING_WINDOW_CLASS", // Windows Terminal
        "mintty",                        // Git Bash / Cygwin
        "PuTTY",                         // PuTTY
    ];

    let hwnd = GetForegroundWindow();
    if hwnd.0.is_null() {
        return false;
    }
    let mut buf = [0u16; 64];
    let n = GetClassNameW(hwnd, &mut buf);
    if n <= 0 {
        return false;
    }
    let class = String::from_utf16_lossy(&buf[..n as usize]);
    BLACKLIST.iter().any(|c| class.eq_ignore_ascii_case(c))
}

/// 剪贴板兜底：备份现有剪贴板 → Ctrl+C → 读回 → 恢复 → 比对。
/// 仅当读到的文本与备份不同（确实是刚复制出来的新内容）时才视为选中文本。
fn clipboard_fallback_text() -> Option<String> {
    let mut cb = arboard::Clipboard::new().ok()?;
    // 备份现有剪贴板文本；None = 原内容不是文本（图片/文件等），arboard 无法
    // 做任意格式的字节级恢复，此时 Ctrl+C 的结果会留在剪贴板（已知取舍）。
    let backup = cb.get_text().ok();

    unsafe {
        if !send_ctrl_c() {
            log::warn!("[ClipboardFallback] SendInput failed");
            return None;
        }
    }
    // 给目标应用一点时间响应 Ctrl+C 并写入剪贴板
    std::thread::sleep(std::time::Duration::from_millis(150));

    let text = match cb.get_text() {
        Ok(t) => t,
        Err(_) => {
            log::info!("[ClipboardFallback] no text after Ctrl+C");
            return None;
        }
    };

    // 恢复原剪贴板（仅当原内容是文本）
    if let Some(prev) = &backup {
        let _ = cb.set_text(prev.as_str());
    }

    let text = text.trim().to_string();
    if text.is_empty() || backup.as_deref() == Some(text.as_str()) {
        // 没有新内容：应用不支持复制选区，或根本没有选区
        log::info!("[ClipboardFallback] clipboard unchanged, giving up");
        return None;
    }
    log::info!("[ClipboardFallback] got text: {:?}", truncate_chars(&text, 40));
    Some(text)
}

/// 完整取词：先 UIA（TextPattern，覆盖浏览器/Office/WPF），失败则剪贴板兜底
/// （覆盖 PDF 阅读器、聊天软件等自绘 UI）。剪贴板路径没有 UIA 上下文，返回空串。
fn detect_selection() -> Option<(String, String)> {
    if let Some((text, context)) = get_selected_text_uia() {
        return Some((text, context));
    }

    unsafe {
        if is_terminal_window() {
            log::info!("[ClipboardFallback] skipped: terminal window");
            return None;
        }
    }

    clipboard_fallback_text().map(|text| (text, String::new()))
}

/// 在 full_text 中定位 target，向前/向后寻找句子边界标点，提取句子级上下文。
/// 与 macOS 版 `extract_sentence_context` 算法保持一致，且全程 UTF-8 安全。
fn extract_context_around(full_text: &str, target: &str) -> String {
    let idx = match full_text.find(target) {
        Some(i) => i,
        None => {
            // 选区不在段落文本中（如渲染差异），退回整段截断
            return truncate_chars(full_text.trim(), 400);
        }
    };

    let target_end = idx + target.len();
    let bytes = full_text.as_bytes();
    let max_span = 320usize;

    // 向前寻找句子起始标点（. ! ? ; : 换行）
    let mut start = idx;
    while start > 0 && idx - start < max_span {
        let b = bytes[start - 1];
        if matches!(b, b'.' | b'!' | b'?' | b';' | b':' | b'\n' | b'\r') {
            break;
        }
        start -= 1;
    }

    // 向后寻找句子结束标点
    let mut end = target_end;
    while end < bytes.len() && end - idx < max_span {
        let b = bytes[end];
        if matches!(b, b'.' | b'!' | b'?' | b';' | b':' | b'\n' | b'\r') {
            end += 1;
            break;
        }
        end += 1;
    }

    // 截取过短时，直接取选区前后一段字符
    if end - start < 30 {
        start = idx.saturating_sub(120);
        end = (target_end + 150).min(bytes.len());
    }

    // 对齐到 UTF-8 字符边界，避免多字节字符（如中文）切片 panic
    while start > 0 && !full_text.is_char_boundary(start) {
        start -= 1;
    }
    while end < full_text.len() && !full_text.is_char_boundary(end) {
        end += 1;
    }

    full_text[start..end].trim().to_string()
}

/// 按字符数（而非字节数）截断字符串
fn truncate_chars(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

/// 当前 Unix 毫秒时间戳（用于双击间隔判定）
fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 判断屏幕物理坐标是否落在词境自身 panel 窗口矩形内。
/// 用于忽略面板内部的点击/拖动（如拖动标题栏移动面板），
/// 避免误触发取词、误清按钮。
fn is_click_in_app_window(app: &AppHandle, mx: f64, my: f64) -> bool {
    if let Some(panel) = app.get_webview_window("panel") {
        if let (Ok(pos), Ok(size)) = (panel.outer_position(), panel.outer_size()) {
            let x = pos.x as f64;
            let y = pos.y as f64;
            let w = size.width as f64;
            let h = size.height as f64;
            return mx >= x && mx <= x + w && my >= y && my <= y + h;
        }
    }
    false
}

// ── Monitor loop ────────────────────────────────────────────────────────────

pub fn start_monitor(app_handle: AppHandle) {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime;

    // Spin up the hook message-loop on its own thread
    std::thread::spawn(|| {
        #[cfg(target_os = "windows")]
        hook::run_hook_loop();
    });

    let mut last_emitted = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(1))
        .unwrap();

    loop {
        std::thread::sleep(std::time::Duration::from_millis(50));

        if MOUSE_UP_DETECTED.swap(false, Ordering::SeqCst) {
            let up_x = MOUSE_X.load(Ordering::SeqCst);
            let up_y = MOUSE_Y.load(Ordering::SeqCst);
            let mx = up_x as f64;
            let my = up_y as f64;

            // ── 优先检测：点击是否落在浮动按钮区域 ──
            if super::is_click_on_button(mx, my) {
                LAST_TRIGGER_MS.store(unix_ms(), Ordering::SeqCst);
                log::info!("Click on button detected at ({}, {}), triggering lookup", mx, my);
                let _ = app_handle.emit("trigger-lookup", ());
                continue;
            }

            // ── 词境窗口内部（面板内点击/拖动标题栏）→ 完全忽略 ──
            if is_click_in_app_window(&app_handle, mx, my) {
                continue;
            }

            // ── 手势判定：只有拖选 / 双击才可能产生新选区 ──
            // 普通单击不取词、不模拟按键，但立即清除悬浮按钮/面板：
            // 用户点击了别处 = 注意力已转移，交互应当即时响应。
            // （上一版单击完全跳过，导致按钮要等 6 秒超时才消失。）
            let now_ms = unix_ms();
            let last_up_ms = LAST_UP_MS.swap(now_ms, Ordering::SeqCst);
            let last_up_x = LAST_UP_X.swap(up_x, Ordering::SeqCst);
            let last_up_y = LAST_UP_Y.swap(up_y, Ordering::SeqCst);
            let down_x = MOUSE_DOWN_X.load(Ordering::SeqCst);
            let down_y = MOUSE_DOWN_Y.load(Ordering::SeqCst);

            const MOVE_THRESHOLD: i32 = 8; // 物理像素
            let dragged = (up_x - down_x).abs() > MOVE_THRESHOLD
                || (up_y - down_y).abs() > MOVE_THRESHOLD;
            let dbl_time_ms = unsafe { GetDoubleClickTime() } as u64;
            let double_clicked = last_up_ms != 0
                && now_ms >= last_up_ms
                && now_ms - last_up_ms < dbl_time_ms
                && (up_x - last_up_x).abs() <= MOVE_THRESHOLD
                && (up_y - last_up_y).abs() <= MOVE_THRESHOLD;
            if !dragged && !double_clicked {
                // 点击按钮触发的查词：面板从按钮位置移动/缩放到面板位置
                // 需要数百毫秒（setSize + show_panel_at 清除按钮命中区），
                // 同一次点击的 mouseup 收尾可能落在这段过渡期里——此时
                // 按钮命中区已清、面板窗口可能尚未覆盖点击处，会被误判
                // 成"点击了外部"而把刚弹出的面板立即清掉（闪一下就消失）。
                // 因此 trigger-lookup 后 800ms 内的单击一律豁免。
                let trig = LAST_TRIGGER_MS.load(Ordering::SeqCst);
                if trig != 0 && now_ms >= trig && now_ms - trig < 800 {
                    continue;
                }
                let _ = app_handle.emit("selection-cleared", ()); // 立即收起按钮/面板
                continue; // 普通单击：不产生新选区
            }

            // Debounce
            if last_emitted.elapsed() < std::time::Duration::from_millis(400) {
                continue;
            }

            // Let the OS finish updating the selection
            std::thread::sleep(std::time::Duration::from_millis(200));

            // 取词可能被挂起/慢响应的应用长时间阻塞（UIA 调用本身无超时），
            // 放到独立线程执行，monitor 用 recv_timeout 兜底，避免检测链路卡死。
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(detect_selection());
            });

            match rx.recv_timeout(std::time::Duration::from_millis(1200)) {
                Ok(Some((text, context))) => {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() && trimmed.len() <= 400 && trimmed.chars().any(|c| c.is_alphanumeric()) {
                        let payload = SelectionPayload {
                            text: trimmed.to_string(),
                            context,
                            mouse_x: mx,
                            mouse_y: my,
                            bounds_x: None,
                            bounds_y: None,
                            bounds_w: None,
                            bounds_h: None,
                        };
                        log::info!("Selection detected: {:?}", payload.text);
                        let _ = app_handle.emit("selection-detected", &payload);
                        last_emitted = std::time::Instant::now();
                    } else {
                        let _ = app_handle.emit("selection-cleared", ());
                    }
                }
                Ok(None) => {
                    let _ = app_handle.emit("selection-cleared", ());
                }
                Err(_) => {
                    // 取词超时（目标应用挂起或 UIA provider 无响应）：
                    // 不 emit，保持现状，等下一次交互重新判定。
                    log::warn!("Selection detection timed out");
                }
            }
        }
    }
}
