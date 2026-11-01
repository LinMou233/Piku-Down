use crate::host::{DesktopHost, WindowRole};
use crate::{media::ExternalRecord, process::Progress, queue::Queue, runtime::Runtime, security};
use base64::Engine;
use parking_lot::Mutex;
use reqwest::cookie::{CookieStore, Jar};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{HeadlessHost, HostFuture};
    #[derive(Default)]
    struct ClosingHost {
        login_closed: AtomicBool,
    }
    impl DesktopHost for ClosingHost {
        fn emit(&self, _: &str, _: Value) {}
        fn video_dir(&self) -> Option<PathBuf> {
            None
        }
        fn pick_path(
            &self,
            directory: bool,
            title: &str,
            extensions: &[&str],
        ) -> HostFuture<Result<Option<PathBuf>, String>> {
            HeadlessHost.pick_path(directory, title, extensions)
        }
        fn open_login(&self) -> Result<(), String> {
            HeadlessHost.open_login()
        }
        fn close_login(&self) -> Result<(), String> {
            self.login_closed.store(true, Ordering::SeqCst);
            Ok(())
        }
        fn window_state(&self, role: WindowRole) -> Result<Value, String> {
            HeadlessHost.window_state(role)
        }
        fn window_action(&self, role: WindowRole, action: &str) -> Result<Value, String> {
            HeadlessHost.window_action(role, action)
        }
    }
    fn backend() -> (tempfile::TempDir, Arc<Backend>) {
        let dir = tempfile::tempdir().unwrap();
        let backend =
            Arc::new(Backend::new(dir.path().to_owned(), Arc::new(HeadlessHost)).unwrap());
        (dir, backend)
    }
    #[test]
    fn profile_lock_protects_another_instances_temporary_files() {
        let (dir, backend) = backend();
        let file = dir.path().join("private-temp/owned.txt");
        std::fs::write(&file, b"test").unwrap();
        assert!(Backend::new(dir.path().to_owned(), Arc::new(HeadlessHost)).is_err());
        assert!(file.exists());
        drop(backend);
        assert!(Backend::new(dir.path().to_owned(), Arc::new(HeadlessHost)).is_ok());
        assert!(!file.exists());
    }
    #[tokio::test]
    async fn cancelled_cache_hits_fail_without_network() {
        let (_dir, backend) = backend();
        backend.play_cache.lock().insert(
            "BV17x411w7KC:1:80".into(),
            (Instant::now(), json!({"quality":80})),
        );
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(backend
            .play("BV17x411w7KC", &json!(1), 80, &cancel)
            .await
            .is_err());
    }
    #[test]
    fn auth_changes_clear_cache_and_advance_epoch() {
        let (_dir, backend) = backend();
        backend
            .play_cache
            .lock()
            .insert("old".into(), (Instant::now(), json!({})));
        let before = backend.auth_epoch.load(Ordering::SeqCst);
        backend.invalidate_play();
        assert!(backend.play_cache.lock().is_empty());
        assert!(backend.auth_epoch.load(Ordering::SeqCst) > before);
    }
    #[tokio::test]
    async fn concurrent_close_requests_wait_for_the_same_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let host = Arc::new(ClosingHost::default());
        let backend = Arc::new(Backend::new(dir.path().to_owned(), host.clone()).unwrap());
        let added = backend
            .add_batch("BV17x411w7KC", json!({"folder":dir.path()}))
            .unwrap();
        let id = added["added"][0].as_str().unwrap();
        {
            let mut queue = backend.queue.lock();
            let job = queue.jobs.get_mut(id).unwrap();
            job.started = true;
            job.finishing = true;
            job.view.state = "merging".into();
        }
        let first = backend.shutdown();
        tokio::pin!(first);
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut first)
            .await
            .is_err());
        let second = backend.shutdown();
        tokio::pin!(second);
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut second)
            .await
            .is_err());
        assert!(!host.login_closed.load(Ordering::SeqCst));
        {
            let mut queue = backend.queue.lock();
            let job = queue.jobs.get_mut(id).unwrap();
            job.view.state = "completed".into();
            job.done.send_replace(Some(Ok(json!({"file":"saved"}))));
        }
        first.await;
        second.await;
        assert!(backend.queue.lock().closing);
        assert!(host.login_closed.load(Ordering::SeqCst));
    }
    #[test]
    fn dash_cache_reuses_each_available_quality_and_keeps_pages_separate() {
        let (_dir, b) = backend();
        let data = json!({"dash":{"video":[{"id":80},{"id":112}]}});
        b.cache_play("BV1", &json!(1), 127, data.clone(), 0)
            .unwrap();
        for qn in [80, 112, 127] {
            assert_eq!(b.cached_play(&format!("BV1:1:{qn}")), Some(data.clone()));
        }
        assert!(b.cached_play("BV1:2:80").is_none());
        assert!(b.cached_play("BV2:1:80").is_none());
    }
    #[test]
    fn old_auth_results_and_expired_entries_cannot_populate_cache() {
        let (_dir, b) = backend();
        b.invalidate_play();
        assert!(b.cache_play("BV1", &json!(1), 127, json!({}), 0).is_err());
        assert!(b.play_cache.lock().is_empty());
        b.play_cache.lock().insert(
            "expired".into(),
            (Instant::now() - Duration::from_secs(61), json!({})),
        );
        assert!(b.cached_play("expired").is_none());
        assert!(b.play_cache.lock().is_empty());
    }
    #[test]
    fn cache_is_bounded_and_non_dash_responses_do_not_alias_other_qualities() {
        let (_dir, b) = backend();
        b.cache_play("BV1", &json!(1), 80, json!({"accept_quality":[80,112]}), 0)
            .unwrap();
        assert!(b.cached_play("BV1:1:112").is_none());
        for cid in 2..90 {
            b.cache_play("BV1", &json!(cid), 80, json!({}), 0).unwrap();
        }
        assert_eq!(b.play_cache.lock().len(), 64);
    }
    #[test]
    fn public_mode_does_not_read_saved_credentials() {
        let (dir, backend) = backend();
        std::fs::write(
            dir.path().join("external-x.bin"),
            b"invalid encrypted test data",
        )
        .unwrap();
        assert!(backend.cookie_file("x", "public").unwrap().is_none());
        assert!(backend.cookies.lock().is_empty());
    }
    #[test]
    fn memory_cookie_and_temporary_cookie_are_removed_separately() {
        let (dir, backend) = backend();
        let sample =
            "# Netscape HTTP Cookie File\n.x.com\tTRUE\t/\tTRUE\t0\tauth_token\ttest-only\n";
        backend.save_cookie("x", sample.into(), false).unwrap();
        assert!(!dir.path().join("external-x.bin").exists());
        let file = backend.cookie_file("x", "session").unwrap().unwrap();
        let path = file.path().to_owned();
        assert!(path.exists());
        drop(file);
        assert!(!path.exists());
        assert!(backend.cookie("x").unwrap().is_some());
    }
    #[test]
    fn remember_removal_failures_are_reported() {
        let (dir, backend) = backend();
        std::fs::create_dir(dir.path().join("external-x.bin")).unwrap();
        assert!(backend.save_cookie("x", "test".into(), false).is_err());
    }
}
pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}
pub fn arg(args: &[Value], n: usize) -> Value {
    args.get(n).cloned().unwrap_or(Value::Null)
}
fn cancelled_request(cancel: &CancellationToken) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("下载已取消".into())
    } else {
        Ok(())
    }
}
pub struct CookieRecord {
    pub text: String,
    pub persistent: bool,
}
pub struct Backend {
    _profile_lock: std::fs::File,
    pub root: PathBuf,
    pub host: Arc<dyn DesktopHost>,
    pub client: reqwest::Client,
    pub bili: reqwest::Client,
    pub jar: Arc<Jar>,
    pub runtime: Runtime,
    pub store: Mutex<()>,
    pub cookies: Mutex<HashMap<String, CookieRecord>>,
    pub profile: Mutex<Value>,
    pub qr_key: Mutex<Option<String>>,
    pub parsed: Mutex<HashMap<String, ExternalRecord>>,
    pub play_cache: Mutex<HashMap<String, (Instant, Value)>>,
    pub auth_epoch: AtomicU64,
    pub batch_add: Mutex<()>,
    pub queue: Mutex<Queue>,
    pub closing: AtomicBool,
    shutdown_guard: tokio::sync::Mutex<()>,
    pub lifetime: CancellationToken,
}
impl Backend {
    pub fn new(
        root: PathBuf,
        host: Arc<dyn DesktopHost>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(&root)?;
        let profile_lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("profile.lock"))?;
        profile_lock
            .try_lock()
            .map_err(|_| "配置目录正在被其他实例使用")?;
        let jar = Arc::new(Jar::default());
        if let Ok(bytes) = std::fs::read(root.join("bili-session.bin")) {
            if let Ok(bytes) = security::unseal(&bytes) {
                if let Ok(cookies) = String::from_utf8(bytes) {
                    for pair in cookies.split(';') {
                        if !pair.contains(['\r', '\n']) {
                            jar.add_cookie_str(
                                &format!("{}; Domain=.bilibili.com; Path=/; Secure", pair.trim()),
                                &url::Url::parse("https://api.bilibili.com/")?,
                            );
                        }
                    }
                }
            }
        }
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 Piku-Down/1.7.0")
            .connect_timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()?;
        let bili = reqwest::Client::builder()
            .user_agent("Mozilla/5.0")
            .cookie_provider(jar.clone())
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()?;
        let private = root.join("private-temp");
        if private.exists() {
            std::fs::remove_dir_all(&private)?;
        }
        std::fs::create_dir_all(&private)?;
        let runtime = Runtime::new(&root, client.clone());
        let backend = Self {
            _profile_lock: profile_lock,
            root,
            host,
            client,
            bili,
            jar,
            runtime,
            store: Mutex::new(()),
            cookies: Mutex::new(HashMap::new()),
            profile: Mutex::new(json!({"logged":false})),
            qr_key: Mutex::new(None),
            parsed: Mutex::new(HashMap::new()),
            play_cache: Mutex::new(HashMap::new()),
            auth_epoch: AtomicU64::new(0),
            batch_add: Mutex::new(()),
            queue: Mutex::new(Queue::default()),
            closing: AtomicBool::new(false),
            shutdown_guard: tokio::sync::Mutex::new(()),
            lifetime: CancellationToken::new(),
        };
        backend.migrate_preferences();
        Ok(backend)
    }
    fn migrate_preferences(&self) {
        if self.host.video_dir().is_none() {
            return;
        }
        let Some(appdata) = std::env::var_os("APPDATA") else {
            return;
        };
        let old = PathBuf::from(appdata).join("bili-desktop");
        let _guard = self.store.lock();
        for name in ["settings", "history"] {
            let dest = self.root.join(format!("{name}.json"));
            let src = old.join(format!("{name}.json"));
            if !dest.exists() {
                if let Ok(meta) = std::fs::symlink_metadata(&src) {
                    if meta.is_file() && meta.len() < 4 * 1024 * 1024 {
                        if let Ok(bytes) = std::fs::read(&src) {
                            if serde_json::from_slice::<Value>(&bytes).is_ok() {
                                let _ = std::fs::write(&dest, bytes);
                            }
                        }
                    }
                }
            }
        }
    }
    pub fn read(&self, name: &str, fallback: Value) -> Value {
        std::fs::read(self.root.join(format!("{name}.json")))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or(fallback)
    }
    fn write_unlocked(&self, name: &str, value: &Value) -> Result<(), String> {
        let mut file =
            tempfile::NamedTempFile::new_in(&self.root).map_err(|_| "无法创建设置暂存文件")?;
        serde_json::to_writer(file.as_file_mut(), value).map_err(|_| "无法保存设置")?;
        file.as_file_mut()
            .sync_all()
            .map_err(|_| "无法刷新设置文件")?;
        file.persist(self.root.join(format!("{name}.json")))
            .map_err(|_| "无法发布设置文件")?;
        Ok(())
    }
    pub fn write(&self, name: &str, value: &Value) -> Result<(), String> {
        let _guard = self.store.lock();
        self.write_unlocked(name, value)
    }
    pub fn history_add(&self, entry: Value) -> Result<(), String> {
        let _guard = self.store.lock();
        let mut items = self
            .read("history", json!([]))
            .as_array()
            .cloned()
            .unwrap_or_default();
        items.insert(0, entry);
        items.truncate(300);
        self.write_unlocked("history", &json!(items))
    }
    pub fn history_remove(&self, id: &str) {
        let _guard = self.store.lock();
        let mut items = self
            .read("history", json!([]))
            .as_array()
            .cloned()
            .unwrap_or_default();
        items.retain(|x| x["taskId"] != id);
        let _ = self.write_unlocked("history", &json!(items));
    }
    pub fn emit(&self, name: &str, value: Value) {
        self.host.emit(name, value);
    }
    pub fn component_progress(self: &Arc<Self>) -> Progress {
        let this = self.clone();
        Arc::new(move |label, received, total| {
            this.emit(
                "progress",
                json!({"label":label,"received":received,"total":total}),
            )
        })
    }
    pub fn settings(&self) -> Value {
        let default_dir = self
            .host
            .video_dir()
            .unwrap_or_else(|| self.root.join("downloads"));
        let mut settings = json!({"dragEffects":true,"performance":false,"mode":"color","color":"#e7ebf2","darkColor":"#171a24","blur":12,"collapsed":false,"theme":"light","downloadDir":default_dir});
        if let Some(map) = self.read("settings", json!({})).as_object() {
            for (k, v) in map {
                settings[k] = v.clone();
            }
        }
        if !Path::new(text(&settings, "downloadDir")).is_absolute() {
            settings["downloadDir"] = json!(default_dir);
        }
        settings
    }
    pub fn download_folder(&self, value: &Value) -> Result<PathBuf, String> {
        let folder = value
            .as_str()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(text(&self.settings(), "downloadDir")));
        if !folder.is_absolute() || folder.as_os_str().is_empty() {
            return Err("无效的下载目录".into());
        }
        Ok(folder)
    }
    pub fn idle_accounts(&self) -> Result<(), String> {
        if self.queue.lock().has_work() {
            Err("请在下载结束后更改登录状态".into())
        } else {
            Ok(())
        }
    }
    fn secret_write(&self, key: &str, bytes: &[u8]) -> Result<(), String> {
        let encrypted = security::seal(bytes).map_err(|_| "系统加密服务不可用，无法保存凭证")?;
        let mut file = tempfile::NamedTempFile::new_in(&self.root).map_err(|_| "无法保存凭证")?;
        file.write_all(&encrypted).map_err(|_| "无法保存凭证")?;
        file.persist(self.root.join(key))
            .map_err(|_| "无法保存凭证")?;
        Ok(())
    }
    pub fn cookie(&self, platform: &str) -> Result<Option<String>, String> {
        if !["x", "youtube"].contains(&platform) {
            return Err("不支持的平台".into());
        }
        let mut sessions = self.cookies.lock();
        if !sessions.contains_key(platform) {
            match std::fs::read(self.root.join(format!("external-{platform}.bin"))) {
                Ok(bytes) => {
                    let plain = security::unseal(&bytes)
                        .map_err(|_| "保存的Cookie无法读取，请清除后重新导入")?;
                    let plain = String::from_utf8(plain).map_err(|_| "保存的Cookie无效")?;
                    let text = security::normalize_cookies(&plain, platform, now() / 1000)?;
                    sessions.insert(
                        platform.into(),
                        CookieRecord {
                            text,
                            persistent: true,
                        },
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err("无法读取保存的Cookie".into()),
            }
        }
        sessions
            .get(platform)
            .map(|r| security::normalize_cookies(&r.text, platform, now() / 1000))
            .transpose()
    }
    fn external_accounts(&self) -> Value {
        let mut value = json!({});
        for p in ["x", "youtube"] {
            match self.cookie(p) {
                Ok(cookie) => {
                    let persistent = self.cookies.lock().get(p).is_some_and(|r| r.persistent);
                    value[p] = json!({"saved":cookie.is_some(),"persistent":persistent});
                }
                Err(_) => {
                    value[p] = json!({"saved":false,"persistent":self.root.join(format!("external-{p}.bin")).exists(),"error":"Cookie无法读取或已过期，请清除后重新导入"})
                }
            }
        }
        value
    }
    pub fn cookie_file(
        &self,
        platform: &str,
        access: &str,
    ) -> Result<Option<tempfile::NamedTempFile>, String> {
        if access == "public" {
            return Ok(None);
        }
        if access != "session" {
            return Err("无效的访问方式".into());
        }
        let text = self
            .cookie(platform)?
            .ok_or("请先在设置中导入该平台的Cookie")?;
        let mut file = tempfile::Builder::new()
            .prefix("cookie-")
            .suffix(".txt")
            .tempfile_in(self.root.join("private-temp"))
            .map_err(|_| "无法创建本地Cookie暂存文件")?;
        file.write_all(text.as_bytes())
            .map_err(|_| "无法写入本地Cookie暂存文件")?;
        file.flush().map_err(|_| "无法刷新Cookie暂存文件")?;
        Ok(Some(file))
    }
    pub async fn api(&self, url: &str, cancel: &CancellationToken) -> Result<Value, String> {
        let result = tokio::select! {r=self.bili.get(url).header("Referer","https://www.bilibili.com/").timeout(Duration::from_secs(15)).send()=>r.map_err(|_|"B站网络请求失败")?,_=cancel.cancelled()=>return Err("下载已取消".into())};
        if !result.status().is_success() {
            return Err(format!("B站网络请求失败：{}", result.status().as_u16()));
        }
        let value: Value = tokio::select! {r=result.json()=>r.map_err(|_|"B站返回数据无效")?,_=cancel.cancelled()=>return Err("下载已取消".into())};
        if value["code"].as_i64().unwrap_or(-1) != 0 {
            if value["code"] == -101 {
                self.invalidate_play();
                *self.profile.lock() = json!({"logged":false});
                self.emit("authStateChanged", json!({"logged":false}));
            }
            return Err(format!(
                "B站返回{}：{}",
                value["code"],
                text(&value, "message")
            ));
        }
        Ok(value
            .get("data")
            .or_else(|| value.get("result"))
            .cloned()
            .unwrap_or(Value::Null))
    }
    pub async fn play(
        &self,
        bvid: &str,
        cid: &Value,
        qn: u64,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        cancelled_request(cancel)?;
        let epoch = self.auth_epoch.load(Ordering::SeqCst);
        let key = format!("{bvid}:{cid}:{qn}");
        if let Some(data) = self.cached_play(&key) {
            return Ok(data);
        }
        let mut url = url::Url::parse("https://api.bilibili.com/x/player/playurl").unwrap();
        url.query_pairs_mut()
            .append_pair("bvid", bvid)
            .append_pair("cid", &cid.to_string())
            .append_pair("qn", &qn.to_string())
            .append_pair("fnval", "4048")
            .append_pair("fourk", "1");
        let data = self.api(url.as_str(), cancel).await?;
        cancelled_request(cancel)?;
        self.cache_play(bvid, cid, qn, data, epoch)
    }
    fn cached_play(&self, key: &str) -> Option<Value> {
        let mut cache = self.play_cache.lock();
        cache.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(60));
        cache.get(key).map(|(_, data)| data.clone())
    }
    fn cache_play(
        &self,
        bvid: &str,
        cid: &Value,
        qn: u64,
        data: Value,
        epoch: u64,
    ) -> Result<Value, String> {
        let mut cache = self.play_cache.lock();
        if self.auth_epoch.load(Ordering::SeqCst) != epoch {
            return Err("账号状态已变化，请重新解析".into());
        }
        let mut qualities = vec![qn];
        if let Some(video) = data["dash"]["video"].as_array() {
            qualities.extend(video.iter().filter_map(|stream| stream["id"].as_u64()));
        }
        let at = Instant::now();
        for quality in qualities {
            let key = format!("{bvid}:{cid}:{quality}");
            if !cache.contains_key(&key) && cache.len() >= 64 {
                if let Some(oldest) = cache
                    .iter()
                    .min_by_key(|(_, (at, _))| *at)
                    .map(|(key, _)| key.clone())
                {
                    cache.remove(&oldest);
                }
            }
            cache.insert(key, (at, data.clone()));
        }
        Ok(data)
    }
    pub async fn account(&self) -> Value {
        let value = match self
            .api(
                "https://api.bilibili.com/x/web-interface/nav",
                &self.lifetime,
            )
            .await
        {
            Ok(data) if data["isLogin"] == true => {
                json!({"logged":true,"name":data["uname"],"face":data["face"],"mid":data["mid"],"level":data["level_info"]["current_level"],"vip":data["vipStatus"]==1,"vipLabel":data["vip_label"]["text"].as_str().unwrap_or("大会员"),"vipDue":data["vipDueDate"]})
            }
            Ok(_) => json!({"logged":false}),
            Err(error) => json!({"logged":false,"error":error}),
        };
        let previous = self.profile.lock().clone();
        if previous["mid"] != value["mid"] || previous["logged"] != value["logged"] {
            self.invalidate_play();
        }
        *self.profile.lock() = value.clone();
        self.emit("authStateChanged", value.clone());
        value
    }
    async fn choose(
        &self,
        folder: bool,
        title: &str,
        extensions: &[&str],
    ) -> Result<Option<PathBuf>, String> {
        self.host.pick_path(folder, title, extensions).await
    }
    pub async fn dispatch(
        self: Arc<Self>,
        role: WindowRole,
        command: &str,
        args: Vec<Value>,
    ) -> Result<Value, String> {
        if role == WindowRole::Login
            && !matches!(command, "qr" | "poll" | "loginClose")
            && !(command == "windowAction" && arg(&args, 0) == "drag")
        {
            return Err("无效的窗口请求".into());
        }
        if role == WindowRole::Main && matches!(command, "qr" | "poll" | "loginClose") {
            return Err("请在登录窗口操作".into());
        }
        match command {
            "settings" => Ok(self.settings()),
            "saveSettings" => {
                let value = arg(&args, 0);
                let mut settings = self.settings();
                for key in [
                    "theme",
                    "mode",
                    "color",
                    "darkColor",
                    "blur",
                    "collapsed",
                    "performance",
                ] {
                    if !value[key].is_null() {
                        settings[key] = value[key].clone();
                    }
                }
                settings["blur"] =
                    json!(settings["blur"].as_f64().unwrap_or(12.0).clamp(0.0, 40.0));
                settings["theme"] = json!(if settings["theme"] == "dark" {
                    "dark"
                } else {
                    "light"
                });
                self.write("settings", &settings)?;
                Ok(settings)
            }
            "folder" => {
                let Some(folder) = self.choose(true, "选择下载目录", &[]).await? else {
                    return Ok(Value::Null);
                };
                let mut settings = self.settings();
                settings["downloadDir"] = json!(folder);
                self.write("settings", &settings)?;
                Ok(json!(folder))
            }
            "newTaskId" => Ok(json!(uuid::Uuid::new_v4().to_string())),
            "history" => Ok(self.read("history", json!([]))),
            "clearHistory" => {
                self.write("history", &json!([]))?;
                Ok(json!([]))
            }
            "account" => Ok(self.account().await),
            "authState" => Ok(self.profile.lock().clone()),
            "logout" => {
                self.set_paused(true);
                self.cancel_all(false).await?;
                self.invalidate_play();
                self.remove_secret("bili-session.bin")?;
                self.clear_bili();
                *self.profile.lock() = json!({"logged":false});
                self.emit("authStateChanged", json!({"logged":false}));
                Ok(json!(true))
            }
            "openLogin" => {
                let profile = self.account().await;
                if profile["logged"] != true {
                    self.host.open_login()?;
                }
                Ok(profile)
            }
            "qr" => {
                let data = self
                    .api(
                        "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
                        &self.lifetime,
                    )
                    .await?;
                let code = qrcode::QrCode::new(text(&data, "url")).map_err(|_| "二维码生成失败")?;
                let svg = code
                    .render::<qrcode::render::svg::Color>()
                    .min_dimensions(256, 256)
                    .build();
                let key = text(&data, "qrcode_key").to_owned();
                *self.qr_key.lock() = Some(key.clone());
                Ok(
                    json!({"key":key,"image":format!("data:image/svg+xml;base64,{}",base64::engine::general_purpose::STANDARD.encode(svg))}),
                )
            }
            "poll" => {
                let key = arg(&args, 0).as_str().unwrap_or_default().to_owned();
                if self.qr_key.lock().as_deref() != Some(&key) {
                    return Ok(json!({"code":86038}));
                }
                let mut url = url::Url::parse(
                    "https://passport.bilibili.com/x/passport-login/web/qrcode/poll",
                )
                .unwrap();
                url.query_pairs_mut().append_pair("qrcode_key", &key);
                let data = self.api(url.as_str(), &self.lifetime).await?;
                if data["code"] == 0 {
                    let profile = self.account().await;
                    if profile["logged"] != true {
                        return Err("登录尚未验证，请稍后重试".into());
                    }
                    if let Some(cookies) = self
                        .jar
                        .cookies(&url::Url::parse("https://api.bilibili.com/").unwrap())
                    {
                        self.secret_write("bili-session.bin", cookies.as_bytes())?;
                    }
                    let _ = self.host.close_login();
                }
                Ok(data)
            }
            "loginClose" => {
                *self.qr_key.lock() = None;
                self.host.close_login()?;
                Ok(Value::Null)
            }
            "parse" => {
                self.parse_input(
                    arg(&args, 0).as_str().unwrap_or_default(),
                    text(&arg(&args, 1), "access"),
                    &self.lifetime,
                    self.component_progress(),
                )
                .await
            }
            "formats" => {
                self.formats(
                    arg(&args, 0).as_str().unwrap_or_default(),
                    &arg(&args, 1),
                    &self.lifetime,
                )
                .await
            }
            "download" => self.single(arg(&args, 0)).await,
            "cancel" | "cancelAndDelete" => self.cancel(arg(&args, 0).as_str()).await,
            "batchState" => Ok(self.snapshot()),
            "batchAdd" => self.add_batch(arg(&args, 0).as_str().unwrap_or_default(), arg(&args, 1)),
            "batchStart" | "batchResume" => {
                self.set_paused(false);
                self.pump();
                Ok(self.snapshot())
            }
            "batchPause" => {
                self.set_paused(true);
                Ok(self.snapshot())
            }
            "batchConcurrency" => {
                let n = arg(&args, 0).as_u64().ok_or("无效并发数")?;
                if !(1..=3).contains(&n) {
                    return Err("同时下载数量必须为1～3".into());
                }
                {
                    let mut q = self.queue.lock();
                    q.concurrency = n as usize;
                    q.revision += 1;
                }
                self.pump();
                Ok(self.snapshot())
            }
            "batchCancelAll" => {
                self.set_paused(true);
                self.cancel_all(true).await?;
                Ok(self.snapshot())
            }
            "batchClear" => self.clear_queue(),
            "externalState" => Ok(
                json!({"accounts":self.external_accounts(),"runtime":self.runtime.status().await}),
            ),
            "externalInstall" => {
                self.idle_accounts()?;
                self.runtime
                    .ensure_all(&self.lifetime, self.component_progress())
                    .await?;
                Ok(self.runtime.status().await)
            }
            "externalImport" => {
                self.idle_accounts()?;
                let platform = arg(&args, 0).as_str().unwrap_or_default().to_owned();
                if !["x", "youtube"].contains(&platform.as_str()) {
                    return Err("不支持的平台".into());
                }
                let Some(file) = self.choose(false, "导入Cookie", &["txt"]).await? else {
                    return Ok(Value::Null);
                };
                if std::fs::metadata(&file)
                    .map_err(|_| "无法读取Cookie文件")?
                    .len()
                    > 2 * 1024 * 1024
                {
                    return Err("Cookie文件过大".into());
                }
                let plain =
                    std::fs::read_to_string(file).map_err(|_| "Cookie文件必须为UTF-8文本")?;
                let text = security::normalize_cookies(&plain, &platform, now() / 1000)?;
                let remember = arg(&args, 1)["remember"] == true;
                self.save_cookie(&platform, text, remember)?;
                Ok(self.external_accounts())
            }
            "externalRemember" => {
                self.idle_accounts()?;
                let platform = arg(&args, 0).as_str().unwrap_or_default().to_owned();
                let text = self.cookie(&platform)?.ok_or("请先导入Cookie")?;
                self.save_cookie(&platform, text, arg(&args, 1) == true)?;
                Ok(self.external_accounts())
            }
            "externalClear" => {
                self.idle_accounts()?;
                let platform = arg(&args, 0).as_str().unwrap_or_default().to_owned();
                if !["x", "youtube"].contains(&platform.as_str()) {
                    return Err("不支持的平台".into());
                }
                self.remove_secret(&format!("external-{platform}.bin"))?;
                self.cookies.lock().remove(&platform);
                self.parsed.lock().clear();
                Ok(self.external_accounts())
            }
            "wallpaper" => Ok(self.wallpaper()),
            "importWallpaper" => {
                let Some(file) = self
                    .choose(false, "导入壁纸", &["jpg", "jpeg", "png", "webp"])
                    .await?
                else {
                    return Ok(Value::Null);
                };
                if std::fs::metadata(&file).map_err(|_| "无法读取图片")?.len() > 20 * 1024 * 1024
                {
                    return Err("图片过大".into());
                }
                let root = self.root.clone();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let mut reader = image::ImageReader::open(&file)
                        .map_err(|_| "无法读取图片")?
                        .with_guessed_format()
                        .map_err(|_| "无法识别图片")?;
                    let mut limits = image::Limits::default();
                    limits.max_alloc = Some(128 * 1024 * 1024);
                    limits.max_image_width = Some(8192);
                    limits.max_image_height = Some(8192);
                    reader.limits(limits);
                    let image = reader
                        .decode()
                        .map_err(|_| "图片无效或尺寸过大")?
                        .thumbnail(2560, 1600);
                    let mut bytes = Vec::new();
                    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 85)
                        .encode_image(&image)
                        .map_err(|_| "图片转换失败")?;
                    std::fs::write(root.join("wallpaper.jpg"), bytes)
                        .map_err(|_| "壁纸保存失败")?;
                    Ok(())
                })
                .await
                .map_err(|_| "壁纸处理失败")??;
                Ok(self.wallpaper())
            }
            "reveal" => {
                let file = arg(&args, 0).as_str().unwrap_or_default().to_owned();
                if !Path::new(&file).is_absolute() || !Path::new(&file).is_file() {
                    return Err("文件不存在".into());
                }
                tokio::task::spawn_blocking(move || crate::shell::reveal(Path::new(&file)))
                    .await
                    .map_err(|_| "打开文件位置失败")??;
                Ok(Value::Null)
            }
            "library" => self.library(arg(&args, 0)).await,
            "windowState" => self.host.window_state(role),
            "windowAction" => {
                let action = arg(&args, 0).as_str().unwrap_or_default().to_owned();
                if action == "close" {
                    self.shutdown().await;
                }
                self.host.window_action(role, &action)
            }
            _ => Err("不支持的操作".into()),
        }
    }
    pub fn invalidate_play(&self) {
        let mut cache = self.play_cache.lock();
        self.auth_epoch.fetch_add(1, Ordering::SeqCst);
        cache.clear();
    }
    fn remove_secret(&self, key: &str) -> Result<(), String> {
        match std::fs::remove_file(self.root.join(key)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("本地凭证删除失败，请检查文件是否被占用".into()),
        }
    }
    fn clear_bili(&self) {
        for host in [
            "https://api.bilibili.com/",
            "https://www.bilibili.com/",
            "https://passport.bilibili.com/",
        ] {
            let url = url::Url::parse(host).unwrap();
            if let Some(cookies) = self.jar.cookies(&url) {
                if let Ok(cookies) = cookies.to_str() {
                    for cookie in cookies.split(';') {
                        if let Some((name, _)) = cookie.trim().split_once('=') {
                            for domain in [".bilibili.com", url.host_str().unwrap()] {
                                self.jar.add_cookie_str(
                                    &format!("{name}=; Domain={domain}; Path=/; Max-Age=0"),
                                    &url,
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    fn save_cookie(&self, platform: &str, text: String, persistent: bool) -> Result<(), String> {
        let key = format!("external-{platform}.bin");
        if persistent {
            self.secret_write(&key, text.as_bytes())?;
        } else {
            self.remove_secret(&key)?;
        }
        self.cookies
            .lock()
            .insert(platform.into(), CookieRecord { text, persistent });
        self.parsed.lock().clear();
        Ok(())
    }
    fn wallpaper(&self) -> Value {
        std::fs::read(self.root.join("wallpaper.jpg"))
            .ok()
            .map(|bytes| {
                json!(format!(
                    "data:image/jpeg;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ))
            })
            .unwrap_or(Value::Null)
    }
    pub async fn shutdown(self: &Arc<Self>) {
        // 后续关闭请求必须等待正在进行的任务清理。
        let _guard = self.shutdown_guard.lock().await;
        if self.closing.swap(true, Ordering::SeqCst) {
            return;
        }
        self.lifetime.cancel();
        {
            self.queue.lock().closing = true;
        }
        let _ = self.cancel_all(false).await;
        self.cookies.lock().clear();
        let _ = self.host.close_login();
    }
    pub async fn library(&self, request: Value) -> Result<Value, String> {
        let account = self.account().await;
        if account["logged"] != true {
            return Err("请先扫码登录，再查看B站内容".into());
        }
        let kind = text(&request, "kind");
        let page = request["page"].as_u64().unwrap_or(1).max(1);
        let url = match kind {
            "folders" => format!(
                "https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid={}&type=2",
                account["mid"]
            ),
            "favorites" => {
                let folder = request["folder"]
                    .as_u64()
                    .or_else(|| request["folder"].as_str().and_then(|s| s.parse().ok()))
                    .filter(|n| *n > 0)
                    .ok_or("请选择收藏夹")?;
                format!("https://api.bilibili.com/x/v3/fav/resource/list?media_id={folder}&pn={page}&ps=20&platform=web&order=mtime")
            }
            "later" => "https://api.bilibili.com/x/v2/history/toview".into(),
            "watched" => {
                let max = request["cursor"]["max"].as_u64().unwrap_or(0);
                let at = request["cursor"]["view_at"].as_u64().unwrap_or(0);
                format!("https://api.bilibili.com/x/web-interface/history/cursor?ps=30&type=archive&max={max}&view_at={at}&business=archive")
            }
            _ => return Err("不支持的内容类型".into()),
        };
        let data = self.api(&url, &self.lifetime).await?;
        if kind == "folders" {
            return Ok(
                json!({"folders":data["list"].as_array().unwrap_or(&vec![]).iter().map(|x|json!({"id":x["id"],"title":x["title"],"count":x["media_count"]})).collect::<Vec<_>>()}),
            );
        }
        let raw = if kind == "favorites" {
            &data["medias"]
        } else {
            &data["list"]
        };
        let mut items = Vec::new();
        for item in raw.as_array().unwrap_or(&vec![]) {
            let bvid = item["bvid"]
                .as_str()
                .or_else(|| item["bv_id"].as_str())
                .or_else(|| item["history"]["bvid"].as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "av{}",
                        item["id"]
                            .as_u64()
                            .or_else(|| item["history"]["oid"].as_u64())
                            .unwrap_or(0)
                    )
                });
            let available = match kind {
                "favorites" => item["type"] == 2 && item["attr"].as_i64().unwrap_or(0) == 0,
                "watched" => item["history"]["business"] == "archive",
                _ => item["state"].as_i64().unwrap_or(0) == 0,
            };
            if kind == "watched" && !available {
                continue;
            }
            items.push(json!({"id":bvid,"title":item["title"],"cover":item["pic"].as_str().or_else(||item["cover"].as_str()).unwrap_or_default(),"owner":item["owner"]["name"].as_str().or_else(||item["upper"]["name"].as_str()).or_else(||item["author_name"].as_str()).unwrap_or_default(),"duration":item["duration"],"available":available}));
        }
        let more = if kind == "favorites" {
            data["has_more"] == true
        } else if kind == "watched" {
            !items.is_empty()
                && data["cursor"]["view_at"].as_u64().unwrap_or(0) > 0
                && data["cursor"] != request["cursor"]
        } else {
            false
        };
        Ok(
            json!({"items":items,"hasMore":more,"page":page,"cursor":data["cursor"],"total":data["info"]["media_count"]}),
        )
    }
}
