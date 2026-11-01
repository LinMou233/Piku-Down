//! 下载与账号核心，不依赖GUI框架。
pub mod backend;
pub mod host;
pub mod links;
pub mod media;
pub mod output;
pub mod process;
pub mod queue;
pub mod runtime;
pub mod security;
pub mod shell;
pub use backend::Backend;
pub use host::{DesktopHost, HostFuture, WindowRole};
