//! OS notifications for monitor reminders — best effort, never fails.
//!
//! notify-rust toasts; on any failure a console [REMINDER] line is printed
//! instead (same contract as the app's Notification path).

pub fn send_notification(title: &str, body: &str) {
    let shown = std::panic::catch_unwind(|| {
        notify_rust::Notification::new()
            .summary(title)
            .body(body)
            .appname("eyefd")
            .timeout(notify_rust::Timeout::Milliseconds(10_000))
            .show()
            .is_ok()
    })
    .unwrap_or(false);
    if !shown {
        // The console line IS the fallback; never let printing kill the loop.
        use std::io::Write;
        let _ = writeln!(std::io::stdout(), "[REMINDER] {title} — {body}");
        let _ = std::io::stdout().flush();
    }
}
