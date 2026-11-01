use crate::{
    backend::{text, Backend},
    links, output,
    process::Progress,
};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
type DownloadResult = Result<Value, String>;
#[derive(Default, Clone)]
pub struct TaskFiles {
    pub temp: Option<PathBuf>,
    pub target: Option<PathBuf>,
    pub owned: bool,
    pub warning: Option<String>,
}
#[derive(Clone)]
pub struct Task {
    pub id: String,
    pub folder: PathBuf,
    pub cancel: CancellationToken,
    pub files: Arc<Mutex<TaskFiles>>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub task_id: String,
    pub source: String,
    pub input: String,
    pub title: String,
    pub platform: String,
    pub state: String,
    pub label: String,
    pub received: u64,
    pub total: u64,
    pub progress: f64,
    pub speed: f64,
    pub file: String,
    pub error: String,
    pub revision: u64,
}
pub struct Job {
    pub view: JobView,
    pub task: Task,
    pub opts: Value,
    pub settings: Value,
    pub started: bool,
    pub finishing: bool,
    pub canonical: Option<String>,
    pub duplicate_of: Option<String>,
    pub done: watch::Sender<Option<DownloadResult>>,
    last_bytes: u64,
    last_time: Instant,
    last_emit: Instant,
}
pub struct Queue {
    pub jobs: HashMap<String, Job>,
    pub order: Vec<String>,
    pub inputs: HashMap<String, String>,
    pub resolved: HashMap<String, String>,
    pub concurrency: usize,
    pub running: usize,
    pub paused: bool,
    pub closing: bool,
    pub revision: u64,
}
impl Default for Queue {
    fn default() -> Self {
        Self {
            jobs: HashMap::new(),
            order: vec![],
            inputs: HashMap::new(),
            resolved: HashMap::new(),
            concurrency: 1,
            running: 0,
            paused: true,
            closing: false,
            revision: 0,
        }
    }
}
pub fn ended(state: &str) -> bool {
    matches!(state, "completed" | "cancelled" | "failed" | "skipped")
}
impl Queue {
    pub fn has_work(&self) -> bool {
        self.jobs.values().any(|job| !ended(&job.view.state))
    }
    pub fn dispatchable(&self) -> Vec<String> {
        if self.closing {
            return vec![];
        }
        self.order
            .iter()
            .filter(|id| {
                let j = &self.jobs[*id];
                j.view.state == "queued"
                    && !j.started
                    && !j.finishing
                    && !(j.view.source == "batch" && self.paused)
            })
            .take(self.concurrency.saturating_sub(self.running))
            .cloned()
            .collect()
    }
    fn can_resubmit(&self, id: &str) -> bool {
        let Some(job) = self.jobs.get(id) else {
            return true;
        };
        if matches!(job.view.state.as_str(), "failed" | "cancelled") {
            return true;
        }
        job.view.state == "skipped"
            && job
                .duplicate_of
                .as_ref()
                .and_then(|id| self.jobs.get(id))
                .is_some_and(|j| matches!(j.view.state.as_str(), "failed" | "cancelled"))
    }
}
impl Backend {
    pub fn snapshot(&self) -> Value {
        let q = self.queue.lock();
        json!({"revision":q.revision,"concurrency":q.concurrency,"paused":q.paused,"running":q.running,"tasks":q.order.iter().filter_map(|id|q.jobs.get(id)).map(|j|j.view.clone()).collect::<Vec<_>>()})
    }
    pub fn set_paused(&self, paused: bool) {
        let mut q = self.queue.lock();
        q.paused = paused;
        q.revision += 1;
    }
    fn enqueue(
        &self,
        source: &str,
        input: String,
        platform: String,
        opts: Value,
        settings: Value,
    ) -> Result<String, String> {
        let folder = self.download_folder(if source == "single" {
            &opts["folder"]
        } else {
            &settings["folder"]
        })?;
        let id = if let Some(id) = opts["taskId"].as_str() {
            uuid::Uuid::parse_str(id)
                .map_err(|_| "无效的taskId")?
                .to_string()
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        let mut q = self.queue.lock();
        if q.closing {
            return Err("程序正在关闭".into());
        }
        if q.jobs.contains_key(&id) {
            return Err("重复的taskId".into());
        }
        if source == "single"
            && q.jobs
                .values()
                .any(|j| j.view.source == "single" && !ended(&j.view.state))
        {
            return Err("已有单视频任务正在运行".into());
        }
        if source == "batch" && q.jobs.values().filter(|j| j.view.source == "batch").count() >= 300
        {
            return Err("队列最多保留300个批次任务，请先清除已结束任务".into());
        }
        q.revision += 1;
        let title = opts["title"].as_str().unwrap_or(&input).to_owned();
        let view = JobView {
            task_id: id.clone(),
            source: source.into(),
            input,
            title,
            platform,
            state: "queued".into(),
            label: "排队中".into(),
            received: 0,
            total: 0,
            progress: 0.0,
            speed: 0.0,
            file: String::new(),
            error: String::new(),
            revision: q.revision,
        };
        let (done, _) = watch::channel(None);
        let job = Job {
            view: view.clone(),
            task: Task {
                id: id.clone(),
                folder,
                cancel: CancellationToken::new(),
                files: Arc::new(Mutex::new(TaskFiles::default())),
            },
            opts,
            settings,
            started: false,
            finishing: false,
            canonical: None,
            duplicate_of: None,
            done,
            last_bytes: 0,
            last_time: Instant::now(),
            last_emit: Instant::now() - Duration::from_secs(1),
        };
        q.order.push(id.clone());
        q.jobs.insert(id.clone(), job);
        drop(q);
        self.emit("downloadState", json!(view));
        Ok(id)
    }
    fn change(&self, id: &str, update: impl FnOnce(&mut Job)) {
        let view = {
            let mut q = self.queue.lock();
            q.revision += 1;
            let revision = q.revision;
            let Some(job) = q.jobs.get_mut(id) else {
                return;
            };
            update(job);
            job.view.revision = revision;
            job.view.clone()
        };
        self.emit("downloadState", json!(view));
    }
    pub fn progress_for(self: &Arc<Self>, id: &str) -> Progress {
        let this = self.clone();
        let id = id.to_owned();
        Arc::new(move |label, received, total| this.progress(&id, label, received, total))
    }
    fn progress(&self, id: &str, label: String, received: u64, total: u64) {
        let view = {
            let mut q = self.queue.lock();
            let Some(job) = q.jobs.get(id) else {
                return;
            };
            if job.finishing || ended(&job.view.state) || job.task.cancel.is_cancelled() {
                return;
            }
            if job.last_emit.elapsed() < Duration::from_millis(100) && label == job.view.label {
                return;
            }
            q.revision += 1;
            let revision = q.revision;
            let job = q.jobs.get_mut(id).unwrap();
            if label != job.view.label || received < job.last_bytes {
                job.last_bytes = 0;
                job.last_time = Instant::now();
                job.view.speed = 0.0;
            }
            let seconds = job.last_time.elapsed().as_secs_f64();
            if seconds >= 0.1 {
                job.view.speed = received.saturating_sub(job.last_bytes) as f64 / seconds;
                job.last_time = Instant::now();
                job.last_bytes = received;
            }
            job.last_emit = Instant::now();
            job.view.label = label;
            job.view.received = received;
            job.view.total = total;
            job.view.progress = if total > 0 {
                (received as f64 / total as f64 * 100.0).min(99.9)
            } else {
                0.0
            };
            if job.view.label.contains("合并")
                || job.view.label.contains("处理音")
                || job.view.label.contains("发布")
            {
                job.view.state = "merging".into();
            }
            job.view.revision = revision;
            job.view.clone()
        };
        self.emit("downloadState", json!(view));
        self.emit("progress",json!({"taskId":view.task_id,"source":view.source,"label":view.label,"received":view.received,"total":view.total}));
    }
    pub fn add_batch(self: &Arc<Self>, input: &str, settings: Value) -> Result<Value, String> {
        let _adding = self.batch_add.lock();
        let access = settings["access"].as_str().unwrap_or("public");
        if !["public", "session"].contains(&access) {
            return Err("无效的访问方式".into());
        }
        let maximum = settings["maxHeight"].as_u64().unwrap_or(0);
        if ![0, 360, 720, 1080].contains(&maximum) {
            return Err("无效的画质上限".into());
        }
        self.download_folder(&settings["folder"])?;
        let lines: Vec<_> = input
            .lines()
            .enumerate()
            .filter(|(_, s)| !s.trim().is_empty())
            .collect();
        if lines.is_empty() || lines.len() > 100 {
            return Err("每次请输入1～100行链接".into());
        }
        let (mut added, mut duplicates, mut invalid, mut resubmitted) =
            (vec![], vec![], vec![], vec![]);
        for (index, input) in lines {
            let line = index + 1;
            let input = input.trim();
            let parsed = match links::source(input) {
                Ok(p) => p,
                Err(error) => {
                    invalid.push(json!({"line":line,"input":input,"error":error}));
                    continue;
                }
            };
            let previous = {
                let q = self.queue.lock();
                q.inputs.get(&parsed.key).cloned()
            };
            if previous
                .as_ref()
                .is_some_and(|id| !self.queue.lock().can_resubmit(id))
            {
                duplicates.push(json!({"line":line,"input":input}));
                continue;
            }
            match self.enqueue(
                "batch",
                parsed.url.clone(),
                parsed.platform,
                json!({}),
                settings.clone(),
            ) {
                Ok(id) => {
                    self.queue.lock().inputs.insert(parsed.key, id.clone());
                    added.push(id);
                    if previous.is_some() {
                        resubmitted.push(json!({"line":line,"input":input}));
                    }
                }
                Err(error) => invalid.push(json!({"line":line,"input":input,"error":error})),
            }
        }
        self.pump();
        Ok(
            json!({"added":added,"duplicates":duplicates,"invalid":invalid,"resubmitted":resubmitted}),
        )
    }
    pub async fn single(self: &Arc<Self>, opts: Value) -> DownloadResult {
        let platform = if text(&opts, "bvid").starts_with("external:") {
            self.parsed
                .lock()
                .get(text(&opts, "bvid"))
                .map(|r| r.source.platform.clone())
                .unwrap_or_default()
        } else {
            "bilibili".into()
        };
        let id = self.enqueue("single", String::new(), platform, opts, json!({}))?;
        let receiver = self.queue.lock().jobs[&id].done.subscribe();
        self.pump();
        wait(receiver).await
    }
    pub fn pump(self: &Arc<Self>) {
        let ids = {
            let mut q = self.queue.lock();
            let ids = q.dispatchable();
            for id in &ids {
                q.jobs.get_mut(id).unwrap().started = true;
            }
            q.running += ids.len();
            ids
        };
        for id in ids {
            let this = self.clone();
            let future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
                Box::pin(async move {
                    this.execute(id).await;
                });
            tokio::spawn(future);
        }
    }
    async fn execute(self: Arc<Self>, id: String) {
        let (task, source, input, mut opts, settings) = {
            let q = self.queue.lock();
            let j = &q.jobs[&id];
            (
                j.task.clone(),
                j.view.source.clone(),
                j.view.input.clone(),
                j.opts.clone(),
                j.settings.clone(),
            )
        };
        let progress = self.progress_for(&id);
        self.change(&id, |j| {
            j.view.state = if source == "batch" {
                "parsing"
            } else {
                "downloading"
            }
            .into();
            j.view.label = if source == "batch" {
                "正在解析"
            } else {
                "正在下载"
            }
            .into();
        });
        let mut skipped = false;
        let result = async {
            if source == "batch" {
                let parsed = self.parse_input(&input,settings["access"].as_str().unwrap_or("public"),&task.cancel,progress.clone()).await?;
                let page = parsed["pages"].as_array().and_then(|pages|pages.first()).ok_or("没有可下载的视频")?;
                let formats = self.formats(text(&parsed,"bvid"),&page["cid"],&task.cancel).await?;
                let available:Vec<_> = formats["video"].as_array().ok_or("没有可用画质")?.iter().filter(|format|format["available"]==true).collect();
                let maximum = settings["maxHeight"].as_u64().unwrap_or(0);
                let height = regex::Regex::new(r"(\d{3,4})[pP]").unwrap();
                let format = available.iter().find(|format| {
                    maximum == 0 || height.captures(text(format,"label")).and_then(|capture|capture.get(1)).and_then(|number|number.as_str().parse::<u64>().ok()).unwrap_or(0) <= maximum
                }).copied().or_else(||available.last().copied()).ok_or("当前视频没有可用画质")?;
                opts = json!({"folder":task.folder,"bvid":parsed["bvid"],"cid":page["cid"],"qn":format["id"],"kind":"video","title":parsed["title"],"platform":parsed["platform"]});
                let canonical = if parsed["platform"].is_string(){links::source(&input)?.key}else{format!("bili:{}",text(&parsed,"bvid"))};
                let duplicate = {
                    let mut queue = self.queue.lock();
                    if let Some(other) = queue.resolved.get(&canonical).cloned() {
                        queue.jobs.get_mut(&id).unwrap().duplicate_of = Some(other);
                        true
                    } else {
                        queue.resolved.insert(canonical.clone(),id.clone());
                        queue.jobs.get_mut(&id).unwrap().canonical = Some(canonical);
                        false
                    }
                };
                if duplicate {
                    skipped = true;
                    return Err("与队列内其他链接指向同一影片，已跳过".into());
                }
                self.change(&id,|job| {
                    job.view.title = text(&parsed,"title").into();
                    job.view.platform = parsed["platform"].as_str().unwrap_or("bilibili").into();
                });
            }
            if task.cancel.is_cancelled(){return Err("下载已取消".into());}
            self.change(&id,|job| {
                job.view.state = "downloading".into();
                job.view.label = "正在下载".into();
                job.view.received = 0;
                job.view.total = 0;
                job.view.progress = 0.0;
                job.view.speed = 0.0;
            });
            self.download_media(&opts,&task,progress).await
        }.await;
        // 先锁定收尾状态，之后的取消等待清理结果。
        self.change(&id, |j| j.finishing = true);
        let files = task.files.lock().clone();
        let cancelled = task.cancel.is_cancelled();
        let cleanup = output::cleanup_owned(
            &task.folder,
            files.temp,
            if files.owned { files.target } else { None },
            cancelled,
        )
        .await;
        if cancelled && files.owned {
            self.history_remove(&id);
        }
        let published = result.is_ok() && !cancelled && !skipped;
        let warning = if published {
            [files.warning, cleanup.clone().err()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("；")
        } else {
            String::new()
        };
        let final_result = if published {
            let mut value = result.unwrap();
            value["taskId"] = json!(id);
            if !warning.is_empty() {
                value["warning"] = json!(warning);
            }
            Ok(value)
        } else {
            Err(cleanup.clone().err().unwrap_or_else(|| {
                if cancelled {
                    "下载已取消".into()
                } else {
                    result.err().unwrap_or_else(|| "下载失败".into())
                }
            }))
        };
        let view = {
            let mut q = self.queue.lock();
            q.revision += 1;
            let revision = q.revision;
            let canonical = {
                let job = q.jobs.get_mut(&id).unwrap();
                job.view.state = if published {
                    "completed"
                } else if cleanup.is_err() {
                    "failed"
                } else if cancelled {
                    "cancelled"
                } else if skipped {
                    "skipped"
                } else {
                    "failed"
                }
                .into();
                job.view.label = match job.view.state.as_str() {
                    "completed" => "下载完成",
                    "cancelled" => "已取消",
                    "skipped" => "重复，已跳过",
                    _ => "失败",
                }
                .into();
                job.view.file = final_result
                    .as_ref()
                    .ok()
                    .and_then(|r| r["file"].as_str())
                    .unwrap_or_default()
                    .into();
                job.view.error = if published {
                    warning
                } else {
                    final_result.as_ref().err().cloned().unwrap_or_default()
                };
                job.view.progress = if published { 100.0 } else { 0.0 };
                job.view.speed = 0.0;
                job.view.revision = revision;
                job.done.send_replace(Some(final_result.clone()));
                if !published {
                    job.canonical.clone()
                } else {
                    None
                }
            };
            if let Some(key) = canonical {
                if q.resolved.get(&key) == Some(&id) {
                    q.resolved.remove(&key);
                }
            }
            q.running = q.running.saturating_sub(1);
            q.jobs[&id].view.clone()
        };
        self.emit("downloadState", json!(view));
        if !published {
            self.emit("progress",json!({"taskId":view.task_id,"source":view.source,"label":view.label,"received":0,"total":0}));
        }
        self.pump();
    }
    pub async fn cancel(self: &Arc<Self>, id: Option<&str>) -> Result<Value, String> {
        let candidate = {
            let q = self.queue.lock();
            id.map(str::to_owned).or_else(|| {
                q.order
                    .iter()
                    .find(|id| {
                        let job = &q.jobs[*id];
                        job.view.source == "single" && !ended(&job.view.state)
                    })
                    .cloned()
            })
        };
        let Some(id) = candidate else {
            return Ok(json!({"cancelled":false,"deleted":false}));
        };
        let (receiver, cancel, view) = {
            let mut q = self.queue.lock();
            let Some(job) = q.jobs.get_mut(&id) else {
                return Ok(json!({"cancelled":false,"deleted":false}));
            };
            if ended(&job.view.state) {
                return Ok(json!({"cancelled":false,"deleted":false}));
            }
            if !job.finishing {
                job.task.cancel.cancel();
            }
            let receiver = job.done.subscribe();
            let cancel = job.task.cancel.clone();
            let queued = !job.started;
            let view = if queued {
                q.revision += 1;
                let rev = q.revision;
                let j = q.jobs.get_mut(&id).unwrap();
                j.finishing = true;
                j.view.state = "cancelled".into();
                j.view.label = "已取消".into();
                j.view.revision = rev;
                j.done.send_replace(Some(Err("下载已取消".into())));
                Some(j.view.clone())
            } else {
                None
            };
            (receiver, cancel, view)
        };
        if let Some(view) = view {
            self.emit("downloadState", json!(view));
        }
        let result = wait(receiver).await;
        if cancel.is_cancelled() {
            if let Err(error) = &result {
                if error != "下载已取消" {
                    return Err(error.clone());
                }
            }
        }
        Ok(
            json!({"cancelled":cancel.is_cancelled(),"deleted":cancel.is_cancelled()&&result.is_err()}),
        )
    }
    pub async fn cancel_all(self: &Arc<Self>, batch_only: bool) -> Result<(), String> {
        let ids = {
            let q = self.queue.lock();
            q.order
                .iter()
                .filter(|id| {
                    let j = &q.jobs[*id];
                    !ended(&j.view.state) && (!batch_only || j.view.source == "batch")
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        let results =
            futures_util::future::join_all(ids.iter().map(|id| self.cancel(Some(id)))).await;
        for result in results {
            result?;
        }
        Ok(())
    }
    pub fn clear_queue(&self) -> Result<Value, String> {
        let mut q = self.queue.lock();
        if q.jobs
            .values()
            .any(|j| j.view.source == "batch" && !ended(&j.view.state))
        {
            return Err("请先等待或取消批次任务".into());
        }
        q.jobs.retain(|_, j| !ended(&j.view.state));
        let remaining = q
            .jobs
            .keys()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        q.order.retain(|id| remaining.contains(id));
        q.inputs.clear();
        q.resolved.clear();
        q.paused = true;
        q.revision += 1;
        drop(q);
        Ok(self.snapshot())
    }
}
async fn wait(mut receiver: watch::Receiver<Option<DownloadResult>>) -> DownloadResult {
    loop {
        let value = receiver.borrow().clone();
        if let Some(result) = value {
            return result;
        }
        receiver.changed().await.map_err(|_| "任务状态连接已关闭")?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::HeadlessHost;
    fn backend() -> (tempfile::TempDir, Arc<Backend>) {
        let dir = tempfile::tempdir().unwrap();
        let b = Arc::new(Backend::new(dir.path().to_owned(), Arc::new(HeadlessHost)).unwrap());
        (dir, b)
    }
    #[test]
    fn duplicate_aliases_and_invalid_lines() {
        let (dir, b) = backend();
        let r=b.add_batch("https://youtu.be/jNQXAC9IVRw\nhttps://www.youtube.com/watch?v=jNQXAC9IVRw\nhttps://evil.test",json!({"folder":dir.path()})).unwrap();
        assert_eq!(r["added"].as_array().unwrap().len(), 1);
        assert_eq!(r["duplicates"].as_array().unwrap().len(), 1);
        assert_eq!(r["invalid"].as_array().unwrap().len(), 1);
        assert_eq!(b.queue.lock().running, 0);
    }
    #[test]
    fn failure_and_cancel_can_resubmit_completed_cannot() {
        for state in ["failed", "cancelled", "completed"] {
            let (dir, b) = backend();
            let settings = json!({"folder":dir.path()});
            let first = b.add_batch("BV17x411w7KC", settings.clone()).unwrap();
            let id = first["added"][0].as_str().unwrap();
            b.queue.lock().jobs.get_mut(id).unwrap().view.state = state.into();
            let second = b.add_batch("BV17x411w7KC", settings).unwrap();
            assert_eq!(
                second["added"].as_array().unwrap().len(),
                if state == "completed" { 0 } else { 1 }
            );
        }
    }
    #[test]
    fn paused_batch_does_not_block_single_and_global_limit() {
        let (dir, b) = backend();
        b.add_batch(
            "BV17x411w7KC\nhttps://youtu.be/jNQXAC9IVRw",
            json!({"folder":dir.path()}),
        )
        .unwrap();
        let id = b
            .enqueue(
                "single",
                "".into(),
                "bilibili".into(),
                json!({"folder":dir.path()}),
                json!({}),
            )
            .unwrap();
        assert_eq!(b.queue.lock().dispatchable(), vec![id]);
        let mut q = b.queue.lock();
        q.paused = false;
        q.concurrency = 3;
        q.running = 1;
        assert_eq!(q.dispatchable().len(), 2);
        q.concurrency = 1;
        assert!(q.dispatchable().is_empty());
    }
    #[tokio::test]
    async fn cancelling_queued_task_does_not_touch_other_job() {
        let (dir, b) = backend();
        let r = b
            .add_batch(
                "BV17x411w7KC\nhttps://youtu.be/jNQXAC9IVRw",
                json!({"folder":dir.path()}),
            )
            .unwrap();
        let a = r["added"][0].as_str().unwrap();
        let other = r["added"][1].as_str().unwrap();
        assert_eq!(b.cancel(Some(a)).await.unwrap()["cancelled"], true);
        let q = b.queue.lock();
        assert_eq!(q.jobs[other].view.state, "queued");
        assert!(!q.jobs[other].task.cancel.is_cancelled());
    }
    #[test]
    fn reserved_job_cannot_be_dispatched_twice() {
        let (dir, b) = backend();
        let result = b
            .add_batch("BV17x411w7KC", json!({"folder":dir.path()}))
            .unwrap();
        let id = result["added"][0].as_str().unwrap();
        let mut q = b.queue.lock();
        q.paused = false;
        q.concurrency = 3;
        assert_eq!(q.dispatchable(), vec![id]);
        q.jobs.get_mut(id).unwrap().started = true;
        q.running = 1;
        assert!(q.dispatchable().is_empty());
    }
    #[test]
    fn three_progress_callbacks_keep_independent_state() {
        let (dir, b) = backend();
        let result = b
            .add_batch(
                "BV17x411w7KC\nhttps://youtu.be/jNQXAC9IVRw\nhttps://x.com/i/web/status/123",
                json!({"folder":dir.path()}),
            )
            .unwrap();
        let ids = result["added"].as_array().unwrap();
        for (index, id) in ids.iter().enumerate() {
            b.progress_for(id.as_str().unwrap())("正在下载".into(), (index as u64 + 1) * 10, 100);
        }
        let mut q = b.queue.lock();
        for (index, id) in ids.iter().enumerate() {
            assert_eq!(
                q.jobs[id.as_str().unwrap()].view.received,
                (index as u64 + 1) * 10
            );
        }
        let id = ids[0].as_str().unwrap();
        q.jobs.get_mut(id).unwrap().view.state = "completed".into();
        drop(q);
        b.progress_for(id)("旧进度".into(), 99, 100);
        assert_eq!(b.queue.lock().jobs[id].view.received, 10);
    }
    #[tokio::test]
    async fn late_cancel_waits_for_finishing_and_keeps_completed_state() {
        let (dir, b) = backend();
        let result = b
            .add_batch("BV17x411w7KC", json!({"folder":dir.path()}))
            .unwrap();
        let id = result["added"][0].as_str().unwrap().to_owned();
        {
            let mut q = b.queue.lock();
            let job = q.jobs.get_mut(&id).unwrap();
            job.started = true;
            job.finishing = true;
            job.view.state = "merging".into();
        }
        let pending = b.cancel(Some(&id));
        tokio::pin!(pending);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut pending)
                .await
                .is_err()
        );
        {
            let mut q = b.queue.lock();
            let job = q.jobs.get_mut(&id).unwrap();
            assert!(!job.task.cancel.is_cancelled());
            job.view.state = "completed".into();
            job.done.send_replace(Some(Ok(json!({"file":"saved"}))));
        }
        assert_eq!(pending.await.unwrap()["cancelled"], false);
        assert_eq!(b.queue.lock().jobs[&id].view.state, "completed");
    }
    #[test]
    fn simultaneous_submissions_do_not_duplicate_input() {
        let (dir, b) = backend();
        let gate = Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let b = b.clone();
                let gate = gate.clone();
                let folder = dir.path().to_owned();
                std::thread::spawn(move || {
                    gate.wait();
                    b.add_batch("BV17x411w7KC", json!({"folder":folder}))
                        .unwrap()["added"]
                        .as_array()
                        .unwrap()
                        .len()
                })
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .map(|t| t.join().unwrap())
                .sum::<usize>(),
            1
        );
    }
}
