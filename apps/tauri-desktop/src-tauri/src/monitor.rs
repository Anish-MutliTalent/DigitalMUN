use tauri::command;
use windows::Win32::Foundation::MAX_PATH;
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};

#[derive(serde::Serialize)]
pub struct ForegroundSample {
    pub app_name: Option<String>,
    pub title: Option<String>,
    pub idle_ms: u64,
}

#[command]
pub fn sample_foreground() -> Option<ForegroundSample> {
    unsafe {
        // 1. Get foreground window handle
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }

        // 2. Get window title
        let mut title_buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut title_buf);
        let title = if len > 0 {
            String::from_utf16_lossy(&title_buf[..len as usize])
        } else {
            String::new()
        };
        let title = if title.is_empty() { None } else { Some(title) };

        // 3. Get PID, Process path, app name
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        
        let mut app_name = None;
        if pid != 0 {
            if let Ok(process_handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut path_buf = [0u16; MAX_PATH as usize];
                let mut path_len = MAX_PATH;
                
                if QueryFullProcessImageNameW(process_handle, windows::Win32::System::Threading::PROCESS_NAME_FORMAT(0), windows::core::PWSTR::from_raw(path_buf.as_mut_ptr()), &mut path_len).is_ok() {
                    let full_path = String::from_utf16_lossy(&path_buf[..path_len as usize]);
                    if let Some(filename) = std::path::Path::new(&full_path).file_name() {
                        app_name = Some(filename.to_string_lossy().to_string().to_lowercase());
                    }
                }
                let _ = windows::Win32::Foundation::CloseHandle(process_handle);
            }
        }

        // 4. Get idle time
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        
        let idle_ms = if GetLastInputInfo(&mut lii).as_bool() {
            let tick_count = GetTickCount();
            (tick_count.saturating_sub(lii.dwTime)) as u64
        } else {
            0
        };

        Some(ForegroundSample {
            app_name,
            title,
            idle_ms,
        })
    }
}
