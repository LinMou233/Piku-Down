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
        return Err("解析或下载失败，请确认网页能访问该视频及账号权限".into());
    }
    Ok(output.stdout)
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
                        if let Some(data) = line.strip_prefix(b"PIKU_PROGRESS:") {
                            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(data) {
                                let received = value["downloaded_bytes"].as_u64().unwrap_or(0);
                                let total = value["total_bytes"]
                                    .as_u64()
                                    .or_else(|| value["total_bytes_estimate"].as_u64())
                                    .unwrap_or(0);
                                let label = if value["status"] == "finished" {
                                    "正在处理音视频"
                                } else {
                                    "正在下载"
                                };
                                callback(label.into(), received, total);
                            }
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
    if let Some(size) = size {
        serde_json::json!({"width":size[1].parse::<u32>().unwrap_or(0),"height":size[2].parse::<u32>().unwrap_or(0),"fps":fps})
    } else {
        serde_json::Value::Null
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn reads_only_video_metadata() {
        assert_eq!(
            super::probe_text("Stream #0: Video: h264, yuv420p, 1920x1080, 59.94 fps")["height"],
            1080
        );
        assert!(super::probe_text("Audio: aac").is_null());
    }
}
