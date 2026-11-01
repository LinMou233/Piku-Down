use std::path::Path;

#[cfg(windows)]
pub fn reveal(file: &Path) -> Result<(), String> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};
    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, flags: u32) -> i32;
        fn CoUninitialize();
        fn CoTaskMemFree(ptr: *mut c_void);
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHParseDisplayName(
            name: *const u16,
            context: *mut c_void,
            pidl: *mut *mut c_void,
            attributes: u32,
            out: *mut u32,
        ) -> i32;
        fn SHOpenFolderAndSelectItems(
            pidl: *const c_void,
            count: u32,
            items: *const *const c_void,
            flags: u32,
        ) -> i32;
    }
    struct Com(bool);
    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }
    struct Pidl(*mut c_void);
    impl Drop for Pidl {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CoTaskMemFree(self.0);
                }
            }
        }
    }
    let status = unsafe { CoInitializeEx(ptr::null_mut(), 2) };
    if status < 0 && status != 0x80010106u32 as i32 {
        return Err("无法初始化文件位置服务".into());
    }
    let _com = Com(status >= 0);
    let name: Vec<u16> = file.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut pidl = Pidl(ptr::null_mut());
    if unsafe {
        SHParseDisplayName(
            name.as_ptr(),
            ptr::null_mut(),
            &mut pidl.0,
            0,
            ptr::null_mut(),
        )
    } < 0
        || pidl.0.is_null()
    {
        return Err("无法定位文件，请确认文件仍然存在".into());
    }
    // count为0时传入文件的完整PIDL，由Windows打开父目录并选中文件。
    if unsafe { SHOpenFolderAndSelectItems(pidl.0, 0, ptr::null(), 0) } < 0 {
        return Err("无法打开文件位置".into());
    }
    Ok(())
}
#[cfg(not(windows))]
pub fn reveal(_: &Path) -> Result<(), String> {
    Err("当前平台不支持打开文件位置".into())
}
