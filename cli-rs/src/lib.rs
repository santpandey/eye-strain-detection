//! blinkwell — on-device eye-fatigue monitor.
//!
//! The Rust twin of the web app's analysis pipeline (src/lib/analysis +
//! src/lib/vision). Every numeric threshold lives in `config`; keep it in
//! sync with src/lib/analysis/config.ts and cli/blinkwell/config.py.

pub mod baseline;
pub mod blink;
pub mod capture;
pub mod config;
pub mod eval;
pub mod exercises;
pub mod features;
pub mod notify;
pub mod quality;
pub mod report;
pub mod rules;
pub mod score;
pub mod session;
pub mod stderr_filter;
pub mod storage;
pub mod thresholds;
