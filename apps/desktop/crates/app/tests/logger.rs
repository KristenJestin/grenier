//! The viewer prints the errors GPUI logs: a failure at start says why instead of ending in
//! silence. Shown here with an error GPUI logs before it reaches any display: a `WAYLAND_SOCKET`
//! that is not a file descriptor, beside a display that does not exist, so no window can open.
#![cfg(target_os = "linux")]

use std::process::Command;

#[test]
fn an_error_logged_by_gpui_reaches_standard_error() {
    let runtime = std::env::temp_dir().join(format!("grenier-logger-{}", std::process::id()));
    std::fs::create_dir_all(&runtime).unwrap();
    let ran = Command::new(env!("CARGO_BIN_EXE_grenier-desktop"))
        .env_remove("DISPLAY")
        .env_remove("RUST_LOG")
        .env("WAYLAND_SOCKET", "not-a-descriptor")
        .env("WAYLAND_DISPLAY", "grenier-no-such-display")
        .env("XDG_RUNTIME_DIR", &runtime)
        .env("GRENIER_DESKTOP_CONFIG", runtime.join("desktop.json"))
        .output()
        .expect("the viewer runs");
    let said = String::from_utf8_lossy(&ran.stderr);
    assert!(
        said.contains("ignoring WAYLAND_SOCKET=\"not-a-descriptor\""),
        "{said}"
    );
}
