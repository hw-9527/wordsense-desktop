use super::SelectionPayload;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{OnceLock, mpsc};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

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
/// 本次左键按下时是否命中查词按钮。
/// 按下瞬间窗口仍处于按钮状态（命中区尚未被 showPanel 清除），判定可靠；
/// 以此把"点击按钮"的整个 down/up 手势与普通点击区分开。
static DOWN_ON_BUTTON: AtomicBool = AtomicBool::new(false);

// ── Mouse hook (runs in a dedicated thread with its own message loop) ───────

#[cfg(target_os = "windows")]
mod hook {
    use super::*;
    use super::super::is_click_on_button;
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
                // 按下瞬间判定按钮命中（此刻窗口仍是按钮尺寸/位置，
                // 命中区未被 showPanel 的弹出流程清除，判定可靠）
                DOWN_ON_BUTTON.store(
                    is_click_on_button(data.pt_x as f64, data.pt_y as f64),
                    Ordering::SeqCst,
                );
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

/// IUIAutomation 实例缓存：MTA 下跨线程共享接口指针是合法的，
/// 省去每次取词的 CoCreateInstance 冷启动（首次查询提速明显）。
struct UiaClient(IUIAutomation);
unsafe impl Send for UiaClient {}
unsafe impl Sync for UiaClient {}
static UIA_CACHE: OnceLock<Option<UiaClient>> = OnceLock::new();

fn uia_instance() -> Option<&'static IUIAutomation> {
    UIA_CACHE
        .get_or_init(|| {
            unsafe {
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                    .ok()
                    .map(UiaClient)
            }
        })
        .as_ref()
        .map(|c| &c.0)
}

#[cfg(target_os = "windows")]
fn get_selected_text_uia(
    scale: f64,
) -> Option<(String, String, Option<(f64, f64, f64, f64)>)> {
    use windows::Win32::System::Com::*;
    use windows::Win32::UI::Accessibility::*;

    unsafe {
        // 使用 COM 的线程必须加入 apartment（MTA 幂等、廉价）。
        // UIA 客户端推荐 MTA：monitor 线程没有消息泵，STA 下跨 apartment 调用
        // （如目标应用挂起时）会卡住甚至死锁。
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let uia = uia_instance()?;

        let focused = uia.GetFocusedElement().ok()?;

        // Try TextPattern first (richest source of selection info)
        let text_pattern = focused
            .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            .ok()?;

        let ranges = text_pattern.GetSelection().ok()?;
        let count = ranges.Length().ok()?;
        if count == 0 {
            return None;
        }
        let range = ranges.GetElement(0).ok()?;
        let bstr = range.GetText(500).ok()?;
        let text = bstr.to_string();
        if text.trim().is_empty() {
            return None;
        }

        // 选区的屏幕包围盒（逻辑坐标），供前端精确锚定按钮/面板
        let bounds = selection_bounds(&range, scale);

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

        return Some((text, context, bounds));
    }
}

/// 选区的屏幕包围盒。UIA 返回物理像素（VT_R8 数组：[left, top, w, h] × N，
/// 跨行选区会有多个矩形），这里合并为包围盒并换算为逻辑坐标，
/// 与前端 showButton/showPanel 的定位逻辑保持同一坐标系。
fn selection_bounds(
    range: &windows::Win32::UI::Accessibility::IUIAutomationTextRange,
    scale: f64,
) -> Option<(f64, f64, f64, f64)> {
    use windows::Win32::System::Ole::SafeArrayDestroy;

    if scale <= 0.0 {
        return None;
    }
    unsafe {
        let arr = range.GetBoundingRectangles().ok()?;
        let sa = &*arr;
        let n = sa.rgsabound[0].cElements as usize;
        let result = if n > 0 {
            let data = std::slice::from_raw_parts(sa.pvData as *const f64, n);
            let mut l = f64::MAX;
            let mut t = f64::MAX;
            let mut r = f64::MIN;
            let mut b = f64::MIN;
            for rect in data.chunks_exact(4) {
                l = l.min(rect[0]);
                t = t.min(rect[1]);
                r = r.max(rect[0] + rect[2]);
                b = b.max(rect[1] + rect[3]);
            }
            if r > l && b > t {
                Some((l / scale, t / scale, (r - l) / scale, (b - t) / scale))
            } else {
                None
            }
        } else {
            None
        };
        let _ = SafeArrayDestroy(arr);
        result
    }
}

// ── Copy-based lookup (user-initiated only) ─────────────────────────────────
//
// 约束：模拟 Ctrl+C 只允许发生在"用户点击查词按钮"之后（用户主动触发）。
// 选中文本而不点按钮时绝不注入按键；monitor 的自动取词路径不含任何注入。

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

/// 用户点击查词按钮后的主动复制取词：
/// 等待左键释放 → 备份剪贴板 → Ctrl+C → 读回并与备份比对（不同才算
/// 复制生效，最多重试 3 次）→ 恢复备份 → 返回选中文本。
/// 注意：必须在阻塞线程池中执行（调用方用 spawn_blocking）——
/// 不能在 Tauri 主线程跑，否则 sleep 会冻结 STA 消息泵，
/// 目标应用写剪贴板（延迟渲染）会被卡住导致读到旧内容。
pub fn copy_text_via_clipboard() -> Result<String, String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    unsafe {
        if is_terminal_window() {
            return Err("终端窗口不支持复制取词".to_string());
        }
        // 前端 mousedown 即触发本调用，此刻用户的物理左键可能仍按着：
        // 目标应用处于左键拖动模态时会忽略 Ctrl+C。等它松开再注入
        // （上限 ~600ms 防死等）。
        let start = std::time::Instant::now();
        while GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 {
            if start.elapsed() > std::time::Duration::from_millis(600) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    // 备份现有剪贴板文本；None = 原内容不是文本（图片等），
    // arboard 无法做任意格式恢复，此时复制结果会留在剪贴板（已知取舍）。
    let backup = cb.get_text().ok();
    let backup_trimmed = backup.as_ref().map(|s| s.trim().to_string());

    // 最多尝试 3 次 Ctrl+C：读回内容必须与备份不同（trim 后）才算复制
    // 生效——读到备份 = 复制未生效（应用未响应/时序），重试。
    for _ in 0..3 {
        unsafe {
            if !send_ctrl_c() {
                return Err("无法模拟复制操作".to_string());
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(150));

        let read = cb.get_text().ok().map(|t| t.trim().to_string());
        if let Some(t) = read {
            if !t.is_empty() {
                let differs = match &backup_trimmed {
                    Some(b) => &t != b,
                    None => true,
                };
                if differs {
                    // 恢复原剪贴板（仅当原内容是文本），把这次取词对
                    // 用户剪贴板的影响降为零
                    if let Some(prev) = &backup {
                        let _ = cb.set_text(prev.as_str());
                    }
                    return Ok(t);
                }
            }
        }
    }

    // 全部尝试失败：恢复备份后明确报错，绝不拿旧剪贴板内容当查询词
    if let Some(prev) = &backup {
        let _ = cb.set_text(prev.as_str());
    }
    Err("未能复制到选中的文本（该应用可能不支持复制）".to_string())
}

/// 按下点（物理坐标）是否落在前台窗口的客户区内。
/// 用于 UIA 失败时决定是否弹出"复制模式"按钮：标题栏/边框拖动等
/// 非客户区手势不是文本选择，不弹，避免拖动窗口时误扰。
/// 判定失败（无前台窗口等）时放行。
unsafe fn is_down_in_client_area(phys_x: i32, phys_y: i32) -> bool {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetForegroundWindow};

    let hwnd = GetForegroundWindow();
    if hwnd.0.is_null() {
        return true;
    }
    let mut rect = windows::Win32::Foundation::RECT::default();
    if GetClientRect(hwnd, &mut rect).is_err() {
        return true;
    }
    let mut tl = POINT { x: rect.left, y: rect.top };
    let mut br = POINT { x: rect.right, y: rect.bottom };
    if !ClientToScreen(hwnd, &mut tl).as_bool() || !ClientToScreen(hwnd, &mut br).as_bool() {
        return true;
    }
    phys_x >= tl.x && phys_x <= br.x && phys_y >= tl.y && phys_y <= br.y
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

    // 面板所在显示器的缩放比：用于把 hook 的物理坐标换算为逻辑坐标
    // （前端 showButton/showPanel 的定位逻辑统一工作在逻辑坐标系）。
    let scale = app_handle
        .get_webview_window("panel")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);

    loop {
        std::thread::sleep(std::time::Duration::from_millis(20));

        if MOUSE_UP_DETECTED.swap(false, Ordering::SeqCst) {
            let up_x = MOUSE_X.load(Ordering::SeqCst);
            let up_y = MOUSE_Y.load(Ordering::SeqCst);
            let mx = up_x as f64;
            let my = up_y as f64;

            // ── 本次按下命中了查词按钮 → 整个 down/up 是"查词手势" ──
            // 前端 mousedown 已触发查词并弹出面板（窗口可能正处于
            // 移动/缩放的中间态：按钮命中区已被清、面板可能尚未覆盖
            // 点击处）。此时无论窗口什么状态都不得再判定：不取词、
            // 不清除、不注入——否则刚弹出的面板会被这次收尾清掉。
            // （trigger-lookup 对 Windows 是兜底：正常由前端 mousedown
            //   直接触发；此处补发以兼容 mousedown 未到达的异常情形。）
            if DOWN_ON_BUTTON.swap(false, Ordering::SeqCst) {
                LAST_TRIGGER_MS.store(unix_ms(), Ordering::SeqCst);
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

            // 取词可能被挂起/慢响应的应用长时间阻塞（UIA 调用本身无超时），
            // 放到独立线程执行，monitor 用 recv_timeout 兜底，避免检测链路卡死。
            // 仅 UIA：无剪贴板兜底（注入按键方案已按用户要求移除）。
            // 提速：mouseup 时选区通常已就绪，先立即查询；拿不到再短等
            // 120ms 重试一次（替代原先固定 200ms sleep，命中时省 ~200ms）。
            let (tx, rx) = mpsc::channel();
            let ui_scale = scale;
            std::thread::spawn(move || {
                let result = match get_selected_text_uia(ui_scale) {
                    Some(v) => Some(v),
                    None => {
                        std::thread::sleep(std::time::Duration::from_millis(120));
                        get_selected_text_uia(ui_scale)
                    }
                };
                let _ = tx.send(result);
            });

            match rx.recv_timeout(std::time::Duration::from_millis(1200)) {
                Ok(Some((text, context, bounds))) => {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() && trimmed.len() <= 400 && trimmed.chars().any(|c| c.is_alphanumeric()) {
                        let (bounds_x, bounds_y, bounds_w, bounds_h) = match bounds {
                            Some((x, y, w, h)) => (Some(x), Some(y), Some(w), Some(h)),
                            None => (None, None, None, None),
                        };
                        let payload = SelectionPayload {
                            text: trimmed.to_string(),
                            context,
                            // 前端定位逻辑工作在逻辑坐标系，这里换算
                            mouse_x: mx / scale,
                            mouse_y: my / scale,
                            bounds_x,
                            bounds_y,
                            bounds_w,
                            bounds_h,
                            needs_copy: false,
                        };
                        log::info!("Selection detected: {:?}", payload.text);
                        let _ = app_handle.emit("selection-detected", &payload);
                        last_emitted = std::time::Instant::now();
                    } else {
                        let _ = app_handle.emit("selection-cleared", ());
                    }
                }
                Ok(None) => {
                    // UIA 取词失败（自绘 UI 应用，如 PDF/微信）：
                    // 拖选/双击手势已发生，弹出"复制模式"占位按钮——
                    // 用户点击按钮时才模拟 Ctrl+C 复制取词（用户主动触发），
                    // 不点击则什么都不做，按钮随点击外部/超时正常消失。
                    // 客户区过滤：down 点不在前台窗口客户区（标题栏/边框
                    // 拖动等非文本选择手势）不弹。
                    if unsafe { is_down_in_client_area(down_x, down_y) } {
                        let payload = SelectionPayload {
                            text: String::new(),
                            context: String::new(),
                            mouse_x: mx / scale,
                            mouse_y: my / scale,
                            bounds_x: None,
                            bounds_y: None,
                            bounds_w: None,
                            bounds_h: None,
                            needs_copy: true,
                        };
                        log::info!("UIA lookup failed, offering copy-lookup button");
                        let _ = app_handle.emit("selection-detected", &payload);
                        last_emitted = std::time::Instant::now();
                    } else {
                        let _ = app_handle.emit("selection-cleared", ());
                    }
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
