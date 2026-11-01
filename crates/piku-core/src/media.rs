use crate::{
    backend::{now, text, Backend},
    links, output,
    process::{self, Progress},
    queue::Task,
};
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct ExternalRecord {
    pub source: links::Source,
    pub access: String,
    pub created: Instant,
    pub entries: Vec<Value>,
}

fn cancelled(cancel: &CancellationToken) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("下载已取消".into())
    } else {
        Ok(())
    }
}
fn number(value: &Value) -> u64 {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}
fn audio_args(extension: &str, copy: bool) -> Vec<String> {
    if extension == "mp3" {
        strings(&["-vn", "-c:a", "libmp3lame", "-b:a", "320k"])
    } else if copy {
        strings(&["-vn", "-c:a", "copy"])
    } else {
        strings(&["-vn", "-c:a", "aac", "-b:a", "192k"])
    }
}
fn strings(input: &[&str]) -> Vec<String> {
    input.iter().map(|s| (*s).into()).collect()
}
fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn stream_urls(stream: &Value) -> Vec<String> {
    let mut urls = vec![];
    for key in ["baseUrl", "base_url", "url"] {
        if let Some(url) = stream[key].as_str() {
            urls.push(url.to_owned());
            break;
        }
    }
    if let Some(backup) = stream
        .get("backupUrl")
        .or_else(|| stream.get("backup_url"))
        .and_then(Value::as_array)
    {
        urls.extend(backup.iter().filter_map(Value::as_str).map(str::to_owned));
    }
    urls
}
fn best_video(streams: &[Value], qn: u64) -> Option<&Value> {
    streams
        .iter()
        .filter(|s| number(&s["id"]) == qn)
        .max_by(|a, b| {
            links::fps(&a["frameRate"])
                .max(links::fps(&a["frame_rate"]))
                .total_cmp(&links::fps(&b["frameRate"]).max(links::fps(&b["frame_rate"])))
                .then_with(|| (a["codecid"] == 7).cmp(&(b["codecid"] == 7)))
                .then_with(|| number(&a["bandwidth"]).cmp(&number(&b["bandwidth"])))
        })
}
fn external_formats(info: &Value) -> Vec<Value> {
    let mut groups: HashMap<String, (f64, Value)> = HashMap::new();
    for format in info["formats"].as_array().unwrap_or(&vec![]) {
        let id = text(format, "format_id");
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
            || format["has_drm"] == true
            || format["vcodec"] == "none"
            || (format["vcodec"].is_null()
                && number(&format["height"]) == 0
                && number(&format["width"]) == 0)
            || text(format, "acodec").starts_with("iamf")
            || format["url"].as_str().is_none()
            || format["ext"] == "mhtml"
        {
            continue;
        }
        let height = number(&format["height"]);
        let fps = format["fps"].as_f64().unwrap_or(0.0);
        let hdr = !["", "SDR", "unknown"].contains(&text(format, "dynamic_range"));
        let key = format!("{height}:{}:{hdr}", fps.round());
        let score =
            if format["ext"] == "mp4" { 1e9 } else { 0.0 } + format["tbr"].as_f64().unwrap_or(0.0);
        if groups
            .get(&key)
            .is_some_and(|(previous, _)| *previous >= score)
        {
            continue;
        }
        let mut label = if height > 0 {
            format!("{height}p")
        } else {
            "原画".into()
        };
        if fps >= 49.0 {
            label.push_str(&format!("·{}fps", fps.round()));
        }
        if hdr {
            label.push_str("·HDR");
        }
        groups.insert(key, (score, json!({"id":id,"height":height,"fps":fps,"label":label,"available":true,"hasAudio":!text(format,"acodec").is_empty()&&format["acodec"]!="none"})));
    }
    let mut groups: Vec<_> = groups.into_values().collect();
    groups.sort_by(|a, b| {
        number(&b.1["height"])
            .cmp(&number(&a.1["height"]))
            .then_with(|| {
                b.1["fps"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .total_cmp(&a.1["fps"].as_f64().unwrap_or(0.0))
            })
            .then_with(|| b.0.total_cmp(&a.0))
    });
    groups.into_iter().map(|(_, value)| value).collect()
}
fn external_entries(info: &Value) -> Result<Vec<Value>, String> {
    if info["is_live"] == true
        || ["is_live", "is_upcoming", "post_live"].contains(&text(info, "live_status"))
    {
        return Err("请在直播结束并完成处理后再下载".into());
    }
    let source = info["entries"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![info.clone()]);
    let entries: Vec<_> = source.iter().take(20).enumerate().filter_map(|(index,item)| {
        if !item.is_object() { return None; }
        let video = external_formats(item);
        let audio = item["formats"].as_array().is_some_and(|formats| formats.iter().any(|f| f["has_drm"] != true && f["acodec"] != "none" && !text(f,"acodec").starts_with("iamf") && f["ext"] != "mhtml"));
        if video.is_empty() && !audio { return None; }
        Some(json!({"cid":uuid::Uuid::new_v4().to_string(),"index":item["playlist_index"].as_u64().unwrap_or(index as u64+1),
            "title":item["title"].as_str().or_else(||info["title"].as_str()).unwrap_or("未命名视频"),
            "owner":item["uploader"].as_str().or_else(||item["channel"].as_str()).or_else(||info["uploader"].as_str()).unwrap_or_default(),
            "cover":item["thumbnail"].as_str().or_else(||info["thumbnail"].as_str()).unwrap_or_default(),"duration":item["duration"].as_f64().unwrap_or(0.0),"video":video,"audio":audio}))
    }).collect();
    if entries.is_empty() {
        Err("没有找到可下载的视频，内容可能已删除或需要登录".into())
    } else {
        Ok(entries)
    }
}

impl Backend {
    async fn extractor(
        &self,
        cancel: &CancellationToken,
        progress: Progress,
    ) -> Result<(PathBuf, Vec<String>), String> {
        let exe = self
            .runtime
            .ensure("yt-dlp.exe", cancel, progress.clone())
            .await?;
        let js = self.runtime.ensure("qjs.exe", cancel, progress).await?;
        let mut args = strings(&[
            "--ignore-config",
            "--no-plugin-dirs",
            "--no-playlist",
            "--no-warnings",
            "--no-cache-dir",
            "--encoding",
            "utf-8",
            "--no-color",
            "--socket-timeout",
            "25",
            "--retries",
            "2",
            "--fragment-retries",
            "2",
            "--no-js-runtimes",
            "--js-runtimes",
        ]);
        args.push(format!("quickjs:{}", js.display()));
        Ok((exe, args))
    }
    pub async fn parse_input(
        &self,
        input: &str,
        access: &str,
        cancel: &CancellationToken,
        progress: Progress,
    ) -> Result<Value, String> {
        cancelled(cancel)?;
        let mut source = links::source(input)?;
        if source.platform != "bilibili" {
            let access = if access.is_empty() { "public" } else { access };
            let cookie = self.cookie_file(&source.platform, access)?;
            let (exe, mut args) = self.extractor(cancel, progress).await?;
            if let Some(cookie) = &cookie {
                args.extend(["--cookies".into(), path_string(cookie.path())]);
            }
            args.extend(strings(&[
                "--dump-single-json",
                "--skip-download",
                "--playlist-items",
                "1:20",
                "--",
            ]));
            args.push(source.url.clone());
            let bytes = process::run(&exe, &args, cancel, Duration::from_secs(120), None).await?;
            let info: Value =
                serde_json::from_slice(&bytes).map_err(|_| "下载组件返回无效视频信息")?;
            let entries = external_entries(&info)?;
            let first = &entries[0];
            let key = format!("external:{}", uuid::Uuid::new_v4());
            let result = json!({"platform":source.platform,"bvid":key,"title":info["title"].as_str().unwrap_or(text(first,"title")),"owner":first["owner"],"cover":first["cover"],"duration":first["duration"],"pages":entries.iter().enumerate().map(|(index,item)|json!({"cid":item["cid"],"page":index+1,"part":item["title"]})).collect::<Vec<_>>()});
            let mut parsed = self.parsed.lock();
            parsed.retain(|_, record| record.created.elapsed() < Duration::from_secs(1800));
            while parsed.len() >= 20 {
                if let Some(oldest) = parsed
                    .iter()
                    .min_by_key(|(_, r)| r.created)
                    .map(|(k, _)| k.clone())
                {
                    parsed.remove(&oldest);
                }
            }
            parsed.insert(
                key,
                ExternalRecord {
                    source,
                    access: access.into(),
                    created: Instant::now(),
                    entries,
                },
            );
            return Ok(result);
        }
        if url::Url::parse(&source.url)
            .ok()
            .is_some_and(|u| u.host_str() == Some("b23.tv"))
        {
            let response = tokio::select! {r=self.bili.head(&source.url).header("Referer","https://www.bilibili.com/").timeout(Duration::from_secs(15)).send()=>r.map_err(|_|"短链接展开失败")?,_=cancel.cancelled()=>return Err("下载已取消".into())};
            if !response.status().is_success() {
                return Err(format!("短链接展开失败：{}", response.status().as_u16()));
            }
            source = links::source(response.url().as_str())?;
            if source.platform != "bilibili" || source.key.starts_with("b23:") {
                return Err("短链接没有指向B站视频".into());
            }
        }
        let id = source
            .key
            .strip_prefix("bili:")
            .ok_or("无效的B站视频链接")?;
        let mut url = url::Url::parse("https://api.bilibili.com/x/web-interface/view").unwrap();
        if let Some(aid) = id.strip_prefix("av") {
            url.query_pairs_mut().append_pair("aid", aid);
        } else {
            url.query_pairs_mut().append_pair("bvid", id);
        }
        let info = self.api(url.as_str(), cancel).await?;
        Ok(
            json!({"bvid":info["bvid"],"title":info["title"],"owner":info["owner"]["name"],"cover":info["pic"],"duration":info["duration"],"pages":info["pages"].as_array().ok_or("视频没有可用分P")?.iter().map(|p|json!({"cid":p["cid"],"page":p["page"],"part":p["part"]})).collect::<Vec<_>>()}),
        )
    }
    fn external_lookup(&self, key: &str, cid: &Value) -> Result<(ExternalRecord, Value), String> {
        let parsed = self.parsed.lock();
        let record = parsed
            .get(key)
            .filter(|r| r.created.elapsed() < Duration::from_secs(1800))
            .ok_or("解析结果已过期，请重新解析")?;
        let entry = record
            .entries
            .iter()
            .find(|e| e["cid"] == *cid)
            .ok_or("请选择要下载的视频")?;
        Ok((record.clone(), entry.clone()))
    }
    pub async fn formats(
        &self,
        bvid: &str,
        cid: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        if bvid.starts_with("external:") {
            let (_, entry) = self.external_lookup(bvid, cid)?;
            return Ok(json!({"video":entry["video"],"audio":entry["audio"]}));
        }
        let data = self.play(bvid, cid, 127, cancel).await?;
        let mut streams = data["dash"]["video"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let accepted = data["accept_quality"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if data["dash"].is_null() {
            for qn in [120, 116, 74] {
                if accepted.iter().any(|id| number(id) == qn) {
                    if let Ok(extra) = self.play(bvid, cid, qn, cancel).await {
                        streams.extend(
                            extra["dash"]["video"]
                                .as_array()
                                .cloned()
                                .unwrap_or_default(),
                        );
                    }
                }
            }
        }
        let video:Vec<_>=accepted.iter().enumerate().map(|(index,id)|{let selected=best_video(&streams,number(id));json!({"id":id,"label":data["accept_description"][index],"available":selected.is_some()||(data["dash"].is_null()&&data["quality"]==*id),"fps":selected.map(|s|links::fps(&s["frameRate"]).max(links::fps(&s["frame_rate"]))).unwrap_or(0.0)})}).collect();
        Ok(
            json!({"video":video,"audio":data["dash"]["audio"].as_array().is_some_and(|a|!a.is_empty())||data["durl"].as_array().is_some_and(|a|!a.is_empty())}),
        )
    }
    pub async fn download_media(
        &self,
        opts: &Value,
        task: &Task,
        progress: Progress,
    ) -> Result<Value, String> {
        cancelled(&task.cancel)?;
        let external_record = if text(opts, "bvid").starts_with("external:") {
            Some(self.external_lookup(text(opts, "bvid"), &opts["cid"])?.0)
        } else {
            None
        };
        tokio::fs::create_dir_all(&task.folder)
            .await
            .map_err(|_| "无法创建下载目录")?;
        let audio = opts["kind"] == "audio";
        let extension = if audio {
            if opts["audioFormat"] == "mp3" {
                "mp3"
            } else {
                "m4a"
            }
        } else {
            "mp4"
        };
        let target = task.folder.join(format!(
            "{}.{extension}",
            links::safe_name(text(opts, "title"))
        ));
        task.files.lock().target = Some(target.clone());
        if tokio::fs::symlink_metadata(&target).await.is_ok() {
            return Err("同名文件已存在，请更换目录或文件名".into());
        }
        let temp = tempfile::Builder::new()
            .prefix(".bilidown-")
            .tempdir_in(&task.folder)
            .map_err(|_| "无法创建下载暂存目录")?
            .keep();
        task.files.lock().temp = Some(temp.clone());
        let ffmpeg = self
            .runtime
            .ensure("ffmpeg.exe", &task.cancel, progress.clone())
            .await?;
        let external = text(opts, "bvid").starts_with("external:");
        let file = if external {
            self.download_external(opts, task, &temp, &ffmpeg, extension, progress.clone())
                .await?
        } else {
            self.download_bili(opts, task, &temp, &ffmpeg, extension, progress.clone())
                .await?
        };
        let meta = tokio::fs::metadata(&file)
            .await
            .map_err(|_| "下载组件未生成文件")?;
        if !meta.is_file() || meta.len() == 0 {
            return Err("下载组件未生成有效文件".into());
        }
        let video = if audio {
            Value::Null
        } else {
            process::inspect(&ffmpeg, &file, &task.cancel)
                .await
                .unwrap_or(Value::Null)
        };
        cancelled(&task.cancel)?;
        progress("正在发布文件".into(), 0, 0);
        let owned = task.files.clone();
        let cancel = task.cancel.clone();
        let destination = target.clone();
        let result = tokio::task::spawn_blocking(move || {
            output::publish(&file, &destination, &cancel, || owned.lock().owned = true)
        })
        .await
        .map_err(|_| "文件发布任务异常")?;
        if let Err(error) = result {
            if task.files.lock().owned && !task.cancel.is_cancelled() {
                task.files.lock().warning = Some("正式文件已保存，但暂存文件清理失败".into());
            } else if error.kind() == std::io::ErrorKind::AlreadyExists {
                return Err("同名文件已存在，请更换目录或文件名".into());
            } else {
                cancelled(&task.cancel)?;
                return Err(format!("文件保存失败：{error}"));
            }
        }
        cancelled(&task.cancel)?;
        let kind = if audio { "audio" } else { "video" };
        let mut history = json!({"taskId":task.id,"title":opts["title"],"qn":opts["qn"],"kind":kind,"format":extension,"video":video,"file":target,"date":now()});
        if let Some(record) = external_record {
            history["platform"] = json!(record.source.platform);
            history["url"] = json!(record.source.url);
        } else {
            history["bvid"] = opts["bvid"].clone();
        }
        if self.history_add(history).is_err() {
            task.files.lock().warning = Some("正式文件已保存，但下载历史保存失败".into());
        }
        Ok(json!({"file":target,"kind":kind,"video":video}))
    }
    async fn download_external(
        &self,
        opts: &Value,
        task: &Task,
        temp: &Path,
        ffmpeg: &Path,
        extension: &str,
        progress: Progress,
    ) -> Result<PathBuf, String> {
        let (record, entry) = self.external_lookup(text(opts, "bvid"), &opts["cid"])?;
        let cookie = self.cookie_file(&record.source.platform, &record.access)?;
        let (exe, mut args) = self.extractor(&task.cancel, progress.clone()).await?;
        if let Some(cookie) = &cookie {
            args.extend(["--cookies".into(), path_string(cookie.path())]);
        }
        let audio = opts["kind"] == "audio";
        if audio {
            if entry["audio"] != true {
                return Err("这个视频没有可用音轨".into());
            }
            args.extend(strings(&[
                "-f",
                "bestaudio[acodec!^=iamf]/best[acodec!^=iamf]",
                "-x",
                "--audio-format",
                extension,
                "--audio-quality",
                if extension == "mp3" { "320K" } else { "0" },
            ]));
        } else {
            let qn = opts["qn"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| opts["qn"].to_string());
            let selected = entry["video"]
                .as_array()
                .and_then(|a| a.iter().find(|v| v["id"] == qn))
                .ok_or("所选画质不可用，请重新解析")?;
            let selection = if selected["hasAudio"] == true {
                qn.clone()
            } else {
                format!("{qn}+bestaudio[ext=m4a][acodec!^=iamf]/{qn}+bestaudio[acodec!^=iamf]/{qn}")
            };
            args.extend(["-f".into(), selection]);
            args.extend(strings(&[
                "--merge-output-format",
                "mp4",
                "--remux-video",
                "mp4",
            ]));
        }
        args.extend([
            "--ffmpeg-location".into(),
            path_string(ffmpeg),
            "--playlist-items".into(),
            entry["index"].to_string(),
        ]);
        args.extend(strings(&[
            "--no-simulate",
            "--no-overwrites",
            "--newline",
            "--progress",
            "--progress-template",
            "download:PIKU_PROGRESS:%(progress)j",
            "-o",
        ]));
        args.extend([
            path_string(&temp.join("media.%(ext)s")),
            "--".into(),
            record.source.url,
        ]);
        process::run(
            &exe,
            &args,
            &task.cancel,
            Duration::from_secs(24 * 3600),
            Some(progress),
        )
        .await?;
        cancelled(&task.cancel)?;
        Ok(temp.join(format!("media.{extension}")))
    }
    async fn download_bili(
        &self,
        opts: &Value,
        task: &Task,
        temp: &Path,
        ffmpeg: &Path,
        extension: &str,
        progress: Progress,
    ) -> Result<PathBuf, String> {
        let audio = opts["kind"] == "audio";
        let data = self
            .play(
                text(opts, "bvid"),
                &opts["cid"],
                if audio { 80 } else { number(&opts["qn"]) },
                &task.cancel,
            )
            .await?;
        let sounds = data["dash"]["audio"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let sound = sounds.iter().max_by_key(|s| number(&s["bandwidth"]));
        let mut args = strings(&["-hide_banner", "-loglevel", "error"]);
        if let Some(sound) = sound.filter(|_| audio) {
            transfer(
                &self.bili,
                &stream_urls(sound),
                &temp.join("audio"),
                &task.cancel,
                progress.clone(),
            )
            .await?;
            args.extend(["-i".into(), path_string(&temp.join("audio"))]);
            args.extend(audio_args(extension, true));
        } else if !audio && !data["dash"].is_null() {
            let streams = data["dash"]["video"]
                .as_array()
                .ok_or("没有可下载的视频流")?;
            progress("正在检测原始视频帧率".into(), 0, 0);
            let candidates: Vec<_> = streams
                .iter()
                .filter(|s| number(&s["id"]) == number(&opts["qn"]))
                .take(8)
                .cloned()
                .collect();
            let measured = futures_util::future::join_all(candidates.into_iter().map(
                |mut stream| async move {
                    if let Some(url) = stream_urls(&stream).first() {
                        if let Ok(info) = process::inspect_remote(ffmpeg, url, &task.cancel).await {
                            if info["fps"].as_f64().is_some_and(|n| n > 0.0) {
                                stream["frameRate"] = info["fps"].clone();
                                stream["frame_rate"] = Value::Null;
                            }
                        }
                    }
                    stream
                },
            ))
            .await;
            let video = best_video(&measured, number(&opts["qn"]))
                .ok_or("当前账号无法下载所选画质，请重新解析或登录")?;
            let sums = Arc::new(Mutex::new([(0u64, 0u64); 2]));
            let has_audio = sound.is_some();
            let aggregate = |index: usize| -> Progress {
                let sums = sums.clone();
                let report = progress.clone();
                Arc::new(move |_, received, total| {
                    let values = {
                        let mut values = sums.lock();
                        accumulate_transfer(&mut values[index], received, total);
                        *values
                    };
                    report(
                        "正在下载音视频".into(),
                        values[0].0 + values[1].0,
                        if values[0].1 > 0 && (!has_audio || values[1].1 > 0) {
                            values[0].1 + values[1].1
                        } else {
                            0
                        },
                    );
                })
            };
            let group = task.cancel.child_token();
            let video_path = temp.join("video");
            let audio_path = temp.join("audio");
            let video_urls = stream_urls(video);
            let video_transfer = async {
                let result =
                    transfer(&self.bili, &video_urls, &video_path, &group, aggregate(0)).await;
                if result.is_err() {
                    group.cancel();
                }
                result
            };
            let audio_transfer = async {
                if let Some(sound) = sound {
                    let result = transfer(
                        &self.bili,
                        &stream_urls(sound),
                        &audio_path,
                        &group,
                        aggregate(1),
                    )
                    .await;
                    if result.is_err() {
                        group.cancel();
                    }
                    result
                } else {
                    Ok(())
                }
            };
            let (video_result, audio_result) = tokio::join!(video_transfer, audio_transfer);
            stream_results(video_result, audio_result)?;
            args.extend(["-i".into(), path_string(&video_path)]);
            if sound.is_some() {
                args.extend(["-i".into(), path_string(&audio_path)]);
            }
            args.extend(strings(&["-c", "copy"]));
        } else {
            let segments = data["durl"]
                .as_array()
                .filter(|a| !a.is_empty())
                .ok_or("所选格式不可用")?;
            if !audio && number(&data["quality"]) != number(&opts["qn"]) {
                return Err("所选画质不可用".into());
            }
            let mut list = String::new();
            for (index, segment) in segments.iter().enumerate() {
                transfer(
                    &self.bili,
                    &stream_urls(segment),
                    &temp.join(format!("seg{index}")),
                    &task.cancel,
                    progress.clone(),
                )
                .await?;
                list.push_str(&format!("file 'seg{index}'\n"));
            }
            tokio::fs::write(temp.join("list.txt"), list)
                .await
                .map_err(|_| "无法保存分段清单")?;
            args.extend(strings(&["-f", "concat", "-safe", "0", "-i"]));
            args.push(path_string(&temp.join("list.txt")));
            args.extend(if audio {
                audio_args(extension, false)
            } else {
                strings(&["-c", "copy"])
            });
        }
        cancelled(&task.cancel)?;
        progress(
            if audio {
                "正在处理音频"
            } else {
                "正在合并音视频"
            }
            .into(),
            0,
            0,
        );
        let file = temp.join(format!("output.{extension}"));
        args.extend(["-n".into(), path_string(&file)]);
        process::run(
            ffmpeg,
            &args,
            &task.cancel,
            Duration::from_secs(24 * 3600),
            None,
        )
        .await?;
        Ok(file)
    }
}

async fn transfer(
    client: &reqwest::Client,
    urls: &[String],
    file: &Path,
    cancel: &CancellationToken,
    progress: Progress,
) -> Result<(), String> {
    transfer_with_stall(
        client,
        urls,
        file,
        cancel,
        progress,
        Duration::from_secs(15),
    )
    .await
}
fn stream_results(video: Result<(), String>, audio: Result<(), String>) -> Result<(), String> {
    match (video, audio) {
        (Err(video), Err(audio)) if video == "下载已取消" && audio != "下载已取消" => {
            Err(audio)
        }
        (Err(error), _) | (_, Err(error)) => Err(error),
        _ => Ok(()),
    }
}
fn accumulate_transfer(previous: &mut (u64, u64), received: u64, total: u64) {
    if total > 0 && received == total {
        *previous = (received, total);
        return;
    }
    previous.0 = previous.0.max(received);
    if previous.1 > 0 || total > 0 {
        previous.1 = previous.1.max(total).max(previous.0);
    }
}
async fn transfer_with_stall(
    client: &reqwest::Client,
    urls: &[String],
    file: &Path,
    cancel: &CancellationToken,
    progress: Progress,
    stall: Duration,
) -> Result<(), String> {
    let mut last = "没有可用的媒体源".to_owned();
    for url in urls {
        cancelled(cancel)?;
        let Ok(parsed) = url::Url::parse(url) else {
            continue;
        };
        if !["http", "https"].contains(&parsed.scheme())
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            continue;
        }
        progress("正在下载".into(), 0, 0);
        let result=async{
            let response=tokio::select!{r=tokio::time::timeout(stall,client.get(url).header("Referer","https://www.bilibili.com/").send())=>r.map_err(|_|"媒体源无响应")?.map_err(|_|"媒体源连接失败")?,_=cancel.cancelled()=>return Err("下载已取消".to_owned())};
            if !response.status().is_success(){return Err(format!("媒体源返回{}",response.status().as_u16()));}
            let total=response.content_length().unwrap_or(0);let mut received=0;
            let mut stream=response.bytes_stream();let output=tokio::fs::File::create(file).await.map_err(|_|"无法创建媒体暂存文件")?;
            let mut writer=BufWriter::with_capacity(1024*1024,output);
            loop{
                let chunk=tokio::select!{r=tokio::time::timeout(stall,stream.next())=>r.map_err(|_|"媒体源无数据超时")?,_=cancel.cancelled()=>return Err("下载已取消".into())};
                let Some(chunk)=chunk else{break;};let chunk=chunk.map_err(|_|"媒体源传输中断")?;
                writer.write_all(&chunk).await.map_err(|_|"媒体保存失败，请检查磁盘空间与文件大小限制")?;
                cancelled(cancel)?;
                received+=chunk.len()as u64;progress("正在下载".into(),received,total);
            }
            writer.flush().await.map_err(|_|"媒体保存失败，请检查磁盘空间")?;
            if received==0||total>0&&received!=total{return Err("媒体源返回不完整文件".into());}
            progress("正在下载".into(),received,if total==0{received}else{total});Ok(())
        }.await;
        match result {
            Ok(()) => return Ok(()),
            Err(error) => {
                last = error;
                let _ = tokio::fs::remove_file(file).await;
            }
        }
    }
    cancelled(cancel)?;
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formats_group_by_height_fps_and_prefer_mp4() {
        let info = json!({"formats":[{"format_id":"1","height":720,"fps":30,"vcodec":"vp9","acodec":"none","ext":"webm","url":"https://example.test"},{"format_id":"2","height":720,"fps":30,"vcodec":"h264","acodec":"none","ext":"mp4","url":"https://example.test"},{"format_id":"3","height":1080,"vcodec":"h264","has_drm":true,"url":"https://example.test"}]});
        let formats = external_formats(&info);
        assert_eq!(formats.len(), 1);
        assert_eq!(formats[0]["id"], "2");
    }
    #[test]
    fn rejects_live_and_invalid_format_ids() {
        assert!(external_entries(&json!({"is_live":true})).is_err());
        assert!(external_formats(&json!({"formats":[{"format_id":"1;anything","height":720,"url":"https://example.test"}]})).is_empty());
    }
    #[test]
    fn chooses_high_fps_and_audio_encoding() {
        let streams = vec![
            json!({"id":80,"frameRate":"30","bandwidth":900}),
            json!({"id":80,"frameRate":"60000/1001","bandwidth":500}),
        ];
        assert_eq!(best_video(&streams, 80).unwrap()["bandwidth"], 500);
        assert!(audio_args("mp3", true).contains(&"libmp3lame".into()));
        assert!(audio_args("m4a", true).contains(&"copy".into()));
    }
}

#[cfg(test)]
#[path = "media_transfer_tests.rs"]
mod transfer_tests;
