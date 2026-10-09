//! The viewer knows its version: the tag it was built from, `unknown` in a local build.

use std::process::Command;

#[test]
fn the_viewer_prints_its_version_and_opens_no_window() {
    let printed = Command::new(env!("CARGO_BIN_EXE_hippocampe-desktop"))
        .arg("--version")
        .output()
        .expect("the viewer runs");
    assert!(printed.status.success());
    assert_eq!(
        String::from_utf8_lossy(&printed.stdout),
        format!(
            "hippocampe-desktop {}\n",
            option_env!("HIPPOCAMPE_VERSION").unwrap_or("unknown")
        )
    );
    assert_eq!(
        app::VERSION,
        option_env!("HIPPOCAMPE_VERSION").unwrap_or("unknown")
    );
}
