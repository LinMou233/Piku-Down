mod host;
mod motion;

use piku_core::{Backend, WindowRole};
use serde_json::Value;
use std::sync::Arc;
use tauri::{Emitter, Manager};

#[tauri::command]
async fn dispatch(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Backend>>,
    command: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    let role = match window.label() {
        "main" => WindowRole::Main,
        "login" => WindowRole::Login,
        _ => return Err("无效的窗口请求".into()),
    };
    state.inner().clone().dispatch(role, &command, args).await
}

/// 无控制台的发行版里，启动失败或panic时至少给出可见提示，而不是直接消失。
fn fatal(message: &str) {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(
                hwnd: *mut std::ffi::c_void,
                text: *const u16,
                caption: *const u16,
                kind: u32,
            ) -> i32;
        }
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let text = wide(message);
        let caption = wide("Piku Down");
        // MB_OK | MB_ICONERROR | MB_SETFOREGROUND
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                caption.as_ptr(),
                0x10 | 0x10000,
            );
        }
    }
    #[cfg(not(windows))]
    eprintln!("{message}");
}

fn startup_message(error: &dyn std::fmt::Display) -> String {
    let detail = error.to_string();
    let mut message = format!("Piku Down无法启动。\n\n{detail}");
    let lower = detail.to_ascii_lowercase();
    if lower.contains("webview2") || lower.contains("webview") {
        message.push_str(
            "\n\n系统可能缺少Microsoft Edge WebView2 Runtime，请安装后重试：\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703",
        );
    }
    message
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let root = app.path().app_data_dir()?;
    let host = Arc::new(host::TauriHost::new(app.handle().clone()));
    let backend = Arc::new(Backend::new(root, host)?);
    let settings = backend.settings();
    let boot = host::boot_script(&settings);
    app.manage(backend.clone());
    tauri::async_runtime::spawn_blocking(move || backend.cleanup_stale_temp());
    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
        .title("Piku Down · B站 / X / YouTube")
        .inner_size(940.0, 680.0)
        .min_inner_size(720.0, 520.0)
        .decorations(false)
        .background_color(host::theme_color(&settings))
        .initialization_script(boot)
        .on_navigation(host::local_navigation)
        .build()?;
    Ok(())
}

pub fn run() {
    std::panic::set_hook(Box::new(|info| {
        fatal(&format!("Piku Down遇到内部错误并需要关闭。\n\n{info}"));
    }));
    let app = tauri::Builder::default()
        .manage(motion::MotionState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // setup错误在Tauri内部会变成panic；这里先给出说明再退出。
            if let Err(error) = setup_app(app) {
                fatal(&startup_message(&*error));
                std::process::exit(1);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![dispatch])
        .on_window_event(|window, event| {
            let motion = window.state::<motion::MotionState>();
            match event {
                tauri::WindowEvent::Moved(pos) => motion.moved(window, pos.x, pos.y),
                tauri::WindowEvent::Destroyed => motion.remove(window.label()),
                _ => (),
            }
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let backend = window.state::<Arc<Backend>>().inner().clone();
                api.prevent_close();
                let window = window.clone();
                tauri::async_runtime::spawn(async move {
                    backend.shutdown().await;
                    let _ = window.destroy();
                });
            }
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                let _ = window.emit_to(
                    tauri::EventTarget::webview_window(window.label()),
                    "windowStateChanged",
                    serde_json::json!({"maximized":window.is_maximized().unwrap_or(false)}),
                );
            }
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|_, _| {}),
        Err(error) => fatal(&startup_message(&error)),
    }
}
