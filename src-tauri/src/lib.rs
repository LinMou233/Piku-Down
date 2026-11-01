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
pub fn run() {
    tauri::Builder::default()
        .manage(motion::MotionState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            let host = Arc::new(host::TauriHost {
                app: app.handle().clone(),
            });
            let backend = Arc::new(Backend::new(root, host)?);
            let boot = host::boot_script(&backend.settings());
            app.manage(backend);
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Piku Down · B站 / X / YouTube")
            .inner_size(940.0, 680.0)
            .min_inner_size(720.0, 520.0)
            .decorations(false)
            .initialization_script(boot)
            .on_navigation(host::local_navigation)
            .build()?;
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
                let _ = window.emit(
                    "windowStateChanged",
                    serde_json::json!({"maximized":window.is_maximized().unwrap_or(false)}),
                );
            }
        })
        .run(tauri::generate_context!())
        .expect("无法启动Piku Down");
}
