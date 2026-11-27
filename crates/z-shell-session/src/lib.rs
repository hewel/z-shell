//! PAM and Polkit authentication, plus cross-process idle, sleep, and lock coordination.

pub mod coordinator;
pub mod idle;
pub(crate) mod logind_session;
pub mod pam;
pub(crate) mod passwd;
pub mod polkit;
pub mod screensaver;
pub mod service;
pub mod wayland_idle;
