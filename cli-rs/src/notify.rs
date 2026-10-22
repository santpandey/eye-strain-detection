//! OS notifications for monitor reminders — best effort, never fails.
//!
//! notify-rust toasts; on any failure a console [REMINDER] line is printed
//! instead (same contract as the app's Notification path).

pub fn send_notification(title: &str, body: &str) {
    // Windows toasts via notify-rust need an AppUserModelID shortcut we don't
    // install, and the WinRT path can hard-crash (SIGSEGV) rather than return
    // Err — catch_unwind can't save a segfault, and a crash kills the whole
    // monitor loop. The console reminder is the real UX, so toasts stay
    // Windows-opt-in via BLINKWELL_TOAST=1 until we register an AUMID.
    let enabled = !cfg!(windows) || std::env::var_os("BLINKWELL_TOAST").is_some();
    let shown = enabled
        && std::panic::catch_unwind(|| {
            notify_rust::Notification::new()
                .summary(title)
                .body(body)
                .appname("blinkwell")
                .timeout(notify_rust::Timeout::Milliseconds(10_000))
                .show()
                .is_ok()
        })
        .unwrap_or(false);
    if enabled && !shown {
        // Diagnostics belong on stderr — a plain-text line on stdout would
        // corrupt `monitor --json` output. The caller already prints the
        // reminder for human runs.
        use std::io::Write;
        let _ = writeln!(std::io::stderr(), "[REMINDER] {title} — {body}");
        let _ = std::io::stderr().flush();
    }
}
