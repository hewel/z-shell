//! Standalone PAM helper and cross-process idle, sleep, and lock coordination.

pub mod coordinator;
pub mod idle;
pub mod pam;
pub mod screensaver;
pub mod service;
pub mod wayland_idle;
