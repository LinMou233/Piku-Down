use serde_json::Value;
use std::{future::Future, path::PathBuf, pin::Pin};
pub type HostFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowRole {
    Main,
    Login,
}
/// 窗口、对话框与事件的适配接口。业务数据由核心管理。
pub trait DesktopHost: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
    fn video_dir(&self) -> Option<PathBuf>;
    fn pick_path(
        &self,
        directory: bool,
        title: &str,
        extensions: &[&str],
    ) -> HostFuture<Result<Option<PathBuf>, String>>;
    fn open_login(&self) -> Result<(), String>;
    fn close_login(&self) -> Result<(), String>;
    fn window_state(&self, role: WindowRole) -> Result<Value, String>;
    fn window_action(&self, role: WindowRole, action: &str) -> Result<Value, String>;
}
/// 供核心测试与命令行工具使用，不创建窗口。
#[derive(Default)]
pub struct HeadlessHost;
impl DesktopHost for HeadlessHost {
    fn emit(&self, _: &str, _: Value) {}
    fn video_dir(&self) -> Option<PathBuf> {
        None
    }
    fn pick_path(
        &self,
        _: bool,
        _: &str,
        _: &[&str],
    ) -> HostFuture<Result<Option<PathBuf>, String>> {
        Box::pin(async { Err("无界面模式不提供文件选择器".into()) })
    }
    fn open_login(&self) -> Result<(), String> {
        Err("无界面模式不提供登录窗口".into())
    }
    fn close_login(&self) -> Result<(), String> {
        Ok(())
    }
    fn window_state(&self, _: WindowRole) -> Result<Value, String> {
        Err("无界面模式没有窗口".into())
    }
    fn window_action(&self, _: WindowRole, _: &str) -> Result<Value, String> {
        Err("无界面模式没有窗口".into())
    }
}
