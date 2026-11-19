# Fcitx5 Input Method Dual-Mode Integration and Topic Split

**Status:** accepted

`z-shelld` integrates Fcitx5 inside `crates/z-shell-desktop` behind two distinct bus topics and three configurable runtime modes (`[ime].mode = "indicator_only" | "kimpanel" | "disabled"`, defaulting to `"indicator_only"`):

1. **Low-frequency `desktop.ime`** exposes **Input method** status (active mode, backend availability, active/enabled flag, short display label extracted from `label=` hints or engine name, icon name/path, IM properties, switchable group entries, and transient `exec_menu` payloads) with `SourceBaseline` vs `Live` update distinction so UI hosts can display an IM-switch OSD only on real switches.
2. **High-frequency `desktop.ime.panel`** exposes **Input method panel** live composition state (`aux`, `preedit`, `caret`, `lookup_table` with labels/texts/cursor/paging/layout hint, `spot_rect` carrying verbatim `(x, y, w, h, relative, scale)`, and `visible`). Separating the two topics prevents every keystroke from waking bar widgets or unrelated subscribers, and lets `z-shelld` clear and suppress live keystroke composition whenever the session is locked (`session.lock`).

In the default **`indicator_only`** mode, `z-shelld` deliberately does **not** claim `org.kde.impanel`; Fcitx5 retains its native Wayland `zwp_input_popup_surface_v2` cursor-following candidate popup while `z-shelld` reacts in real time to Fcitx5's `StatusNotifierItem` updates and queries/controls `org.fcitx.Fcitx.Controller1` (`CurrentInputMethodInfo`, `InputMethodGroupInfo`, `State`, `Toggle`, `SetCurrentIM`, `ReloadConfig`, `Configure`). When the user opts into **`kimpanel`** mode, `z-shelld` claims `org.kde.impanel` with `DoNotQueue` (never stealing from another kimpanel owner), implements `org.kde.impanel` and `org.kde.impanel2` (`PanelCreated`/`PanelCreated2`, `SetSpotRect`, `SetRelativeSpotRect`, `SetRelativeSpotRectV2`, `SetLookupTable`), monitors the active `org.kde.kimpanel.inputmethod` sender via `NameOwnerChanged` to clear stale candidates immediately on crash/exit, and releases `org.kde.impanel` cleanly on mode switch or shutdown. `z-shelld` never claims GNOME/Mutter-specific `org.fcitx.GnomeHelper` (ADR-0002), and forwards `spot_rect` verbatim so UI surfaces default to shell-anchored placement and optionally upgrade to cursor-following when a compositor plugin provides focused-window coordinates.

## Considered Options

- **Claiming `org.kde.impanel` unconditionally by default:** Rejected because owning `org.kde.impanel` causes Fcitx5 to disable its native Wayland `classicui` cursor-following candidate popup (`zwp_input_popup_surface_v2`), whereas standalone `zwlr_layer_shell_v1` clients cannot resolve focused-window global coordinates without compositor-specific IPC.
- **Publishing properties and live preedit/candidates on one combined `desktop.ime` topic:** Rejected because typing generates high-frequency updates that would needlessly re-render bar indicators and complicate lock-screen keystroke redaction.
- **Polling `org.fcitx.Fcitx.Controller1` on a timer in `indicator_only` mode:** Rejected because `z-shell-desktop` already hosts the session `StatusNotifierWatcher` and receives instant Fcitx5 `NewIcon`/`NewLabel`/`NewToolTip` signals with zero polling overhead.

## Consequences

- Out of the box (`indicator_only`), users get instant bar labels (`中`/`英`/`拼`/`EN`), IM switching, and IM-switch OSD while preserving pixel-accurate native Wayland cursor-following candidate popups.
- Opting into `mode = "kimpanel"` enables fully themed `z-shell` candidate popups (`SelectCandidate`, `LookupTablePageUp/Down`, `MovePreeditCaret`, `TriggerProperty`) without stealing `org.kde.impanel` from another desktop environment or leaving stale state on Fcitx5 restart.
- While the screen is locked, `desktop.ime.panel` is cleared/suppressed and public `ime.*` control commands return `PermissionDenied`.
