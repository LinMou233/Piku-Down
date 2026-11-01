use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

fn aborted(cancel: &CancellationToken) -> io::Result<()> {
    if cancel.is_cancelled() {
        Err(io::Error::new(io::ErrorKind::Interrupted, "下载已取消"))
    } else {
        Ok(())
    }
}
#[cfg(windows)]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn MoveFileExW(src: *const u16, dst: *const u16, flags: u32) -> i32;
    fn GetVolumePathNameW(path: *const u16, root: *mut u16, len: u32) -> i32;
    fn GetVolumeInformationW(
        root: *const u16,
        name: *mut u16,
        name_len: u32,
        serial: *mut u32,
        max: *mut u32,
        flags: *mut u32,
        format: *mut u16,
        format_len: u32,
    ) -> i32;
}
pub fn move_no_replace(src: &Path, dst: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        if unsafe { MoveFileExW(wide(src).as_ptr(), wide(dst).as_ptr(), 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::hard_link(src, dst)?;
        fs::remove_file(src)
    }
}
#[cfg(windows)]
fn supports_links(path: &Path) -> io::Result<bool> {
    let mut root = vec![0u16; 32768];
    if unsafe { GetVolumePathNameW(wide(path).as_ptr(), root.as_mut_ptr(), root.len() as u32) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut flags = 0;
    let mut serial = 0;
    let mut max = 0;
    if unsafe {
        GetVolumeInformationW(
            root.as_ptr(),
            std::ptr::null_mut(),
            0,
            &mut serial,
            &mut max,
            &mut flags,
            std::ptr::null_mut(),
            0,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(flags & 0x00400000 != 0)
}
fn fallback(error: &io::Error, src: &Path, target: &Path) -> bool {
    if !fs::symlink_metadata(src)
        .map(|m| m.is_file())
        .unwrap_or(false)
    {
        return false;
    }
    #[cfg(windows)]
    {
        match error.raw_os_error() {
            Some(17 | 50) => true,
            Some(1 | 5 | 267) => {
                supports_links(target.parent().unwrap_or(target)).is_ok_and(|x| !x)
            }
            _ => false,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        matches!(error.raw_os_error(), Some(18 | 95))
    }
}
fn copy_checked(src: &Path, dst: &Path, cancel: &CancellationToken) -> io::Result<()> {
    let mut input = fs::File::open(src)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dst)?;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        aborted(cancel)?;
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        output.write_all(&buffer[..n])?;
    }
    output.sync_all()?;
    aborted(cancel)
}
pub fn publish(
    src: &Path,
    target: &Path,
    cancel: &CancellationToken,
    on_created: impl FnOnce(),
) -> io::Result<()> {
    publish_inner(src, target, cancel, on_created, false, &copy_checked)
}
fn publish_inner(
    src: &Path,
    target: &Path,
    cancel: &CancellationToken,
    on_created: impl FnOnce(),
    force_copy: bool,
    copy: &dyn Fn(&Path, &Path, &CancellationToken) -> io::Result<()>,
) -> io::Result<()> {
    aborted(cancel)?;
    let direct = if force_copy {
        Err(io::Error::from_raw_os_error(17))
    } else {
        fs::hard_link(src, target)
    };
    let mut stage = None;
    let result = (|| {
        if let Err(error) = direct {
            if !force_copy && !fallback(&error, src, target) {
                return Err(error);
            }
            aborted(cancel)?;
            let directory = tempfile::Builder::new()
                .prefix(".bilidown-output-")
                .tempdir_in(
                    target
                        .parent()
                        .ok_or_else(|| io::Error::other("无效输出目录"))?,
                )?;
            let staged = directory.path().join("output");
            stage = Some(directory);
            copy(src, &staged, cancel)?;
            aborted(cancel)?;
            match fs::hard_link(&staged, target) {
                Ok(()) => (),
                Err(error) => {
                    if !fallback(&error, &staged, target) {
                        return Err(error);
                    }
                    move_no_replace(&staged, target)?;
                }
            }
        }
        // 先登记所有权，发布后取消才能准确清理本任务文件。
        on_created();
        aborted(cancel)?;
        fs::remove_file(src)
    })();
    let cleanup = if let Some(stage) = stage {
        stage.close()
    } else {
        Ok(())
    };
    result.and(cleanup)
}
pub async fn cleanup_owned(
    folder: &Path,
    temp: Option<PathBuf>,
    owned: Option<PathBuf>,
    cancelled: bool,
) -> Result<(), String> {
    let mut errors = false;
    if let Some(temp) = temp {
        if temp.parent() != Some(folder)
            || !temp
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .starts_with(".bilidown-")
        {
            return Err("拒绝清理任务范围之外的目录".into());
        }
        for attempt in 0..4 {
            match tokio::fs::remove_dir_all(&temp).await {
                Ok(()) => break,
                Err(e) if e.kind() == io::ErrorKind::NotFound => break,
                Err(_) if attempt < 3 => {
                    tokio::time::sleep(std::time::Duration::from_millis(150 * (attempt + 1))).await
                }
                Err(_) => errors = true,
            }
        }
    }
    if cancelled {
        if let Some(target) = owned {
            if target.parent() != Some(folder) {
                return Err("拒绝清理任务范围之外的文件".into());
            }
            if let Err(e) = tokio::fs::remove_file(target).await {
                if e.kind() != io::ErrorKind::NotFound {
                    errors = true;
                }
            }
        }
    }
    if errors {
        Err("当前任务文件清理失败，请检查文件是否被占用".into())
    } else {
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn test_dir() -> tempfile::TempDir {
        match std::env::var_os("PIKU_OUTPUT_TEST_ROOT") {
            Some(root) => tempfile::tempdir_in(root).unwrap(),
            None => tempfile::tempdir().unwrap(),
        }
    }
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    #[test]
    fn publish_records_ownership_and_removes_source() {
        let d = test_dir();
        let src = d.path().join("src");
        let dst = d.path().join("dst");
        fs::write(&src, b"complete").unwrap();
        let mut owned = false;
        publish(&src, &dst, &CancellationToken::new(), || owned = true).unwrap();
        assert!(owned);
        assert_eq!(fs::read(dst).unwrap(), b"complete");
        assert!(!src.exists());
    }
    #[test]
    fn publishes_between_test_and_system_directories() {
        let test = test_dir();
        let system = tempfile::tempdir().unwrap();
        for (source, target) in [(system.path(), test.path()), (test.path(), system.path())] {
            let src = source.join("cross-source");
            let dst = target.join("cross-target");
            fs::write(&src, b"complete cross-volume output").unwrap();
            let mut owned = false;
            publish(&src, &dst, &CancellationToken::new(), || owned = true).unwrap();
            assert!(owned);
            assert!(!src.exists());
            assert_eq!(fs::read(&dst).unwrap(), b"complete cross-volume output");
            fs::remove_file(dst).unwrap();
        }
    }
    #[test]
    fn directories_never_enter_unsupported_link_fallback() {
        let dir = test_dir();
        assert!(!fallback(
            &io::Error::from_raw_os_error(50),
            dir.path(),
            &dir.path().join("target")
        ));
    }
    #[test]
    fn existing_target_is_never_overwritten() {
        let d = test_dir();
        let src = d.path().join("src");
        let dst = d.path().join("dst");
        fs::write(&src, b"new").unwrap();
        fs::write(&dst, b"existing").unwrap();
        assert!(publish(&src, &dst, &CancellationToken::new(), || panic!(
            "not owned"
        ))
        .is_err());
        assert_eq!(fs::read(dst).unwrap(), b"existing");
        assert!(src.exists());
    }
    #[test]
    fn failed_copy_leaves_no_final_or_stage() {
        let d = test_dir();
        let src = d.path().join("src");
        let dst = d.path().join("dst");
        fs::write(&src, b"new").unwrap();
        let result = publish_inner(
            &src,
            &dst,
            &CancellationToken::new(),
            || panic!("not owned"),
            true,
            &|_, dst, _| {
                fs::write(dst, b"partial")?;
                Err(io::Error::from_raw_os_error(112))
            },
        );
        assert!(result.is_err());
        assert!(!dst.exists());
        assert_eq!(fs::read_dir(d.path()).unwrap().count(), 1);
    }
    #[test]
    fn cancellation_during_copy_cleans_stage() {
        let d = test_dir();
        let src = d.path().join("src");
        let dst = d.path().join("dst");
        fs::write(&src, b"new").unwrap();
        let token = CancellationToken::new();
        let result = publish_inner(
            &src,
            &dst,
            &token,
            || panic!("not owned"),
            true,
            &|_, p, t| {
                fs::write(p, b"partial")?;
                t.cancel();
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!dst.exists());
        assert_eq!(fs::read_dir(d.path()).unwrap().count(), 1);
    }
    #[test]
    fn cancellation_after_publish_records_owner() {
        let d = test_dir();
        let src = d.path().join("src");
        let dst = d.path().join("dst");
        fs::write(&src, b"new").unwrap();
        let token = CancellationToken::new();
        let owned = AtomicBool::new(false);
        assert!(publish(&src, &dst, &token, || {
            owned.store(true, Ordering::SeqCst);
            token.cancel();
        })
        .is_err());
        assert!(owned.load(Ordering::SeqCst));
        assert!(dst.exists());
    }
    #[test]
    fn simultaneous_publish_has_one_winner() {
        let d = test_dir();
        let dst = d.path().join("dst");
        let gate = Arc::new(std::sync::Barrier::new(2));
        let mut threads = Vec::new();
        for i in 0..2 {
            let src = d.path().join(format!("s{i}"));
            fs::write(&src, format!("task{i}")).unwrap();
            let dst = dst.clone();
            let gate = gate.clone();
            threads.push(std::thread::spawn(move || {
                gate.wait();
                publish_inner(
                    &src,
                    &dst,
                    &CancellationToken::new(),
                    || {},
                    true,
                    &copy_checked,
                )
                .is_ok()
            }));
        }
        assert_eq!(
            threads
                .into_iter()
                .filter_map(|h| h.join().ok())
                .filter(|x| *x)
                .count(),
            1
        );
        assert!(matches!(
            fs::read_to_string(dst).unwrap().as_str(),
            "task0" | "task1"
        ));
        assert!(!fs::read_dir(d.path()).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".bilidown-output-")));
    }
    #[tokio::test]
    async fn cleanup_refuses_other_task_paths() {
        let d = test_dir();
        let other = test_dir();
        assert!(
            cleanup_owned(d.path(), Some(other.path().to_owned()), None, true)
                .await
                .is_err()
        );
        assert!(other.path().exists());
    }
}
