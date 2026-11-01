use std::{ffi::c_void, io, ptr};

#[cfg(windows)]
#[repr(C)]
struct Blob {
    len: u32,
    data: *mut u8,
}
#[cfg(windows)]
#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        input: *const Blob,
        description: *const u16,
        entropy: *const Blob,
        reserved: *mut c_void,
        prompt: *mut c_void,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
    fn CryptUnprotectData(
        input: *const Blob,
        description: *mut *mut u16,
        entropy: *const Blob,
        reserved: *mut c_void,
        prompt: *mut c_void,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
}
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(data: *mut c_void) -> *mut c_void;
}

pub fn seal(bytes: &[u8]) -> io::Result<Vec<u8>> {
    crypt(bytes, true)
}
pub fn unseal(bytes: &[u8]) -> io::Result<Vec<u8>> {
    crypt(bytes, false)
}
#[cfg(windows)]
fn crypt(bytes: &[u8], encrypt: bool) -> io::Result<Vec<u8>> {
    let input = Blob {
        len: bytes
            .len()
            .try_into()
            .map_err(|_| io::Error::other("凭证过大"))?,
        data: bytes.as_ptr() as *mut u8,
    };
    let mut output = Blob {
        len: 0,
        data: ptr::null_mut(),
    };
    let success = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                1,
                &mut output,
            )
        }
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    // DPAPI缓冲区由LocalFree释放，空输入不能构造空指针切片。
    let result = if output.len == 0 {
        Vec::new()
    } else {
        if output.data.is_null() {
            return Err(io::Error::other("系统返回无效的凭证缓冲区"));
        }
        unsafe { std::slice::from_raw_parts(output.data, output.len as usize).to_vec() }
    };
    unsafe {
        if !output.data.is_null() {
            std::ptr::write_bytes(output.data, 0, output.len as usize);
            LocalFree(output.data.cast());
        }
    }
    Ok(result)
}
#[cfg(not(windows))]
fn crypt(_: &[u8], _: bool) -> io::Result<Vec<u8>> {
    Err(io::Error::other("当前系统没有可用的凭证加密服务"))
}

pub fn normalize_cookies(text: &str, platform: &str, now: u64) -> Result<String, String> {
    if !["x", "youtube"].contains(&platform) {
        return Err("不支持的平台".into());
    }
    if text.len() > 2 * 1024 * 1024 {
        return Err("Cookie文件过大".into());
    }
    let text = text.trim_start_matches('\u{feff}');
    if !text
        .lines()
        .any(|s| matches!(s, "# Netscape HTTP Cookie File" | "# HTTP Cookie File"))
    {
        return Err("请选择Netscape格式的cookies.txt".into());
    }
    let domains = if platform == "x" {
        &["x.com", "twitter.com"][..]
    } else {
        &["youtube.com", "google.com"][..]
    };
    let mut rows = Vec::new();
    let mut has_x_token = false;
    for line in text.lines() {
        let line = line.strip_prefix("#HttpOnly_").unwrap_or(line);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<_> = line.split('\t').collect();
        if fields.len() != 7 {
            continue;
        }
        let domain = fields[0].trim_start_matches('.').to_ascii_lowercase();
        if !domains
            .iter()
            .any(|d| domain == *d || domain.ends_with(&format!(".{d}")))
        {
            continue;
        }
        if !["TRUE", "FALSE"].contains(&fields[1])
            || !["TRUE", "FALSE"].contains(&fields[3])
            || !fields[2].starts_with('/')
            || fields[5].is_empty()
        {
            continue;
        }
        if line
            .chars()
            .any(|c| c != '\t' && (c.is_control() || c == '\u{7f}'))
        {
            continue;
        }
        let Ok(expiry) = fields[4].parse::<u64>() else {
            continue;
        };
        if expiry != 0 && expiry <= now {
            continue;
        }
        has_x_token |= fields[5] == "auth_token";
        rows.push(fields.join("\t"));
    }
    if rows.is_empty() {
        return Err("文件中没有该平台可用的Cookie，可能已过期".into());
    }
    if platform == "x" && !has_x_token {
        return Err("没有找到X登录状态，请重新导出Cookie".into());
    }
    Ok(format!(
        "# Netscape HTTP Cookie File\n{}\n",
        rows.join("\n")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cookie_domain_boundary_and_expiry() {
        let text="# Netscape HTTP Cookie File\n.evilx.com\tTRUE\t/\tTRUE\t0\tauth_token\tsecret\n.x.com\tTRUE\t/\tTRUE\t5\tauth_token\tsecret";
        assert!(normalize_cookies(text, "x", 10).is_err());
    }
    #[test]
    fn cookie_memory_input_is_filtered() {
        let text="# Netscape HTTP Cookie File\n#HttpOnly_.x.com\tTRUE\t/\tTRUE\t0\tauth_token\ttest\n.example.com\tTRUE\t/\tTRUE\t0\tx\tother";
        let result = normalize_cookies(text, "x", 10).unwrap();
        assert!(result.contains("auth_token\ttest"));
        assert!(!result.contains("example.com"));
    }
    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip() {
        let data = b"test-only-credential";
        let encrypted = seal(data).unwrap();
        assert_ne!(encrypted, data);
        assert_eq!(unseal(&encrypted).unwrap(), data);
    }
}
