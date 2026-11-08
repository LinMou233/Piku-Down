use std::{path::Path, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, BufReader},
    process::Command,
};
use tokio_util::sync::CancellationToken;
pub type Progress = Arc<dyn Fn(String, u64, u64) + Send + Sync>;

#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;
    #[repr(C)]
    #[derive(Default)]
    struct Basic {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min: usize,
        max: usize,
        active: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Io {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Extended {
        basic: Basic,
        io: Io,
        process_mem: usize,
        job_mem: usize,
        peak_process: usize,
        peak_job: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attr: *const c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            class: i32,
            info: *const c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn OpenProcess(access: u32, inherit: i32, id: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    pub struct Job(*mut c_void);
    unsafe impl Send for Job {}
    impl Job {
        pub fn assign(id: u32) -> std::io::Result<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let guard = Self(job);
                let mut limits = Extended::default();
                limits.basic.flags = 0x2000;
                if SetInformationJobObject(
                    job,
                    9,
                    (&limits as *const Extended).cast(),
                    std::mem::size_of::<Extended>() as u32,
                ) == 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                let process = OpenProcess(0x0101, 0, id);
                if process.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let ok = AssignProcessToJobObject(job, process);
                let error = std::io::Error::last_os_error();
                CloseHandle(process);
                if ok == 0 {
                    return Err(error);
                }
                Ok(guard)
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
pub async fn run(
    exe: &Path,
    args: &[String],
    cancel: &CancellationToken,
    timeout: Duration,
    progress: Option<Progress>,
) -> Result<Vec<u8>, String> {
    let output = run_inner(exe, args, cancel, timeout, progress).await?;
    if !output.success {
        let base = "解析或下载失败，请确认网页能访问该视频及账号权限";
        return Err(match failure_detail(&output.stderr) {
            Some(detail) => format!("{base}（{detail}）"),
            None => base.into(),
        });
    }
    Ok(output.stdout)
}
/// yt-dlp的数值可能是整数或浮点数（分段下载的total_bytes_estimate是浮点）。
fn byte_count(value: &serde_json::Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map(|n| n.round() as u64)
    })
}
/// 解析yt-dlp一行输出：PIKU_PROGRESS进度JSON，或合并／转封装等后处理提示。
fn progress_line(line: &[u8]) -> Option<(&'static str, u64, u64)> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if let Some(data) = line.strip_prefix(b"PIKU_PROGRESS:") {
        let value = serde_json::from_slice::<serde_json::Value>(data).ok()?;
        let received = byte_count(&value["downloaded_bytes"]).unwrap_or(0);
        let total = byte_count(&value["total_bytes"])
            .filter(|n| *n > 0)
            .or_else(|| byte_count(&value["total_bytes_estimate"]))
            .unwrap_or(0)
            .max(if value["status"] == "finished" {
                received
            } else {
                0
            });
        // 视频与音轨分别下载，单个文件完成不代表进入合并。
        return Some(("正在下载", received, total));
    }
    const POSTPROCESS: [&[u8]; 6] = [
        b"[Merger]",
        b"[VideoRemuxer]",
        b"[VideoConvertor]",
        b"[ExtractAudio]",
        b"[FixupM3u8]",
        b"[FixupM4a]",
    ];
    POSTPROCESS
        .iter()
        .any(|prefix| line.starts_with(prefix))
        .then_some(("正在处理音视频", 0, 0))
}
/// 从组件stderr中取出最能说明原因的一行，便于界面与日志排查。
pub fn failure_detail(stderr: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let line = lines
        .iter()
        .rev()
        .find(|line| line.starts_with("ERROR:") || line.contains("Error") || line.contains("error"))
        .or_else(|| lines.last())?;
    let line: String = line.chars().filter(|c| !c.is_control()).take(240).collect();
    Some(line)
}
struct Output {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    success: bool,
}
async fn run_inner(
    exe: &Path,
    args: &[String],
    cancel: &CancellationToken,
    timeout: Duration,
    progress: Option<Progress>,
) -> Result<Output, String> {
    if cancel.is_cancelled() {
        return Err("下载已取消".into());
    }
    let mut command = Command::new(exe);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "下载组件无法启动，请检查组件与系统环境".to_owned())?;
    #[cfg(windows)]
    let job = match windows_job::Job::assign(child.id().unwrap_or(0)) {
        Ok(j) => j,
        Err(_) => {
            let _ = child.kill().await;
            return Err("无法隔离下载组件进程，已停止本次任务".into());
        }
    };
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let output = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let mut stream = BufReader::new(stdout);
        let mut line = Vec::new();
        let mut buffer = [0u8; 8192];
        let mut overflow = false;
        loop {
            let n = stream.read(&mut buffer).await?;
            if n == 0 {
                break;
            }
            if let Some(callback) = &progress {
                for byte in &buffer[..n] {
                    if *byte == b'\n' {
                        if let Some((label, received, total)) = progress_line(&line) {
                            callback(label.into(), received, total);
                        }
                        line.clear();
                    } else if line.len() < 64 * 1024 {
                        line.push(*byte);
                    }
                }
            } else if bytes.len() + n <= 24 * 1024 * 1024 {
                bytes.extend_from_slice(&buffer[..n]);
            } else {
                overflow = true;
            }
        }
        if overflow {
            return Err(std::io::Error::other("组件输出过大"));
        }
        Ok::<_, std::io::Error>(bytes)
    });
    let errors = tokio::spawn(async move {
        let mut stream = BufReader::new(stderr);
        let mut buffer = [0u8; 8192];
        let mut bytes = Vec::new();
        loop {
            let n = stream.read(&mut buffer).await?;
            if n == 0 {
                break;
            }
            if bytes.len() < 64 * 1024 {
                let keep = n.min(64 * 1024 - bytes.len());
                bytes.extend_from_slice(&buffer[..keep]);
            }
        }
        Ok::<_, std::io::Error>(bytes)
    });
    let result = tokio::select! {_ = cancel.cancelled()=>{let _=child.kill().await;Err("下载已取消".to_owned())},_ = tokio::time::sleep(timeout)=>{let _=child.kill().await;Err("下载组件运行超时，请检查网络后重试".to_owned())},status=child.wait()=>status.map(|s|s.success()).map_err(|_|"无法取得组件退出状态".into())};
    #[cfg(windows)]
    drop(job);
    let bytes = output
        .await
        .map_err(|_| "读取组件结果失败")?
        .map_err(|_| "组件返回结果无效")?;
    let errors = errors
        .await
        .map_err(|_| "读取组件状态失败")?
        .map_err(|_| "组件返回状态无效")?;
    Ok(Output {
        stdout: bytes,
        stderr: errors,
        success: result?,
    })
}
pub async fn inspect(
    exe: &Path,
    input: &Path,
    cancel: &CancellationToken,
) -> Result<serde_json::Value, String> {
    let args = vec![
        "-hide_banner".into(),
        "-i".into(),
        input.to_string_lossy().into_owned(),
    ];
    let output = run_inner(exe, &args, cancel, Duration::from_secs(15), None).await?;
    Ok(probe_text(&String::from_utf8_lossy(&output.stderr)))
}
pub async fn inspect_remote(
    exe: &Path,
    input: &str,
    cancel: &CancellationToken,
) -> Result<serde_json::Value, String> {
    let args = vec![
        "-hide_banner".into(),
        "-rw_timeout".into(),
        "12000000".into(),
        "-user_agent".into(),
        "Mozilla/5.0".into(),
        "-referer".into(),
        "https://www.bilibili.com/".into(),
        "-i".into(),
        input.into(),
    ];
    let output = run_inner(exe, &args, cancel, Duration::from_secs(15), None).await?;
    Ok(probe_text(&String::from_utf8_lossy(&output.stderr)))
}
fn probe_text(input: &str) -> serde_json::Value {
    let line = input
        .lines()
        .find(|s| s.contains("Video:"))
        .unwrap_or_default();
    let size = regex::Regex::new(r"\b(\d{2,5})x(\d{2,5})\b")
        .unwrap()
        .captures(line);
    let fps = regex::Regex::new(r"([\d.]+) fps\b")
        .unwrap()
        .captures(line)
        .and_then(|c| c[1].parse::<f64>().ok())
        .unwrap_or(0.0);
    let codec = regex::Regex::new(r"Video: ([A-Za-z0-9_]+)")
        .unwrap()
        .captures(line)
        .map(|c| c[1].to_ascii_lowercase())
        .unwrap_or_default();
    if let Some(size) = size {
        serde_json::json!({"width":size[1].parse::<u32>().unwrap_or(0),"height":size[2].parse::<u32>().unwrap_or(0),"fps":fps,"codec":codec})
    } else {
        serde_json::Value::Null
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn fragmented_download_progress_uses_float_estimate() {
        // HLS／DASH分段下载：没有total_bytes，估算值为浮点数。
        let line = br#"PIKU_PROGRESS:{"status":"downloading","downloaded_bytes":52428800,"total_bytes":null,"total_bytes_estimate":1834567890.5,"fragment_index":12,"fragment_count":420}"#;
        assert_eq!(
            super::progress_line(line),
            Some(("正在下载", 52428800, 1834567891))
        );
        let plain =
            br#"PIKU_PROGRESS:{"status":"downloading","downloaded_bytes":10,"total_bytes":100}"#;
        assert_eq!(super::progress_line(plain), Some(("正在下载", 10, 100)));
        let unknown = b"PIKU_PROGRESS:{\"status\":\"downloading\",\"downloaded_bytes\":2048.0}\r";
        assert_eq!(super::progress_line(unknown), Some(("正在下载", 2048, 0)));
        let finished =
            br#"PIKU_PROGRESS:{"status":"finished","downloaded_bytes":300,"total_bytes":null}"#;
        assert_eq!(super::progress_line(finished), Some(("正在下载", 300, 300)));
    }
    #[test]
    fn postprocessing_lines_switch_to_processing_label() {
        assert_eq!(
            super::progress_line(b"[Merger] Merging formats into \"media.mp4\""),
            Some(("正在处理音视频", 0, 0))
        );
        assert_eq!(
            super::progress_line(b"[download] Destination: media.f625.mp4"),
            None
        );
        assert_eq!(super::progress_line(b"PIKU_PROGRESS:not json"), None);
    }
    #[test]
    fn failure_detail_prefers_component_error_line() {
        let stderr = b"[youtube] abc: Downloading webpage\nWARNING: slow\nERROR: [youtube] abc: Sign in to confirm you are not a bot\n";
        assert_eq!(
            super::failure_detail(stderr).unwrap(),
            "ERROR: [youtube] abc: Sign in to confirm you are not a bot"
        );
        assert_eq!(super::failure_detail(b"  \n").as_deref(), None);
        assert_eq!(
            super::failure_detail(&[b'x'; 600]).unwrap().chars().count(),
            240
        );
    }
    #[test]
    fn reads_only_video_metadata() {
        assert_eq!(
            super::probe_text("Stream #0: Video: h264, yuv420p, 1920x1080, 59.94 fps")["height"],
            1080
        );
        assert_eq!(
            super::probe_text(
                "Stream #0:0: Video: hevc (Main) (hvc1 / 0x31637668), 3840x2160, 60 fps"
            )["codec"],
            "hevc"
        );
        assert!(super::probe_text("Audio: aac").is_null());
    }
}
