use regex::Regex;
use url::Url;
#[derive(Clone, Debug)]
pub struct Source {
    pub platform: String,
    pub url: String,
    pub key: String,
}
pub fn source(input: &str) -> Result<Source, String> {
    let input = input.trim();
    if input.len() > 8192 {
        return Err("链接过长".into());
    }
    if let Ok(url) = Url::parse(input) {
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return Err("请使用完整的HTTPS视频链接".into());
        }
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        if [
            "x.com",
            "www.x.com",
            "mobile.x.com",
            "twitter.com",
            "www.twitter.com",
            "mobile.twitter.com",
        ]
        .contains(&host.as_str())
        {
            let re =
                Regex::new(r"^/(?:[^/]+/status|i/web/status)/(\d+)(?:/video/\d+)?/?$").unwrap();
            let id = re
                .captures(url.path())
                .and_then(|x| x.get(1))
                .ok_or("请粘贴X帖子的链接")?;
            let normalized = format!("https://x.com/i/web/status/{}", id.as_str());
            return Ok(Source {
                platform: "x".into(),
                key: normalized.clone(),
                url: normalized,
            });
        }
        if [
            "youtube.com",
            "www.youtube.com",
            "m.youtube.com",
            "music.youtube.com",
            "youtu.be",
            "www.youtu.be",
        ]
        .contains(&host.as_str())
        {
            let id = if host.ends_with("youtu.be") {
                url.path().trim_start_matches('/').to_owned()
            } else if url.path() == "/watch" {
                url.query_pairs()
                    .find(|(k, _)| k == "v")
                    .map(|(_, v)| v.into_owned())
                    .unwrap_or_default()
            } else {
                let p: Vec<_> = url.path().split('/').collect();
                if p.len() >= 3 && ["shorts", "embed", "live"].contains(&p[1]) {
                    p[2].into()
                } else {
                    String::new()
                }
            };
            if !Regex::new(r"^[A-Za-z0-9_-]{11}$").unwrap().is_match(&id) {
                return Err("请粘贴单个YouTube视频或Shorts链接".into());
            }
            let normalized = format!("https://www.youtube.com/watch?v={id}");
            return Ok(Source {
                platform: "youtube".into(),
                key: normalized.clone(),
                url: normalized,
            });
        }
        if host == "b23.tv" {
            if !Regex::new(r"^/[\w-]+/?$").unwrap().is_match(url.path()) {
                return Err("无效的b23.tv短链接".into());
            }
            let normalized = format!("https://b23.tv{}", url.path().trim_end_matches('/'));
            return Ok(Source {
                platform: "bilibili".into(),
                key: normalized.clone(),
                url: normalized,
            });
        }
        if !["bilibili.com", "www.bilibili.com", "m.bilibili.com"].contains(&host.as_str()) {
            return Err("不支持的视频链接".into());
        }
    }
    let re = Regex::new(r"(?i)(?:^|/)(BV[0-9A-Za-z]{10}|av[0-9]+)(?:$|[/?#\s])").unwrap();
    let id = re
        .captures(input)
        .and_then(|c| c.get(1))
        .ok_or("请输入BV号、av号或支持的视频链接")?
        .as_str()
        .to_owned();
    let id = format!(
        "{}{}",
        if id[..2].eq_ignore_ascii_case("av") {
            "av"
        } else {
            "BV"
        },
        &id[2..]
    );
    Ok(Source {
        platform: "bilibili".into(),
        key: format!("bili:{id}"),
        url: id,
    })
}
pub fn safe_name(name: &str) -> String {
    let mut units = 0;
    let mut value: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take_while(|ch| {
            units += ch.len_utf16();
            units <= 140
        })
        .collect();
    value = value.trim_end_matches(['.', ' ']).into();
    if value.is_empty() {
        return "video".into();
    }
    if Regex::new(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)")
        .unwrap()
        .is_match(&value)
    {
        value.insert(0, '_');
    }
    value
}
pub fn fps(value: &serde_json::Value) -> f64 {
    if let Some(n) = value.as_f64() {
        return n.max(0.0);
    }
    let parts: Vec<_> = value.as_str().unwrap_or("").split('/').collect();
    let a = parts[0].parse::<f64>().unwrap_or(0.0);
    let b = parts
        .get(1)
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(1.0);
    if b > 0.0 && a.is_finite() {
        a / b
    } else {
        0.0
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn youtube_aliases_deduplicate() {
        assert_eq!(
            source("https://youtu.be/jNQXAC9IVRw?t=2").unwrap().key,
            source("https://www.youtube.com/watch?v=jNQXAC9IVRw&list=other")
                .unwrap()
                .key
        );
    }
    #[test]
    fn rejects_untrusted_links() {
        for s in [
            "https://x.com.evil.com/u/status/123",
            "https://user@x.com/u/status/123",
            "http://youtu.be/jNQXAC9IVRw",
            "file:///tmp/BV17x411w7KC",
        ] {
            assert!(source(s).is_err(), "{s}");
        }
    }
    #[test]
    fn bv_and_short_link() {
        assert_eq!(source("BV17x411w7KC").unwrap().key, "bili:BV17x411w7KC");
        assert_eq!(
            source("https://b23.tv/eOYc04u?foo=1").unwrap().url,
            "https://b23.tv/eOYc04u"
        );
    }
    #[test]
    fn filename_protects_reserved_paths() {
        assert_eq!(safe_name("con.txt"), "_con.txt");
        assert_eq!(safe_name("../a/b: "), ".._a_b_");
        assert_eq!(safe_name("..."), "video");
    }
    #[test]
    fn id_prefixes_are_normalized_without_changing_bv_payload() {
        assert_eq!(source("AV123").unwrap().url, "av123");
        assert_eq!(
            source("bv17x411w7KC").unwrap().key,
            source("BV17x411w7KC").unwrap().key
        );
    }
    #[test]
    fn emoji_filenames_fit_the_existing_utf16_length_limit() {
        let name = safe_name(&"🦀".repeat(100));
        assert_eq!(name.encode_utf16().count(), 140);
        assert_eq!(name.chars().count(), 70);
    }
}
