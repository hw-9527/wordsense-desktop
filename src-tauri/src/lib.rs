mod config;
mod selection;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
async fn show_panel_at(app: tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("panel") {
        let pos = tauri::LogicalPosition::new(x, y);
        panel.set_position(pos).map_err(|e| e.to_string())?;
        panel.show().map_err(|e| e.to_string())?;

        // 统一使用逻辑像素（点）记录按钮位置，供 Rust 层判断点击命中
        let scale = panel.scale_factor().unwrap_or(2.0);
        let size = panel.outer_size().unwrap_or(tauri::PhysicalSize::new(110, 52));
        let logical_w = size.width as f64 / scale;
        let logical_h = size.height as f64 / scale;

        // 只在小窗口（按钮模式，≤160px逻辑宽度）时记录命中区域
        // 面板模式（380px宽）时清除，避免大面积误命中
        if logical_w <= 160.0 {
            selection::set_button_rect(x, y, logical_w, logical_h);
        } else {
            selection::clear_button_rect();
        }
    }
    Ok(())
}

#[tauri::command]
async fn hide_panel(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("panel") {
        panel.hide().map_err(|e| e.to_string())?;
    }
    selection::clear_button_rect();
    Ok(())
}

/// 显示设置窗口；若窗口已被销毁则按配置重建。
/// 点击窗口 × 默认会销毁 Tauri 窗口，导致之后托盘"设置"无响应，
/// 因此 setup 中同时把该窗口的关闭事件拦截为隐藏。
fn show_settings(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    // 窗口不存在（被销毁）：重建并直接显示
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("词境设置")
    .inner_size(400.0, 580.0)
    .resizable(false)
    .center()
    .build();
}

#[tauri::command]
async fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    show_settings(&app);
    Ok(())
}

// ── System tray ─────────────────────────────────────────────────────────────

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings_item, &quit_item])?;

    let icon = app.default_window_icon().cloned().unwrap();

    TrayIconBuilder::with_id("main_tray")
        .icon(icon)
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => show_settings(app),
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_settings(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// ── Platform-specific: make panel window non-activating ─────────────────────

#[cfg(target_os = "macos")]
fn setup_panel_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use cocoa::appkit::NSWindowCollectionBehavior;
    use cocoa::base::id;
    use objc::runtime::{Class, Object, Sel, BOOL, YES};
    use objc::{msg_send, sel, sel_impl};

    let panel = app
        .get_webview_window("panel")
        .ok_or("panel window not found")?;
    let ns_window: id = panel.ns_window().map_err(|e| e.to_string())? as id;

    unsafe {
        use cocoa::appkit::NSWindow;
        use cocoa::base::NO;
        // Floating window level on macOS is 3
        ns_window.setLevel_(3);
        // Disable macOS window shadow completely (so only the CSS pill button has shadow)
        ns_window.setHasShadow_(NO);
        // Non-activating panel: don't steal focus when shown / clicked
        let mask = ns_window.styleMask();
        ns_window.setStyleMask_(
            mask | cocoa::appkit::NSWindowStyleMask::from_bits_truncate(1 << 7),
        ); // NSNonactivatingPanelMask
        // Join all spaces, transient (hides with owning app)
        ns_window.setCollectionBehavior_(
            NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorTransient
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary,
        );

        // 获取 contentView
        let content_view: id = msg_send![ns_window, contentView];
        if !content_view.is_null() {
            set_accepts_first_mouse_recursive(content_view);
        }

        let _: () = msg_send![ns_window, setIgnoresMouseEvents: NO];
    }
    Ok(())
}

/// 递归遍历 view 树，通过 ObjC runtime 为所有 view 添加 acceptsFirstMouse 支持
#[cfg(target_os = "macos")]
unsafe fn set_accepts_first_mouse_recursive(view: cocoa::base::id) {
    use objc::runtime::{Class, Object, Sel, BOOL, YES};
    use objc::{msg_send, sel, sel_impl};
    use std::ffi::CString;

    let cls: *const Class = msg_send![view, class];
    if !cls.is_null() {
        let sel_afm = sel!(acceptsFirstMouse:);
        extern "C" fn always_yes(_this: &Object, _cmd: Sel, _event: cocoa::base::id) -> BOOL {
            YES
        }
        let imp: objc::runtime::Imp = std::mem::transmute(
            always_yes as extern "C" fn(&Object, Sel, cocoa::base::id) -> BOOL,
        );
        let _ = objc::runtime::class_addMethod(
            cls as *mut Class,
            sel_afm,
            imp,
            CString::new("B@:@").unwrap().as_ptr(),
        );
    }

    let subviews: cocoa::base::id = msg_send![view, subviews];
    if !subviews.is_null() {
        let count: usize = msg_send![subviews, count];
        for i in 0..count {
            let subview: cocoa::base::id = msg_send![subviews, objectAtIndex: i];
            if !subview.is_null() {
                set_accepts_first_mouse_recursive(subview);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn setup_panel_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::*;

    let panel = app
        .get_webview_window("panel")
        .ok_or("panel window not found")?;
    let raw_hwnd = panel.hwnd().map_err(|e| e.to_string())?;
    let hwnd = HWND(raw_hwnd.0 as *mut _);

    unsafe {
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        SetWindowLongW(
            hwnd,
            GWL_EXSTYLE,
            ex_style | WS_EX_NOACTIVATE.0 as i32 | WS_EX_TOOLWINDOW.0 as i32,
        );
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn setup_panel_window(_app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

// ── App entry ───────────────────────────────────────────────────────────────

pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已有实例在运行：显示设置窗口提示用户，随后新进程自动退出
            log::info!("Another instance detected, focusing existing one");
            show_settings(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            show_panel_at,
            hide_panel,
            open_settings,
        ])
        .setup(|app| {
            setup_tray(app)?;
            // 设置窗口的 × 改为隐藏而非销毁：窗口被销毁后托盘"设置"将永远无响应
            if let Some(settings_win) = app.get_webview_window("settings") {
                let win = settings_win.clone();
                settings_win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }
            // Try to configure panel as non-activating (best-effort)
            if let Err(e) = setup_panel_window(app) {
                log::warn!("Failed to set up panel window: {e}");
            }
            // Start selection monitor in background thread
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                selection::start_monitor(app_handle);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running WordSense");
}
