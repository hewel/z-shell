use z_shell_session::screensaver::{ScreenSaverError, ScreenSaverRegistry};

#[test]
fn screensaver_cookies_are_connection_scoped_and_cleaned_on_disconnect() {
    let registry = ScreenSaverRegistry::new();
    registry.open();
    let first = registry
        .inhibit(":1.10", "video-player", "playing a movie")
        .expect("first cookie");
    let second = registry
        .inhibit(":1.11", "presentation", "presenting")
        .expect("second cookie");
    assert_ne!(first, second);
    assert_eq!(registry.active_count(), 2);

    assert_eq!(
        registry.uninhibit(":1.10", second),
        Err(ScreenSaverError::AccessDenied)
    );
    assert_eq!(registry.active_count(), 2);
    registry.disconnect(":1.10");
    assert_eq!(registry.active_count(), 1);
    let remaining = registry.inhibitors();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].reason, "presentation: presenting");
    registry.uninhibit(":1.11", second).expect("owner release");
    assert_eq!(registry.active_count(), 0);
}

#[test]
fn screensaver_shutdown_clears_cookies_and_stops_accepting_new_ones() {
    let registry = ScreenSaverRegistry::new();
    registry.open();
    registry
        .inhibit(":1.10", "video-player", "playing")
        .expect("cookie");
    registry.shutdown();
    assert_eq!(registry.active_count(), 0);
    assert_eq!(
        registry.inhibit(":1.12", "other", "late"),
        Err(ScreenSaverError::Unavailable)
    );
    assert_eq!(
        registry.uninhibit(":1.12", 999),
        Err(ScreenSaverError::UnknownCookie)
    );
}
