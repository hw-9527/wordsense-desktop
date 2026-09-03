use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::AppHandle;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectionPayload {
    pub text: String,
    pub context: String,
    pub mouse_x: f64,
    pub mouse_y: f64,
    pub bounds_x: Option<f64>,
    pub bounds_y: Option<f64>,
    pub bounds_w: Option<f64>,
    pub bounds_h: Option<f64>,
}

/// 浮动按钮的屏幕矩形区域（物理像素坐标）
#[derive(Debug, Clone, Copy)]
pub struct ButtonRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 全局存储当前浮动按钮的屏幕位置，用于 Rust 层直接判断点击是否命中按钮
static BUTTON_RECT: Mutex<Option<ButtonRect>> = Mutex::new(None);

/// 更新浮动按钮的屏幕位置（由 show_panel_at 调用）
pub fn set_button_rect(x: f64, y: f64, w: f64, h: f64) {
    if let Ok(mut rect) = BUTTON_RECT.lock() {
        *rect = Some(ButtonRect { x, y, w, h });
    }
}

/// 清除浮动按钮位置（由 hide_panel 调用）
pub fn clear_button_rect() {
    if let Ok(mut rect) = BUTTON_RECT.lock() {
        *rect = None;
    }
}

/// 判断鼠标坐标是否落在浮动按钮区域内。
/// 无日志：会在低级鼠标钩子回调（WM_LBUTTONDOWN）中调用，钩子回调内
/// 任何 IO/格式化都有超时风险（超时会被系统直接移除钩子）。
pub fn is_click_on_button(mx: f64, my: f64) -> bool {
    if let Ok(rect) = BUTTON_RECT.lock() {
        if let Some(r) = *rect {
            // 给按钮区域加一点容差（±8px），让点击判定更宽松
            let margin = 8.0;
            return mx >= r.x - margin
                && mx <= r.x + r.w + margin
                && my >= r.y - margin
                && my <= r.y + r.h + margin;
        }
    }
    false
}

pub fn start_monitor(app_handle: AppHandle) {
    log::info!("Starting selection monitor");

    #[cfg(target_os = "macos")]
    macos::start_monitor(app_handle);

    #[cfg(target_os = "windows")]
    windows::start_monitor(app_handle);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        log::warn!("Selection monitoring not supported on this platform");
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    }
}
