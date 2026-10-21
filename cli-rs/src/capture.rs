//! Frame capture: camera/video → MediaPipe FaceLandmarker → FrameFeatures.
//!
//! Mirrors the measurement side of src/lib/vision/engine.ts + client.ts:
//! whole-frame luma at 64×48, face-region luma at 32×32, eye-ROI glare at
//! 48×24 (Rec.601, >245 cut), then the same compute_frame_features() math.
//! Analysis downstream is the pure ported pipeline.
//!
//! Model: FaceLandmarker VIDEO mode, CPU delegate (the app's own fallback —
//! the PyPI libmediapipe build doesn't ship a GPU delegate on Windows
//! anyway), blendshapes + transformation matrix on. libmediapipe is dlopen'd
//! at first use: the `download` feature fetches it from the official PyPI
//! wheel once (SHA-256 pinned); set MEDIAPIPE_LIB or drop a libmediapipe.dll
//! next to the exe to use a specific build. All local — no frames leave the
//! device.
//!
//! Camera comes from nokhwa (MSMF on Windows). Video files are decoded by
//! piping `ffmpeg -i file -f rawvideo -pix_fmt rgb24 -` (ffmpeg on PATH, or
//! --ffmpeg path) — kept out of the binary on purpose.

use crate::features::FrameFeatures;
use crate::features::{
    compute_frame_features, eye_box, face_box, CategoryLike, LandmarkerResultLike, NormBox, Point,
    RoiMetrics, EYE_CONTOUR_L, EYE_CONTOUR_R,
};
use anyhow::{bail, Context, Result};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

// engine.ts sampler sizes.
const LUMA_W: usize = 64;
const LUMA_H: usize = 48;
const FACE_W: usize = 32;
const FACE_H: usize = 32;
const EYE_W: usize = 48;
const EYE_H: usize = 24;

/// `public/models/face_landmarker.task` relative to the repo root. Overridable
/// with --model; a copy next to the exe works too.
pub fn default_model_path() -> PathBuf {
    // exe_dir/models/face_landmarker.task first (shipped bundle layout)…
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("models").join("face_landmarker.task");
            if p.exists() {
                return p;
            }
        }
    }
    // …then the repo checkout layout (<crate>/../public/models).
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/models/face_landmarker.task")
}

/// Rec.601 luma stats of a normalized box, resampled to out_w×out_h by
/// bilinear interpolation (what the app's canvas region sampler does).
fn region_luma(
    rgb: &[u8],
    img_w: usize,
    img_h: usize,
    region: NormBox,
    out_w: usize,
    out_h: usize,
) -> (f64, f64) {
    // Pixel-space source rect.
    let sx = region[0] * img_w as f64;
    let sy = region[1] * img_h as f64;
    let sw = ((region[2] - region[0]) * img_w as f64).max(1.0);
    let sh = ((region[3] - region[1]) * img_h as f64).max(1.0);

    let at = |x: f64, y: f64| -> (f64, f64, f64) {
        // Bilinear sample; coordinates clamped to the image edge.
        let x0 = x.floor().clamp(0.0, img_w as f64 - 1.0) as usize;
        let y0 = y.floor().clamp(0.0, img_h as f64 - 1.0) as usize;
        let x1 = (x0 + 1).min(img_w - 1);
        let y1 = (y0 + 1).min(img_h - 1);
        let fx = (x - x0 as f64).clamp(0.0, 1.0);
        let fy = (y - y0 as f64).clamp(0.0, 1.0);
        let px = |xx: usize, yy: usize| {
            let o = (yy * img_w + xx) * 3;
            (
                rgb[o] as f64,
                rgb.get(o + 1).copied().unwrap_or(0) as f64,
                rgb.get(o + 2).copied().unwrap_or(0) as f64,
            )
        };
        let (r00, g00, b00) = px(x0, y0);
        let (r10, g10, b10) = px(x1, y0);
        let (r01, g01, b01) = px(x0, y1);
        let (r11, g11, b11) = px(x1, y1);
        let lerp = |a: f64, b: f64, t: f64| a + (b - a) * t;
        (
            lerp(lerp(r00, r10, fx), lerp(r01, r11, fx), fy),
            lerp(lerp(g00, g10, fx), lerp(g01, g11, fx), fy),
            lerp(lerp(b00, b10, fx), lerp(b01, b11, fx), fy),
        )
    };

    let mut sum = 0.0;
    let mut over = 0usize;
    let n = (out_w * out_h) as f64;
    for dy in 0..out_h {
        // OpenCV/canvas-style centre-aligned mapping.
        let y = sy + (dy as f64 + 0.5) * sh / out_h as f64 - 0.5;
        for dx in 0..out_w {
            let x = sx + (dx as f64 + 0.5) * sw / out_w as f64 - 0.5;
            let (r, g, b) = at(x.max(sx).min(sx + sw - 1.0), y.max(sy).min(sy + sh - 1.0));
            let yv = 0.299 * r + 0.587 * g + 0.114 * b;
            sum += yv;
            if yv > crate::config::GLARE_LUMA_CUT {
                over += 1;
            }
        }
    }
    (sum / n, over as f64 / n)
}

/// Mean luma of the whole frame at 64×48.
fn frame_luma(rgb: &[u8], w: usize, h: usize) -> f64 {
    region_luma(rgb, w, h, [0.0, 0.0, 1.0, 1.0], LUMA_W, LUMA_H).0
}

/// MediaPipe FaceLandmarker (VIDEO mode, CPU) producing FrameFeatures.
pub struct LandmarkerEngine {
    landmarker: mediapipe::FaceLandmarker,
    last_ts: i64,
}

impl LandmarkerEngine {
    pub fn new(model_path: &Path) -> Result<Self> {
        if !model_path.exists() {
            bail!(
                "model not found: {} (expected public/models/face_landmarker.task or --model)",
                model_path.display()
            );
        }
        let landmarker =
            mediapipe::FaceLandmarker::builder(mediapipe::ModelSource::path(model_path))
                .delegate(mediapipe::Delegate::Cpu)
                .num_faces(std::num::NonZeroU32::new(1).expect("1 != 0"))
                .output_blendshapes(true)
                .output_transformation_matrixes(true)
                .build_for_video()
                .map_err(|e| anyhow::anyhow!("FaceLandmarker init failed: {e}"))?;
        Ok(LandmarkerEngine {
            landmarker,
            last_ts: -1,
        })
    }

    /// One tightly-packed RGB24 frame → FrameFeatures. t_ms = frame timestamp
    /// (ms, monotonic wall or media time).
    pub fn process(&mut self, rgb: &[u8], w: usize, h: usize, t_ms: f64) -> Result<FrameFeatures> {
        let fl = frame_luma(rgb, w, h);
        let image = mediapipe::Image::from_rgb(
            mediapipe::Size {
                width: w as u32,
                height: h as u32,
            },
            rgb,
        )
        .map_err(|e| anyhow::anyhow!("Image::from_rgb: {e}"))?;
        // detect_for_video needs strictly increasing timestamps;
        // FrameFeatures.t keeps the original t (mirrors engine.ts).
        let ts = (t_ms as i64).max(self.last_ts + 1);
        self.last_ts = ts;
        let res = self
            .landmarker
            .detect_for_video(&image, mediapipe::Timestamp::from_millis(ts))
            .map_err(|e| anyhow::anyhow!("detect_for_video: {e}"))?;

        let res_like = LandmarkerResultLike {
            face_landmarks: res
                .landmarks
                .iter()
                .map(|face| {
                    face.iter()
                        .map(|l| Point {
                            x: l.point.x() as f64,
                            y: l.point.y() as f64,
                            z: l.point.z() as f64,
                        })
                        .collect()
                })
                .collect(),
            face_blendshapes: res
                .blendshapes
                .iter()
                .map(|face| {
                    face.iter()
                        .map(|c| CategoryLike {
                            category_name: c.category_name.clone(),
                            score: c.score.get() as f64,
                        })
                        .collect()
                })
                .collect(),
            facial_transformation_matrixes: res
                .transformation_matrixes
                .iter()
                .map(|m| {
                    let mut a = [0.0f64; 16];
                    for (i, v) in m.as_column_major().iter().enumerate() {
                        a[i] = *v as f64;
                    }
                    a
                })
                .collect(),
        };

        let mut roi = RoiMetrics::default();
        if let Some(lm) = res_like.face_landmarks.first() {
            if lm.len() >= 478 {
                roi.face_luma = region_luma(rgb, w, h, face_box(lm), FACE_W, FACE_H).0;
                roi.glare[0] = region_luma(
                    rgb,
                    w,
                    h,
                    eye_box(lm, &EYE_CONTOUR_R, 0.25, 0.6),
                    EYE_W,
                    EYE_H,
                )
                .1;
                roi.glare[1] = region_luma(
                    rgb,
                    w,
                    h,
                    eye_box(lm, &EYE_CONTOUR_L, 0.25, 0.6),
                    EYE_W,
                    EYE_H,
                )
                .1;
            }
        }

        Ok(compute_frame_features(
            &res_like, t_ms, w as f64, h as f64, fl, roi,
        ))
    }
}

/// What every frame source yields to the pipeline.
pub struct FrameOut {
    pub features: FrameFeatures,
    /// 1-based processed frame index.
    pub n: usize,
    /// Elapsed source ms (wall for camera, media for file).
    pub elapsed_ms: f64,
}

/// Open a camera by index: try 640×480@30 MJPEG first (what the app asks
/// for), then the camera's highest-rate mode, then anything.
fn open_camera(camera_index: u32) -> Result<nokhwa::Camera> {
    use nokhwa::pixel_format::RgbFormat;
    use nokhwa::utils::{
        CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType, Resolution,
    };

    let tries = [
        RequestedFormat::new::<RgbFormat>(RequestedFormatType::Closest(CameraFormat::new(
            Resolution::new(640, 480),
            FrameFormat::MJPEG,
            30,
        ))),
        RequestedFormat::new::<RgbFormat>(RequestedFormatType::HighestFrameRate(30)),
        RequestedFormat::new::<RgbFormat>(RequestedFormatType::AbsoluteHighestFrameRate),
        RequestedFormat::new::<RgbFormat>(RequestedFormatType::None),
    ];
    let mut last_err: Option<anyhow::Error> = None;
    for req in tries {
        match nokhwa::Camera::new(CameraIndex::Index(camera_index), req) {
            Ok(mut cam) => match cam.open_stream() {
                Ok(()) => return Ok(cam),
                Err(e) => last_err = Some(e.into()),
            },
            Err(e) => last_err = Some(e.into()),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("unknown camera error")))
        .context(format!("could not open camera {camera_index}"))
}

/// Call `on_frame(FrameOut)` for each camera frame for `duration_ms` of wall
/// time. The camera is created here and always dropped on return (webcam LED
/// off). `cancel` stops the loop early.
pub fn run_camera<F>(
    engine: &mut LandmarkerEngine,
    camera_index: u32,
    duration_ms: f64,
    cancel: Option<Arc<AtomicBool>>,
    mut on_frame: F,
) -> Result<()>
where
    F: FnMut(&FrameOut),
{
    let mut cam = open_camera(camera_index)?;
    let t0 = Instant::now();
    let mut n = 0usize;
    let run = (|| -> Result<()> {
        loop {
            let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
            if elapsed_ms >= duration_ms {
                break;
            }
            if cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed)) {
                break;
            }
            let buffer = match cam.frame() {
                Ok(b) => b,
                Err(e) => {
                    // A dropped frame is not fatal; a dead stream is.
                    if n == 0 {
                        return Err(e).context("camera frame read failed");
                    }
                    continue;
                }
            };
            let res = buffer.resolution();
            let img = buffer
                .decode_image::<nokhwa::pixel_format::RgbFormat>()
                .context("decode camera frame")?;
            let (w, h) = (res.width() as usize, res.height() as usize);
            let rgb = img.into_raw();
            let f = engine.process(&rgb, w, h, elapsed_ms)?;
            n += 1;
            on_frame(&FrameOut {
                features: f,
                n,
                elapsed_ms,
            });
        }
        Ok(())
    })();
    let _ = cam.stop_stream();
    drop(cam); // MSMF releases the device here → LED off
    run
}

/// Parsed `ffmpeg -i` stream info.
struct VideoInfo {
    width: usize,
    height: usize,
    fps: f64,
}

/// `ffmpeg -i file` prints stream info on stderr; scrape "WxH" and "NN fps".
fn probe_video(ffmpeg: &Path, path: &Path) -> Result<VideoInfo> {
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-i"])
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .context("run ffmpeg probe")?;
    let text = String::from_utf8_lossy(&out.stderr);
    let mut info = VideoInfo {
        width: 0,
        height: 0,
        fps: 30.0,
    };
    for line in text.lines() {
        if !(line.contains("Video:")) {
            continue;
        }
        // First `NNNxNNN` on the Video line wins.
        let mut rest = line;
        while let Some(pos) = rest.find(|c: char| c.is_ascii_digit()) {
            let tail = &rest[pos..];
            let num_end = tail
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(tail.len());
            let w_str = &tail[..num_end];
            if tail[num_end..].starts_with('x') {
                let h_tail = &tail[num_end + 1..];
                let h_end = h_tail
                    .find(|c: char| !c.is_ascii_digit())
                    .unwrap_or(h_tail.len());
                if let (Ok(w), Ok(h)) = (w_str.parse::<usize>(), h_tail[..h_end].parse::<usize>()) {
                    if w >= 16 && h >= 16 {
                        info.width = w;
                        info.height = h;
                        break;
                    }
                }
            }
            rest = &tail[num_end..];
        }
        // "12.34 fps" → capture the number right before " fps".
        if let Some(fps_pos) = line.find(" fps") {
            let before = &line[..fps_pos];
            let num_start = before
                .rfind(|c: char| !(c.is_ascii_digit() || c == '.'))
                .map(|i| i + 1)
                .unwrap_or(0);
            if let Ok(fps) = before[num_start..].trim().parse::<f64>() {
                if fps > 0.0 {
                    info.fps = fps;
                }
            }
        }
        break;
    }
    if info.width == 0 || info.height == 0 {
        bail!(
            "could not read video dimensions from ffmpeg output for {}",
            path.display()
        );
    }
    Ok(info)
}

/// ffmpeg availability: --ffmpeg > PATH lookup.
pub fn find_ffmpeg(override_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = override_path {
        if p.exists() {
            return Some(p.to_path_buf());
        }
        return None;
    }
    for name in ["ffmpeg", "ffmpeg.exe"] {
        if Command::new(name)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
        {
            return Some(PathBuf::from(name));
        }
    }
    None
}

/// Pipe `ffmpeg -i file -f rawvideo -pix_fmt rgb24 -` and call `on_frame` per
/// decoded frame; t = frame index × 1000/fps (every frame processed).
pub fn run_video_file<F>(
    engine: &mut LandmarkerEngine,
    path: &Path,
    ffmpeg: &Path,
    cancel: Option<Arc<AtomicBool>>,
    mut on_frame: F,
) -> Result<()>
where
    F: FnMut(&FrameOut),
{
    let info = probe_video(ffmpeg, path)?;
    let mut child: Child = Command::new(ffmpeg)
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("spawn ffmpeg decoder")?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let frame_bytes = info.width * info.height * 3;
    let mut buf = vec![0u8; frame_bytes];
    let mut i = 0usize;
    let mut result: Result<()> = Ok(());
    loop {
        if cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed)) {
            break;
        }
        match stdout.read_exact(&mut buf) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => {
                result = Err(e).context("read decoded frame");
                break;
            }
        }
        let t = i as f64 * 1000.0 / info.fps;
        match engine.process(&buf, info.width, info.height, t) {
            Ok(f) => {
                i += 1;
                on_frame(&FrameOut {
                    features: f,
                    n: i,
                    elapsed_ms: t,
                });
            }
            Err(e) => {
                result = Err(e);
                break;
            }
        }
    }
    drop(stdout);
    let _ = child.kill();
    let _ = child.wait();
    result
}
