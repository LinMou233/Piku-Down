use piku_core::{host::HeadlessHost, Backend};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let directory = PathBuf::from(args.next().ok_or("用法：download <测试目录> <视频链接>")?);
    let input = args.next().ok_or("缺少视频链接")?;
    if !directory.is_absolute() {
        return Err("测试目录必须是绝对路径".into());
    }
    std::fs::create_dir_all(&directory)?;
    let backend = Arc::new(Backend::new(
        directory.join("profile"),
        Arc::new(HeadlessHost),
    )?);
    let progress = Arc::new(|label: String, received: u64, total: u64| {
        if received == 0 {
            println!("{label}：{received}/{total}");
        }
    });
    let cancel = CancellationToken::new();
    let parsed = backend
        .parse_input(&input, "public", &cancel, progress)
        .await?;
    let cid = &parsed["pages"][0]["cid"];
    let formats = backend
        .formats(parsed["bvid"].as_str().ok_or("缺少视频ID")?, cid, &cancel)
        .await?;
    let available: Vec<_> = formats["video"]
        .as_array()
        .ok_or("缺少视频画质")?
        .iter()
        .filter(|f| f["available"] == true)
        .collect();
    let selected = available.last().ok_or("没有可用画质")?;
    let result=backend.single(json!({"folder":directory,"bvid":parsed["bvid"],"cid":cid,"qn":selected["id"],"kind":"video","title":parsed["title"]})).await?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    backend.shutdown().await;
    Ok(())
}
