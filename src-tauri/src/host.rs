use piku_core::{DesktopHost, HostFuture, WindowRole};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
pub struct TauriHost {
    pub app: tauri::AppHandle,
}
impl TauriHost {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}
/// 窗口在网页绘制前的底色，与当前主题一致，避免深色主题启动时闪白。
pub fn theme_color(settings: &Value) -> tauri::window::Color {
    let key = if settings["theme"] == "dark" {
        "darkColor"
    } else {
        "color"
    };
    let fallback = if key == "darkColor" {
        (0x17, 0x1a, 0x24)
    } else {
        (0xe7, 0xeb, 0xf2)
    };
    let (r, g, b) = settings[key]
        .as_str()
        .and_then(|s| s.strip_prefix('#'))
        .filter(|s| s.len() == 6)
        .and_then(|s| {
            Some((
                u8::from_str_radix(&s[0..2], 16).ok()?,
                u8::from_str_radix(&s[2..4], 16).ok()?,
                u8::from_str_radix(&s[4..6], 16).ok()?,
            ))
        })
        .unwrap_or(fallback);
    tauri::window::Color(r, g, b, 255)
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
        // 以主窗口为父窗口，对话框保持模态，不会被主窗口遮住或重复打开。
        if let Some(window) = self.app.get_webview_window("main") {
            builder = builder.set_parent(&window);
        }
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
            .background_color(theme_color(&settings))
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
