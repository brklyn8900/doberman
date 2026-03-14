use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::ptr;
use std::time::{SystemTime, UNIX_EPOCH};

const MACOS_NOTIFICATION_IDENTITY: &str = "io.armana.doberman";

unsafe extern "C" {
    fn doberman_send_user_notification(
        identifier: *const c_char,
        title: *const c_char,
        body: *const c_char,
        error_out: *mut *mut c_char,
    ) -> c_int;
    fn doberman_notifications_free_string(value: *mut c_char);
}

pub fn send_notification(summary: &str, body: &str) -> Result<(), String> {
    let identifier = format!(
        "{MACOS_NOTIFICATION_IDENTITY}.notification.{}",
        notification_suffix()
    );
    let identifier = CString::new(identifier)
        .map_err(|_| "notification identifier contained an unexpected null byte".to_string())?;
    let title = CString::new(summary)
        .map_err(|_| "notification title contained an unexpected null byte".to_string())?;
    let body = CString::new(body)
        .map_err(|_| "notification body contained an unexpected null byte".to_string())?;

    let mut error_ptr = ptr::null_mut();
    let did_send = unsafe {
        doberman_send_user_notification(
            identifier.as_ptr(),
            title.as_ptr(),
            body.as_ptr(),
            &mut error_ptr,
        )
    };

    if did_send == 1 {
        return Ok(());
    }

    Err(take_error_message(error_ptr))
}

fn notification_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn take_error_message(error_ptr: *mut c_char) -> String {
    if error_ptr.is_null() {
        return "native macOS notification backend failed without an error message".to_string();
    }

    let error = unsafe { CStr::from_ptr(error_ptr).to_string_lossy().into_owned() };
    unsafe { doberman_notifications_free_string(error_ptr) };
    error
}
