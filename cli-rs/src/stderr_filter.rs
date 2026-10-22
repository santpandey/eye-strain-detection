//! fd-2 noise filter.
//!
//! libmediapipe's native code (absl/TFLite) logs straight to OS stderr —
//! XNNPACK INFO lines, feedback-manager warnings, clearcut upload failures.
//! None of it is actionable and absl honors no env var, so the only reliable
//! fix is interposition: fd 2 is redirected through a pipe and a thread
//! forwards only lines that aren't known third-party noise to the real
//! stderr. Our own eprintln! output passes through untouched. Zero deps —
//! thin wrappers over pipe/dup2/SetStdHandle. Set BLINKWELL_RAW_LOG=1 to
//! disable (e.g. when collecting diagnostics).

use std::io::{Read, Write};
use std::mem::ManuallyDrop;

/// Substrings that mark a line as third-party noise (compared lowercase).
/// The absl severity prefix ("W0000 ", "E0000 ", ...) is matched separately.
const NOISE_SUBSTRINGS: &[&str] = &[
    "clearcut",
    "play.googleapis",
    "source location trace",
    "xnnpack",
    "tensorflow lite",
    "inference_feedback_manager",
    "face_landmarker_graph",
];

fn is_noise(line: &str) -> bool {
    let b = line.as_bytes();
    // absl severity prefix: 'I'|'W'|'E'|'F' followed by 4 digits and a space.
    if b.len() > 5
        && matches!(b[0], b'I' | b'W' | b'E' | b'F')
        && b[1..5].iter().all(|c| c.is_ascii_digit())
        && b[5] == b' '
    {
        return true;
    }
    let lower = line.to_ascii_lowercase();
    NOISE_SUBSTRINGS.iter().any(|p| lower.contains(p))
}

/// Filter thread: read the pipe, split on newlines, forward survivors.
fn spawn_filter(mut rd: impl Read + Send + 'static, mut real: ManuallyDrop<std::fs::File>) {
    std::thread::spawn(move || {
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut emit = |bytes: &[u8]| {
            let line = String::from_utf8_lossy(bytes);
            if !is_noise(&line) {
                let _ = real.write_all(line.as_bytes());
                let _ = real.flush();
            }
        };
        loop {
            match rd.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    let mut start = 0;
                    for (i, &b) in buf.iter().enumerate() {
                        if b == b'\n' {
                            emit(&buf[start..=i]);
                            start = i + 1;
                        }
                    }
                    buf.drain(..start);
                }
            }
        }
        if !buf.is_empty() {
            emit(&buf);
        }
    });
}

/// Install the filter early in main. Failure is non-fatal — the app just
/// shows native logs like before.
pub fn install() {
    if std::env::var_os("BLINKWELL_RAW_LOG").is_some() {
        return;
    }
    let _ = install_inner();
}

#[cfg(unix)]
fn install_inner() -> Result<(), ()> {
    use std::os::fd::FromRawFd;
    extern "C" {
        fn pipe(fds: *mut i32) -> i32;
        fn dup(fd: i32) -> i32;
        fn dup2(f1: i32, f2: i32) -> i32;
        fn close(fd: i32) -> i32;
    }
    unsafe {
        let mut fds = [0i32; 2];
        if pipe(fds.as_mut_ptr()) != 0 {
            return Err(());
        }
        let real_fd = dup(2);
        if real_fd < 0 || dup2(fds[1], 2) < 0 {
            close(fds[0]);
            close(fds[1]);
            if real_fd >= 0 {
                close(real_fd);
            }
            return Err(());
        }
        close(fds[1]);
        let rd = std::fs::File::from_raw_fd(fds[0]);
        let real = ManuallyDrop::new(std::fs::File::from_raw_fd(real_fd));
        spawn_filter(rd, real);
    }
    Ok(())
}

#[cfg(windows)]
fn install_inner() -> Result<(), ()> {
    use std::os::windows::io::{FromRawHandle, RawHandle};
    extern "C" {
        fn CreatePipe(
            rd: *mut usize,
            wr: *mut usize,
            attr: *mut core::ffi::c_void,
            size: u32,
        ) -> i32;
        fn GetStdHandle(which: u32) -> usize;
        fn SetStdHandle(which: u32, h: usize) -> i32;
        fn _open_osfhandle(h: isize, flags: i32) -> i32;
        fn _dup2(f1: i32, f2: i32) -> i32;
    }
    const STD_ERROR_HANDLE: u32 = 0xFFFF_FFF4; // (DWORD)-12
    let (mut r, mut w) = (0usize, 0usize);
    unsafe {
        if CreatePipe(&mut r, &mut w, std::ptr::null_mut(), 0) == 0 {
            return Err(());
        }
        let real = ManuallyDrop::new(std::fs::File::from_raw_handle(
            GetStdHandle(STD_ERROR_HANDLE) as RawHandle,
        ));
        // Cover both writer styles: Win32 WriteFile(STD_ERROR_HANDLE) via
        // SetStdHandle, and CRT _write(2)/fwrite(stderr) via _dup2.
        SetStdHandle(STD_ERROR_HANDLE, w);
        let fd = _open_osfhandle(w as isize, 0);
        if fd >= 0 {
            _dup2(fd, 2);
        }
        let rd = std::fs::File::from_raw_handle(r as RawHandle);
        spawn_filter(rd, real);
    }
    Ok(())
}
