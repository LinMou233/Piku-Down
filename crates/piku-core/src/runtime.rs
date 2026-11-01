use crate::process::Progress;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{io::AsyncWriteExt, sync::Mutex};
use tokio_util::sync::CancellationToken;
const VERSION: &str = "2026.10.21";
#[derive(Clone)]
struct Asset {
    name: &'static str,
    url: String,
    hash: &'static str,
    raw: &'static str,
    kind: &'static str,
    max: u64,
}
pub struct Runtime {
    root: PathBuf,
    client: reqwest::Client,
    gate: Mutex<()>,
    assets: Vec<Asset>,
}
fn asset(
    name: &'static str,
    url: String,
    hash: &'static str,
    raw: &'static str,
    kind: &'static str,
    max: u64,
) -> Asset {
    Asset {
        name,
        url,
        hash,
        raw,
        kind,
        max,
    }
}
fn digest(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}
async fn request_asset(
    client: &reqwest::Client,
    url: &str,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<reqwest::Response, String> {
    tokio::select! {
        _ = cancel.cancelled() => Err("下载已取消".into()),
        result = tokio::time::timeout(timeout, client.get(url).send()) => {
            result.map_err(|_| "下载组件响应超时")?
                .map_err(|_| "下载组件连接失败".into())
        }
    }
}
impl Runtime {
    pub fn new(root: &Path, client: reqwest::Client) -> Self {
        let (yt_name, yt_hash, qjs, qhash) = if cfg!(target_arch = "x86") {
            (
                "yt-dlp_x86.exe",
                "7ce38c77db13db50c64e656b1056a0448e6c38ec0f0ccf28e30dd5271c008850",
                "qjs-windows-x86.exe",
                "dedc4dd8da20234d206c433a706336fede47a14e75c690cb607f81aa9c9c71be",
            )
        } else if cfg!(target_arch = "aarch64") {
            (
                "yt-dlp_arm64.exe",
                "1380a9f105302764e6a5d383c2f07238ae242f0f4fbf3414aea00e56619a79b3",
                "qjs-windows-x86.exe",
                "dedc4dd8da20234d206c433a706336fede47a14e75c690cb607f81aa9c9c71be",
            )
        } else {
            (
                "yt-dlp.exe",
                "33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555",
                "qjs-windows-x86_64.exe",
                "2aeabf0092c3262d6b2609824418f7dd7ed1f1df939f73b2b15645230cac0d77",
            )
        };
        let mut assets = vec![
            asset(
                "yt-dlp.exe",
                format!("https://github.com/yt-dlp/yt-dlp/releases/download/{VERSION}/{yt_name}"),
                yt_hash,
                yt_hash,
                "exe",
                100 * 1024 * 1024,
            ),
            asset(
                "qjs.exe",
                format!("https://github.com/quickjs-ng/quickjs/releases/download/v0.17.0/{qjs}"),
                qhash,
                qhash,
                "exe",
                8 * 1024 * 1024,
            ),
        ];
        if cfg!(target_arch = "x86") {
            assets.push(asset("ffmpeg.exe","https://github.com/eugeneware/ffmpeg-static/releases/download/b4.4.1/win32-ia32.gz".into(),"6cbc74f5f1f4136bdbe2e6bb92e823ffb06ed786fdcbe899113789fd4c506403","f8547659a857a58fc43fb06a5a315d85b609f3e9d900d2bf083edff2072c7fa2","gz",40*1024*1024));
        } else if cfg!(target_arch = "aarch64") {
            assets.push(asset("ffmpeg.exe","https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-01-12-49/ffmpeg-N-128273-g836436cfb9-winarm64-gpl.zip".into(),"2a8b73ee16fd7291dbb79575737b0f1bdd69ca0c9cc698463de9762eaa4adcc3",include_str!("../arm64-ffmpeg.sha256").trim(),"zip",180*1024*1024));
        } else {
            assets.push(asset("ffmpeg.exe","https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz".into(),"8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77","04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00","gz",40*1024*1024));
        }
        Self {
            root: root
                .join("download-tools/tauri-2026.11.01")
                .join(std::env::consts::ARCH),
            client,
            gate: Mutex::new(()),
            assets,
        }
    }
    pub fn path(&self, key: &str) -> PathBuf {
        self.root.join(key)
    }
    pub async fn status(&self) -> serde_json::Value {
        let mut installed = true;
        for a in &self.assets {
            let p = self.path(a.name);
            let hash = a.raw;
            installed &= tokio::task::spawn_blocking(move || digest(&p).is_ok_and(|d| d == hash))
                .await
                .unwrap_or(false);
        }
        serde_json::json!({"supported":true,"installed":installed,"version":VERSION,"reason":"","architecture":std::env::consts::ARCH})
    }
    pub async fn ensure(
        &self,
        key: &str,
        cancel: &CancellationToken,
        progress: Progress,
    ) -> Result<PathBuf, String> {
        let _guard = tokio::select! {g=self.gate.lock()=>g,_=cancel.cancelled()=>return Err("下载已取消".into())};
        let a = self
            .assets
            .iter()
            .find(|a| a.name == key)
            .ok_or("未知下载组件")?
            .clone();
        let target = self.path(key);
        let check = target.clone();
        let hash = a.raw;
        if tokio::task::spawn_blocking(move || digest(&check).is_ok_and(|d| d == hash))
            .await
            .unwrap_or(false)
        {
            return Ok(target);
        }
        tokio::fs::create_dir_all(&self.root)
            .await
            .map_err(|_| "无法创建组件目录")?;
        let temp = tempfile::Builder::new()
            .prefix("component-")
            .tempdir_in(&self.root)
            .map_err(|_| "无法创建组件暂存目录")?;
        let archive = temp.path().join("download");
        progress(format!("正在准备{}（首次使用）", a.name), 0, 0);
        let response = request_asset(&self.client, &a.url, cancel, Duration::from_secs(25)).await?;
        if !response.status().is_success() {
            return Err(format!(
                "下载组件获取失败（{}）",
                response.status().as_u16()
            ));
        }
        let total = response.content_length().unwrap_or(0);
        let mut stream = response.bytes_stream();
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&archive)
            .await
            .map_err(|_| "无法保存下载组件")?;
        let mut hash = Sha256::new();
        let mut received = 0;
        let mut last = std::time::Instant::now();
        loop {
            let chunk = tokio::select! {value=tokio::time::timeout(Duration::from_secs(25),stream.next())=>value.map_err(|_|"下载组件无数据超时")?,_=cancel.cancelled()=>return Err("下载已取消".into())};
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = chunk.map_err(|_| "下载组件传输失败")?;
            received += chunk.len() as u64;
            if received > a.max {
                return Err("下载组件大小异常".into());
            }
            hash.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|_| "组件保存失败，请检查磁盘空间")?;
            if last.elapsed() >= Duration::from_millis(100) {
                progress(format!("正在准备{}", a.name), received, total);
                last = std::time::Instant::now();
            }
        }
        file.flush().await.map_err(|_| "组件保存失败")?;
        drop(file);
        if hex::encode(hash.finalize()) != a.hash {
            return Err("下载组件SHA256校验失败，未执行该文件".into());
        }
        if cancel.is_cancelled() {
            return Err("下载已取消".into());
        }
        let extracted = temp.path().join("verified.exe");
        let extract_path = extracted.clone();
        let kind = a.kind;
        let expected = a.raw;
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let mut output = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&extract_path)
                .map_err(|_| "无法解压组件")?;
            if kind == "gz" {
                let input = std::fs::File::open(&archive).map_err(|_| "组件暂存文件丢失")?;
                let mut decoder = flate2::read::GzDecoder::new(input).take(400 * 1024 * 1024);
                std::io::copy(&mut decoder, &mut output).map_err(|_| "组件解压失败")?;
            } else if kind == "zip" {
                let mut archive = zip::ZipArchive::new(
                    std::fs::File::open(&archive).map_err(|_| "组件暂存文件丢失")?,
                )
                .map_err(|_| "组件归档损坏")?;
                let name = archive
                    .file_names()
                    .find(|p| p.ends_with("/bin/ffmpeg.exe"))
                    .ok_or("组件归档缺少FFmpeg")?
                    .to_owned();
                let mut entry = archive
                    .by_name(&name)
                    .map_err(|_| "组件归档损坏")?
                    .take(400 * 1024 * 1024);
                std::io::copy(&mut entry, &mut output).map_err(|_| "组件解压失败")?;
            } else {
                let mut input = std::fs::File::open(&archive).map_err(|_| "组件暂存文件丢失")?;
                std::io::copy(&mut input, &mut output).map_err(|_| "组件保存失败")?;
            }
            output.flush().map_err(|_| "组件保存失败")?;
            drop(output);
            if digest(&extract_path).map_err(|_| "组件校验失败")? != expected {
                return Err("组件EXE校验失败".into());
            }
            Ok(())
        })
        .await
        .map_err(|_| "组件解压失败")??;
        if cancel.is_cancelled() {
            return Err("下载已取消".into());
        }
        tokio::fs::rename(extracted, &target)
            .await
            .map_err(|_| "无法更新下载组件，请检查占用情况")?;
        temp.close().map_err(|_| "组件已保存，但暂存清理失败")?;
        Ok(target)
    }
    pub async fn ensure_all(
        &self,
        cancel: &CancellationToken,
        progress: Progress,
    ) -> Result<(), String> {
        for key in ["yt-dlp.exe", "qjs.exe", "ffmpeg.exe"] {
            self.ensure(key, cancel, progress.clone()).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::AsyncReadExt, net::TcpListener, sync::oneshot, task::JoinHandle};

    async fn server(respond: bool) -> (String, oneshot::Receiver<()>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (ready, received) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            let _ = socket.read(&mut request).await.unwrap();
            let _ = ready.send(());
            if respond {
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\ncomplete").await.unwrap();
            } else {
                std::future::pending::<()>().await;
            }
        });
        (format!("http://{address}/component"), received, task)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn component_response_timeout_covers_connected_server_without_headers() {
        let (url, received, server) = server(false).await;
        let result = request_asset(
            &client(),
            &url,
            &CancellationToken::new(),
            Duration::from_millis(200),
        )
        .await;
        assert_eq!(result.unwrap_err(), "下载组件响应超时");
        received.await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn component_request_can_cancel_while_waiting_for_headers() {
        let (url, received, server) = server(false).await;
        let token = CancellationToken::new();
        let pending = {
            let token = token.clone();
            tokio::spawn(async move {
                request_asset(&client(), &url, &token, Duration::from_secs(30)).await
            })
        };
        received.await.unwrap();
        token.cancel();
        let result = tokio::time::timeout(Duration::from_secs(2), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err(), "下载已取消");
        server.abort();
    }

    #[tokio::test]
    async fn component_request_returns_successful_response() {
        let (url, _, server) = server(true).await;
        let response = request_asset(
            &client(),
            &url,
            &CancellationToken::new(),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        assert!(response.status().is_success());
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"complete");
        server.await.unwrap();
    }
}
