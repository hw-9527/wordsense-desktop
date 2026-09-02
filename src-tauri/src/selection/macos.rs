use super::SelectionPayload;
use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
use core_foundation::string::CFString;
use core_graphics::event::CGEvent;
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// ── ApplicationServices & WebKit/Chromium AXTextMarker FFI ──────────────────

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> *mut std::ffi::c_void;
    fn AXUIElementCreateApplication(pid: i32) -> *mut std::ffi::c_void;
    fn AXUIElementCopyAttributeValue(
        element: *mut std::ffi::c_void,
        attribute: *const std::ffi::c_void,
        value: *mut *mut std::ffi::c_void,
    ) -> i32;
    fn AXUIElementCopyParameterizedAttributeValue(
        element: *mut std::ffi::c_void,
        attribute: *const std::ffi::c_void,
        parameter: *const std::ffi::c_void,
        value: *mut *mut std::ffi::c_void,
    ) -> i32;
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
    fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;

    // macOS 原生 TextMarker API（WebKit / Chromium 底层导出）
    fn AXTextMarkerRangeCopyStartMarker(range: CFTypeRef) -> CFTypeRef;
    fn AXValueGetValue(value: *mut std::ffi::c_void, value_type: u32, value_ptr: *mut std::ffi::c_void) -> bool;
}

#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

const AX_FOCUSED_UI_ELEMENT: &str = "AXFocusedUIElement";
const AX_SELECTED_TEXT: &str = "AXSelectedText";
const AX_VALUE: &str = "AXValue";
const AX_DESCRIPTION: &str = "AXDescription";
const AX_TITLE: &str = "AXTitle";
const AX_PARENT: &str = "AXParent";
const AX_SELECTED_TEXT_MARKER_RANGE: &str = "AXSelectedTextMarkerRange";
const AX_SENTENCE_TEXT_MARKER_RANGE_FOR_TEXT_MARKER: &str = "AXSentenceTextMarkerRangeForTextMarker";
const AX_PARAGRAPH_TEXT_MARKER_RANGE_FOR_TEXT_MARKER: &str = "AXParagraphTextMarkerRangeForTextMarker";
const AX_STRING_FOR_TEXT_MARKER_RANGE: &str = "AXStringForTextMarkerRange";
const AX_BOUNDS_FOR_TEXT_MARKER_RANGE: &str = "AXBoundsForTextMarkerRange";
const AX_SELECTED_TEXT_RANGE: &str = "AXSelectedTextRange";
const AX_BOUNDS_FOR_RANGE: &str = "AXBoundsForRange";
const K_AX_VALUE_CGRECT_TYPE: u32 = 3;

// ── Safe Helpers ────────────────────────────────────────────────────────────

/// 验证选中文本是否为有效文本（必须包含至少一个字母、数字或汉字，且长度适中，排除纯标点、纯空白等误触）
fn is_valid_selection(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.len() > 400 {
        return false;
    }
    trimmed.chars().any(|c| c.is_alphanumeric())
}

unsafe fn get_string_attr(element: *mut std::ffi::c_void, attr_name: &str) -> Option<String> {
    if element.is_null() {
        return None;
    }
    let attr = CFString::new(attr_name);
    let mut value: *mut std::ffi::c_void = std::ptr::null_mut();
    let err = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef() as _, &mut value);
    if err == 0 && !value.is_null() {
        if core_foundation::base::CFGetTypeID(value as _) == CFString::type_id() {
            let cf_str = CFString::wrap_under_get_rule(value as _);
            let s = cf_str.to_string();
            CFRelease(value as _);
            if !s.trim().is_empty() {
                return Some(s);
            }
        } else {
            CFRelease(value as _);
        }
    }
    None
}

/// 浏览器专用通道：通过 AXTextMarkerRangeCopyStartMarker + AXSentenceTextMarkerRangeForTextMarker 提取真实上下文与精准位置
unsafe fn get_browser_selection_and_context(
    element: *mut std::ffi::c_void,
) -> Option<(String, String, Option<(f64, f64, f64, f64)>)> {
    if element.is_null() {
        return None;
    }

    // 1. 获取选区 TextMarkerRange
    let attr_range = CFString::new(AX_SELECTED_TEXT_MARKER_RANGE);
    let mut marker_range: *mut std::ffi::c_void = std::ptr::null_mut();
    if AXUIElementCopyAttributeValue(
        element,
        attr_range.as_concrete_TypeRef() as _,
        &mut marker_range,
    ) != 0
        || marker_range.is_null()
    {
        return None;
    }

    // 2. 读取选中文本
    let attr_str = CFString::new(AX_STRING_FOR_TEXT_MARKER_RANGE);
    let mut sel_str_val: *mut std::ffi::c_void = std::ptr::null_mut();
    let mut selected_text = String::new();
    if AXUIElementCopyParameterizedAttributeValue(
        element,
        attr_str.as_concrete_TypeRef() as _,
        marker_range as _,
        &mut sel_str_val,
    ) == 0
        && !sel_str_val.is_null()
    {
        let cf_s = CFString::wrap_under_get_rule(sel_str_val as _);
        selected_text = cf_s.to_string();
        CFRelease(sel_str_val as _);
    }

    if !is_valid_selection(&selected_text) {
        CFRelease(marker_range as _);
        return None;
    }

    // 3. 读取选区的精确屏幕像素矩形（Bounds: x, y, width, height）
    let mut bounds: Option<(f64, f64, f64, f64)> = None;
    let attr_bounds = CFString::new(AX_BOUNDS_FOR_TEXT_MARKER_RANGE);
    let mut bounds_val: *mut std::ffi::c_void = std::ptr::null_mut();
    if AXUIElementCopyParameterizedAttributeValue(
        element,
        attr_bounds.as_concrete_TypeRef() as _,
        marker_range as _,
        &mut bounds_val,
    ) == 0
        && !bounds_val.is_null()
    {
        let mut rect = CGRect::default();
        if AXValueGetValue(
            bounds_val,
            K_AX_VALUE_CGRECT_TYPE,
            &mut rect as *mut _ as *mut std::ffi::c_void,
        ) {
            if rect.size.width > 0.0 && rect.size.height > 0.0 {
                bounds = Some((rect.origin.x, rect.origin.y, rect.size.width, rect.size.height));
            }
        }
        CFRelease(bounds_val as _);
    }

    // 4. 从 marker_range 内部复制真正的 start_marker
    let start_marker = AXTextMarkerRangeCopyStartMarker(marker_range as _);
    CFRelease(marker_range as _);

    if start_marker.is_null() {
        return Some((selected_text, String::new(), bounds));
    }

    let mut context = String::new();

    // 5. 获取该 start_marker 所在句子的完整 TextMarkerRange
    let attr_sent = CFString::new(AX_SENTENCE_TEXT_MARKER_RANGE_FOR_TEXT_MARKER);
    let mut sent_range: *mut std::ffi::c_void = std::ptr::null_mut();
    if AXUIElementCopyParameterizedAttributeValue(
        element,
        attr_sent.as_concrete_TypeRef() as _,
        start_marker,
        &mut sent_range,
    ) == 0
        && !sent_range.is_null()
    {
        let mut sent_str: *mut std::ffi::c_void = std::ptr::null_mut();
        if AXUIElementCopyParameterizedAttributeValue(
            element,
            attr_str.as_concrete_TypeRef() as _,
            sent_range as _,
            &mut sent_str,
        ) == 0
            && !sent_str.is_null()
        {
            let cf_s = CFString::wrap_under_get_rule(sent_str as _);
            let s = cf_s.to_string();
            CFRelease(sent_str as _);
            if !s.trim().is_empty() {
                context = s.trim().to_string();
            }
        }
        CFRelease(sent_range as _);
    }

    // 6. 若整句未取到，尝试获取整段
    if context.is_empty() {
        let attr_para = CFString::new(AX_PARAGRAPH_TEXT_MARKER_RANGE_FOR_TEXT_MARKER);
        let mut para_range: *mut std::ffi::c_void = std::ptr::null_mut();
        if AXUIElementCopyParameterizedAttributeValue(
            element,
            attr_para.as_concrete_TypeRef() as _,
            start_marker,
            &mut para_range,
        ) == 0
            && !para_range.is_null()
        {
            let mut para_str: *mut std::ffi::c_void = std::ptr::null_mut();
            if AXUIElementCopyParameterizedAttributeValue(
                element,
                attr_str.as_concrete_TypeRef() as _,
                para_range as _,
                &mut para_str,
            ) == 0
                && !para_str.is_null()
            {
                let cf_s = CFString::wrap_under_get_rule(para_str as _);
                let s = cf_s.to_string();
                CFRelease(para_str as _);
                if !s.trim().is_empty() {
                    context = extract_sentence_context(&s, &selected_text);
                }
            }
            CFRelease(para_range as _);
        }
    }

    CFRelease(start_marker);
    Some((selected_text, context, bounds))
}

/// 向上回溯通用 AX 树查找包含选中文本的容器（用于原生 App、文本编辑器、文档查看器等）
unsafe fn find_context_in_ax_tree(element: *mut std::ffi::c_void, target: &str) -> Option<String> {
    if element.is_null() {
        return None;
    }
    let mut curr: *mut std::ffi::c_void = element;
    let mut depth = 0;

    while !curr.is_null() && depth < 6 {
        for attr in [AX_VALUE, AX_DESCRIPTION, AX_TITLE] {
            if let Some(text) = get_string_attr(curr, attr) {
                if text.contains(target) && text.len() > target.len() {
                    if curr != element {
                        CFRelease(curr as _);
                    }
                    return Some(text);
                }
            }
        }

        let attr_parent = CFString::new(AX_PARENT);
        let mut parent: *mut std::ffi::c_void = std::ptr::null_mut();
        let err = AXUIElementCopyAttributeValue(
            curr,
            attr_parent.as_concrete_TypeRef() as _,
            &mut parent,
        );

        if curr != element {
            CFRelease(curr as _);
            curr = std::ptr::null_mut();
        }

        if err != 0 || parent.is_null() {
            break;
        }
        curr = parent;
        depth += 1;
    }

    if curr != element && !curr.is_null() {
        CFRelease(curr as _);
    }

    None
}

/// 提取整句上下文算法
fn extract_sentence_context(full_text: &str, target: &str) -> String {
    let full = full_text.split_whitespace().collect::<Vec<_>>().join(" ");
    if full.is_empty() {
        return String::new();
    }

    let idx = match full.find(target) {
        Some(i) => i,
        None => 0,
    };

    let max_len = 320;
    let bytes = full.as_bytes();
    let mut start = idx;
    let mut end = idx + target.len();

    // 向前寻找句子起始标点 (. ! ? \n 等)
    while start > 0 && idx - start < max_len {
        let b = bytes[start - 1];
        if b == b'.' || b == b'!' || b == b'?' || b == b'\n' || b == b';' {
            break;
        }
        start -= 1;
    }

    // 向后寻找句子结束标点
    while end < full.len() && end - idx < max_len {
        let b = bytes[end];
        if b == b'.' || b == b'!' || b == b'?' || b == b'\n' || b == b';' {
            end += 1;
            break;
        }
        end += 1;
    }

    // 如果截取的句子太短，适当扩充周围字符
    if end - start < 30 {
        start = idx.saturating_sub(120);
        end = (idx + target.len() + 150).min(full.len());
    }

    let start = full.floor_char_boundary(start);
    let end = full.ceil_char_boundary(end);
    full[start..end].trim().to_string()
}

/// 获取当前处于最前台活跃应用的 PID
fn get_frontmost_app_pid() -> Option<i32> {
    use objc::runtime::{Class, Object};
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let cls = Class::get("NSWorkspace")?;
        let workspace: *mut Object = msg_send![cls, sharedWorkspace];
        if !workspace.is_null() {
            let front_app: *mut Object = msg_send![workspace, frontmostApplication];
            if !front_app.is_null() {
                let pid: i32 = msg_send![front_app, processIdentifier];
                if pid > 0 {
                    return Some(pid);
                }
            }
        }
    }
    None
}

/// 全系统通用 + 浏览器专有 双引擎高精度抓词与上下文及位置提取
fn get_selected_text_ax() -> Option<(String, String, Option<(f64, f64, f64, f64)>)> {
    unsafe {
        if !AXIsProcessTrusted() {
            return None;
        }

        // 1. 优先从当前前台活跃 App 的 AX 树中定位 Focused Element
        let mut focused: *mut std::ffi::c_void = std::ptr::null_mut();
        let attr = CFString::new(AX_FOCUSED_UI_ELEMENT);

        if let Some(pid) = get_frontmost_app_pid() {
            let app_elem = AXUIElementCreateApplication(pid);
            if !app_elem.is_null() {
                let err = AXUIElementCopyAttributeValue(app_elem, attr.as_concrete_TypeRef() as _, &mut focused);
                CFRelease(app_elem as _);
                if err != 0 || focused.is_null() {
                    focused = std::ptr::null_mut();
                }
            }
        }

        // 2. 如果前台 App 读取失败，回退到 SystemWide 读取
        if focused.is_null() {
            let system = AXUIElementCreateSystemWide();
            if !system.is_null() {
                let _ = AXUIElementCopyAttributeValue(system, attr.as_concrete_TypeRef() as _, &mut focused);
                CFRelease(system as _);
            }
        }

        if focused.is_null() {
            return None;
        }

        // 3. 通道 A（针对 Chrome / Safari / Edge / WebKit / Electron 等浏览器环境）：
        if let Some((sel_text, context, bounds)) = get_browser_selection_and_context(focused) {
            CFRelease(focused as _);
            return Some((sel_text, context, bounds));
        }

        // 4. 通道 B（针对 Xcode、Pages、VSCode、Notes、PDF 阅读器等原生桌面应用）：
        let text_opt = get_string_attr(focused, AX_SELECTED_TEXT);
        let text = match text_opt {
            Some(t) if is_valid_selection(&t) => t,
            _ => {
                CFRelease(focused as _);
                return None;
            }
        };

        let mut bounds: Option<(f64, f64, f64, f64)> = None;
        let attr_sel_range = CFString::new(AX_SELECTED_TEXT_RANGE);
        let mut range_val: *mut std::ffi::c_void = std::ptr::null_mut();
        if AXUIElementCopyAttributeValue(
            focused,
            attr_sel_range.as_concrete_TypeRef() as _,
            &mut range_val,
        ) == 0
            && !range_val.is_null()
        {
            let attr_bounds = CFString::new(AX_BOUNDS_FOR_RANGE);
            let mut bounds_val: *mut std::ffi::c_void = std::ptr::null_mut();
            if AXUIElementCopyParameterizedAttributeValue(
                focused,
                attr_bounds.as_concrete_TypeRef() as _,
                range_val,
                &mut bounds_val,
            ) == 0
                && !bounds_val.is_null()
            {
                let mut rect = CGRect::default();
                if AXValueGetValue(
                    bounds_val,
                    K_AX_VALUE_CGRECT_TYPE,
                    &mut rect as *mut _ as *mut std::ffi::c_void,
                ) {
                    if rect.size.width > 0.0 && rect.size.height > 0.0 {
                        bounds = Some((rect.origin.x, rect.origin.y, rect.size.width, rect.size.height));
                    }
                }
                CFRelease(bounds_val as _);
            }
            CFRelease(range_val as _);
        }

        let mut context = String::new();
        if let Some(full_block) = find_context_in_ax_tree(focused, &text) {
            context = extract_sentence_context(&full_block, &text);
        }

        CFRelease(focused as _);
        Some((text, context, bounds))
    }
}

/// Get current mouse cursor position.
fn get_mouse_position() -> (f64, f64) {
    if let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
        if let Ok(event) = CGEvent::new(source) {
            let loc = event.location();
            return (loc.x, loc.y);
        }
    }
    (0.0, 0.0)
}

// ── Monitor loop ────────────────────────────────────────────────────────────

pub fn start_monitor(app_handle: AppHandle) {
    unsafe {
        use core_foundation::boolean::CFBoolean;
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::string::CFString;

        let key = CFString::new("AXTrustedCheckOptionPrompt");
        let value = CFBoolean::true_value();
        let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
        let trusted = AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as _);
        if !trusted {
            log::warn!(
                "Accessibility permission not granted. \
                 Prompting user in System Settings → Privacy & Security → Accessibility."
            );
        }
    }

    let mut was_pressed = false;
    let mut last_emitted = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap();

    loop {
        std::thread::sleep(Duration::from_millis(50));

        // State 1 = HIDSystemState, Button 0 = Left button
        let pressed = unsafe { CGEventSourceButtonState(1, 0) };

        // Detect transition: pressed → released
        if was_pressed && !pressed {
            let (mx, my) = get_mouse_position();

            // ── 优先检测：点击是否落在浮动按钮区域 ──
            if super::is_click_on_button(mx, my) {
                log::info!("Click on button detected at ({}, {}), triggering lookup", mx, my);
                let _ = app_handle.emit("trigger-lookup", ());
                was_pressed = pressed;
                continue;
            }

            if last_emitted.elapsed() < Duration::from_millis(400) {
                was_pressed = pressed;
                continue;
            }

            // 等待目标应用完成选区渲染
            std::thread::sleep(Duration::from_millis(160));

            if let Some((text, context, bounds)) = get_selected_text_ax() {
                let trimmed = text.trim();
                if is_valid_selection(trimmed) {
                    let (bx, by, bw, bh) = match bounds {
                        Some((x, y, w, h)) => (Some(x), Some(y), Some(w), Some(h)),
                        None => (None, None, None, None),
                    };
                    let payload = SelectionPayload {
                        text: trimmed.to_string(),
                        context,
                        mouse_x: mx,
                        mouse_y: my,
                        bounds_x: bx,
                        bounds_y: by,
                        bounds_w: bw,
                        bounds_h: bh,
                    };
                    log::info!(
                        "Selection detected: {:?}, bounds: {:?}",
                        payload.text,
                        bounds
                    );
                    let _ = app_handle.emit("selection-detected", &payload);
                    last_emitted = Instant::now();
                } else {
                    let _ = app_handle.emit("selection-cleared", ());
                }
            } else {
                // 没有选中文本或选区已取消，通知前端立即隐藏浮动按钮
                let _ = app_handle.emit("selection-cleared", ());
            }
        }

        was_pressed = pressed;
    }
}
