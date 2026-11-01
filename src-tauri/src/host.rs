use piku_core::{DesktopHost, HostFuture, WindowRole};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
pub struct TauriHost {
    pub app: tauri::AppHandle,
}
pub fn local_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "tauri" || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
}
pub fn boot_script(settings: &Value) -> String {
    let arch = match std::env::consts::ARCH {
        "x86" => "ia32",
        "aarch64" => "arm64",
        _ => "x64",
    };
    format!(
        "window.__PIKU_BOOT__={};",
        json!({"arch":arch,"theme":settings["theme"],"performance":settings["performance"]})
    )
}
impl TauriHost {
    fn window(&self, role: WindowRole) -> Result<tauri::WebviewWindow, String> {
        self.app
            .get_webview_window(match role {
                WindowRole::Main => "main",
                WindowRole::Login => "login",
            })
            .ok_or("窗口已关闭".into())
    }
}
impl DesktopHost for TauriHost {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.app.emit(event, payload);
    }
    fn video_dir(&self) -> Option<PathBuf> {
        self.app.path().video_dir().ok()
    }
    fn pick_path(
        &self,
        directory: bool,
        title: &str,
        extensions: &[&str],
    ) -> HostFuture<Result<Option<PathBuf>, String>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut builder = self.app.dialog().file().set_title(title);
        if !extensions.is_empty() {
            builder = builder.add_filter("文件", extensions);
        }
        if directory {
            builder.pick_folder(move |p| {
                let _ = tx.send(p);
            });
        } else {
            builder.pick_file(move |p| {
                let _ = tx.send(p);
            });
        }
        Box::pin(async move {
            rx.await
                .map_err(|_| "文件选择器已关闭")?
                .map(|p| p.into_path().map_err(|_| "无效文件路径".to_owned()))
                .transpose()
        })
    }
    fn open_login(&self) -> Result<(), String> {
        if let Some(window) = self.app.get_webview_window("login") {
            window.set_focus().map_err(|_| "无法显示登录窗口")?;
        } else {
            let settings = self
                .app
                .state::<std::sync::Arc<piku_core::Backend>>()
                .settings();
            tauri::WebviewWindowBuilder::new(
                &self.app,
                "login",
                tauri::WebviewUrl::App("login.html".into()),
            )
            .title("登录Piku Down")
            .inner_size(400.0, 520.0)
            .decorations(false)
            .resizable(false)
            .initialization_script(boot_script(&settings))
            .on_navigation(local_navigation)
            .build()
            .map_err(|_| "无法打开登录窗口")?;
        }
        Ok(())
    }
    fn close_login(&self) -> Result<(), String> {
        if let Some(window) = self.app.get_webview_window("login") {
            window.close().map_err(|_| "无法关闭登录窗口")?;
        }
        Ok(())
    }
    fn window_state(&self, role: WindowRole) -> Result<Value, String> {
        let window = self.window(role)?;
        Ok(
            json!({"maximized":window.is_maximized().unwrap_or(false),"minimized":window.is_minimized().unwrap_or(false),"title":"Piku Down · B站 / X / YouTube"}),
        )
    }
    fn window_action(&self, role: WindowRole, action: &str) -> Result<Value, String> {
        let window = self.window(role)?;
        match action {
            "minimize" => window.minimize(),
            "maximize" => {
                if window.is_maximized().unwrap_or(false) {
                    window.unmaximize()
                } else {
                    window.maximize()
                }
            }
            "restore" => window.unminimize(),
            "drag" => window.start_dragging(),
            "close" => window.destroy(),
            _ => return Err("无效的窗口操作".into()),
        }
        .map_err(|_| "窗口操作失败")?;
        Ok(json!({"maximized":window.is_maximized().unwrap_or(false)}))
    }
}
