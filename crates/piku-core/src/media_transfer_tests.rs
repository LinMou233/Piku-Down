use super::*;
use tokio::{io::AsyncReadExt, net::TcpListener, sync::Notify, task::JoinHandle};

async fn server(
    header_delay: Duration,
    body: Vec<(Duration, Vec<u8>)>,
    size: usize,
) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 2048];
        let _ = socket.read(&mut request).await;
        tokio::time::sleep(header_delay).await;
        if socket
            .write_all(
                format!("HTTP/1.1 200 OK\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .is_err()
        {
            return;
        }
        for (delay, bytes) in body {
            tokio::time::sleep(delay).await;
            if socket.write_all(&bytes).await.is_err() {
                break;
            }
        }
    });
    (format!("http://{address}/media"), task)
}
fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}
fn progress() -> Progress {
    Arc::new(|_, _, _| {})
}

#[tokio::test]
async fn stalled_headers_switch_to_backup_without_exposing_partial_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("media");
    let (bad, bad_task) = server(Duration::from_secs(2), vec![], 8).await;
    let (good, good_task) = server(
        Duration::ZERO,
        vec![(Duration::ZERO, b"complete".to_vec())],
        8,
    )
    .await;
    transfer_with_stall(
        &client(),
        &[bad, good],
        &file,
        &CancellationToken::new(),
        progress(),
        Duration::from_millis(200),
    )
    .await
    .unwrap();
    assert_eq!(tokio::fs::read(file).await.unwrap(), b"complete");
    bad_task.abort();
    good_task.await.unwrap();
}
#[tokio::test]
async fn partial_response_is_truncated_before_backup_download() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("media");
    let (bad, bad_task) = server(Duration::ZERO, vec![(Duration::ZERO, b"part".to_vec())], 8).await;
    let (good, good_task) = server(
        Duration::ZERO,
        vec![(Duration::ZERO, b"complete".to_vec())],
        8,
    )
    .await;
    transfer_with_stall(
        &client(),
        &[bad, good],
        &file,
        &CancellationToken::new(),
        progress(),
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    assert_eq!(tokio::fs::read(file).await.unwrap(), b"complete");
    bad_task.await.unwrap();
    good_task.await.unwrap();
}
#[tokio::test]
async fn stalled_body_switches_to_backup_and_discards_partial_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("media");
    let (bad, bad_task) = server(
        Duration::ZERO,
        vec![
            (Duration::ZERO, b"part".to_vec()),
            (Duration::from_secs(2), b"rest".to_vec()),
        ],
        8,
    )
    .await;
    let (good, good_task) = server(
        Duration::ZERO,
        vec![(Duration::ZERO, b"complete".to_vec())],
        8,
    )
    .await;
    transfer_with_stall(
        &client(),
        &[bad, good],
        &file,
        &CancellationToken::new(),
        progress(),
        Duration::from_millis(200),
    )
    .await
    .unwrap();
    assert_eq!(tokio::fs::read(file).await.unwrap(), b"complete");
    bad_task.abort();
    good_task.await.unwrap();
}
#[tokio::test]
async fn watchdog_measures_silence_instead_of_total_time() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("media");
    let (url, task) = server(
        Duration::ZERO,
        (0..5)
            .map(|_| (Duration::from_millis(80), vec![1; 1024]))
            .collect(),
        5120,
    )
    .await;
    let started = Instant::now();
    transfer_with_stall(
        &client(),
        &[url],
        &file,
        &CancellationToken::new(),
        progress(),
        Duration::from_millis(250),
    )
    .await
    .unwrap();
    assert!(started.elapsed() > Duration::from_millis(250));
    assert_eq!(tokio::fs::metadata(file).await.unwrap().len(), 5120);
    task.await.unwrap();
}
#[tokio::test]
async fn explicit_cancel_closes_file_and_does_not_fetch_backup() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("media");
    let (url, task) = server(
        Duration::ZERO,
        vec![
            (Duration::ZERO, vec![1; 8192]),
            (Duration::from_secs(2), vec![2; 8192]),
        ],
        16384,
    )
    .await;
    let backup = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backup_url = format!("http://{}/backup", backup.local_addr().unwrap());
    let cancel = CancellationToken::new();
    let received = Arc::new(Notify::new());
    let signal = received.clone();
    let callback: Progress = Arc::new(move |_, bytes, _| {
        if bytes > 0 {
            signal.notify_one();
        }
    });
    let active = {
        let file = file.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move {
            transfer_with_stall(
                &client(),
                &[url, backup_url],
                &file,
                &cancel,
                callback,
                Duration::from_secs(2),
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(2), received.notified())
        .await
        .unwrap();
    cancel.cancel();
    assert_eq!(active.await.unwrap().unwrap_err(), "下载已取消");
    assert!(!file.exists());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), backup.accept())
            .await
            .is_err()
    );
    task.abort();
}
#[test]
fn sibling_cancellation_preserves_the_original_stream_error() {
    assert_eq!(
        stream_results(Err("下载已取消".into()), Err("音频源传输失败".into())).unwrap_err(),
        "音频源传输失败"
    );
    assert_eq!(
        stream_results(Err("视频源传输失败".into()), Err("下载已取消".into())).unwrap_err(),
        "视频源传输失败"
    );
    assert_eq!(
        stream_results(Err("下载已取消".into()), Err("下载已取消".into())).unwrap_err(),
        "下载已取消"
    );
}
#[test]
fn retry_progress_holds_bytes_until_backup_catches_up() {
    let mut count = (30, 100);
    accumulate_transfer(&mut count, 0, 0);
    assert_eq!(count, (30, 100));
    accumulate_transfer(&mut count, 20, 100);
    assert_eq!(count, (30, 100));
    accumulate_transfer(&mut count, 100, 100);
    assert_eq!(count, (100, 100));
    let mut unknown = (20, 0);
    accumulate_transfer(&mut unknown, 0, 0);
    assert_eq!(unknown, (20, 0));
    accumulate_transfer(&mut unknown, 15, 15);
    assert_eq!(unknown, (15, 15));
}
