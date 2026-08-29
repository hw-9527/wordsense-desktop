use super::SelectionPayload;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use tauri::{AppHandle, Emitter};

// ── Global state for the low-level mouse hook callback ──────────────────────

static MOUSE_UP_DETECTED: AtomicBool = AtomicBool::new(false);
static MOUSE_X: AtomicI32 = AtomicI32::new(0);
static MOUSE_Y: AtomicI32 = AtomicI32::new(0);

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
        if code >= 0 && wparam.0 == WM_LBUTTONUP as usize {
            let data = &*(lparam.0 as *const MsllHookStruct);
            MOUSE_X.store(data.pt_x, Ordering::SeqCst);
            MOUSE_Y.store(data.pt_y, Ordering::SeqCst);
            MOUSE_UP_DETECTED.store(true, Ordering::SeqCst);
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
        // COM must be initialised on this thread
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

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

                // Context: try to read the whole document text (capped)
                let mut context = String::new();
                if let Ok(doc_range) = text_pattern.DocumentRange() {
                    if let Ok(full_bstr) = doc_range.GetText(600) {
                        let full = full_bstr.to_string();
                        if let Some(idx) = full.find(&text) {
                            let start = idx.saturating_sub(150);
                            let end = (idx + text.len() + 150).min(full.len());
                            context = full[start..end].to_string();
                        }
                    }
                }
                return Some((text, context));
            }
        }

        // Fallback: ValuePattern (e.g. single-line text boxes)
        let val_pattern = focused
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .ok();
        if let Some(vp) = val_pattern {
            if let Ok(bstr) = vp.CurrentValue() {
                let full = bstr.to_string();
                if !full.trim().is_empty() {
                    // We can't tell exactly what is *selected*, but we return
                    // the value so the frontend can fall back to clipboard.
                    return None; // prefer not to guess
                }
            }
        }

        None
    }
}

// ── Monitor loop ────────────────────────────────────────────────────────────

pub fn start_monitor(app_handle: AppHandle) {
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
            // Debounce
            if last_emitted.elapsed() < std::time::Duration::from_millis(400) {
                continue;
            }

            // Let the OS finish updating the selection
            std::thread::sleep(std::time::Duration::from_millis(200));

            let mx = MOUSE_X.load(Ordering::SeqCst) as f64;
            let my = MOUSE_Y.load(Ordering::SeqCst) as f64;

            // ── 优先检测：点击是否落在浮动按钮区域 ──
            if super::is_click_on_button(mx, my) {
                log::info!("Click on button detected at ({}, {}), triggering lookup", mx, my);
                let _ = app_handle.emit("trigger-lookup", ());
                continue;
            }

            #[cfg(target_os = "windows")]
            if let Some((text, context)) = get_selected_text_uia() {
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
            } else {
                let _ = app_handle.emit("selection-cleared", ());
            }
        }
    }
}
