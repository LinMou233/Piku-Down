use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};

#[derive(Default)]
struct Motion {
    previous: Option<(i32, i32)>,
    dx: i32,
    dy: i32,
    pending: bool,
}
#[derive(Default, Clone)]
pub struct MotionState(Arc<Mutex<HashMap<String, Motion>>>);
impl MotionState {
    pub fn moved(&self, window: &tauri::Window, x: i32, y: i32) {
        let label = window.label().to_owned();
        {
            let mut windows = self.0.lock().unwrap();
            let state = windows.entry(label.clone()).or_default();
            let previous = state.previous.replace((x, y));
            let Some((px, py)) = previous else {
                return;
            };
            state.dx = state.dx.saturating_add(x.saturating_sub(px));
            state.dy = state.dy.saturating_add(y.saturating_sub(py));
            if state.pending {
                return;
            }
            state.pending = true;
        }
        let windows = self.0.clone();
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(16)).await;
            let delta = {
                let mut windows = windows.lock().unwrap();
                let Some(state) = windows.get_mut(&label) else {
                    return;
                };
                state.pending = false;
                (std::mem::take(&mut state.dx), std::mem::take(&mut state.dy))
            };
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.emit(
                    "windowMotion",
                    serde_json::json!({"dx":delta.0,"dy":delta.1}),
                );
            }
        });
    }
    pub fn remove(&self, label: &str) {
        self.0.lock().unwrap().remove(label);
    }
}
