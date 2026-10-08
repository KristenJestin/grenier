//! `scripts/update.sh` against a fake release server: a local folder served over HTTP.
#![cfg(target_os = "linux")]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A folder of its own under the system's temporary folder.
fn scratch() -> PathBuf {
    let folder = std::env::temp_dir().join(format!(
        "grenier-update-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir_all(&folder).expect("the scratch folder is made");
    folder
}

/// A viewer that only says its version, as the real one does with `--version`.
fn fake_viewer(path: &Path, version: &str) {
    fs::write(
        path,
        format!("#!/bin/sh\necho 'grenier-desktop {version}'\n"),
    )
    .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// Serves `folder` over HTTP on a free port, for as long as the test runs: its address.
fn serve(folder: PathBuf) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
    let address = format!("http://{}", listener.local_addr().unwrap());
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut line = String::new();
            if BufReader::new(&stream).read_line(&mut line).is_err() {
                continue;
            }
            let path = line.split_whitespace().nth(1).unwrap_or("/");
            let file = folder.join(path.trim_start_matches('/'));
            let answer = match fs::read(&file) {
                Ok(bytes) => [
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        bytes.len()
                    )
                    .into_bytes(),
                    bytes,
                ]
                .concat(),
                Err(_) => {
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_vec()
                }
            };
            let _ = stream.write_all(&answer);
        }
    });
    address
}

/// A release of `version`, as GitHub would answer it, served from a folder; the address of its
/// `latest`. With `tampered`, the checksum attached does not match the archive.
fn release(version: &str, tampered: bool) -> String {
    let folder = scratch();
    let name = format!("grenier-desktop-{version}");
    let inside = folder.join(&name);
    fs::create_dir_all(&inside).unwrap();
    fake_viewer(&inside.join("grenier-desktop"), version);
    fs::write(
        inside.join("grenier.desktop"),
        "[Desktop Entry]\nName=Grenier\nExec=grenier-desktop\nIcon=grenier\nType=Application\n",
    )
    .unwrap();
    fs::write(inside.join("grenier.png"), "an icon").unwrap();
    let archive = format!("{name}-linux-x86_64.tar.gz");
    let made = Command::new("tar")
        .args(["-czf", &archive, &name])
        .current_dir(&folder)
        .status()
        .unwrap();
    assert!(made.success());
    let summed = Command::new("sha256sum")
        .arg(&archive)
        .current_dir(&folder)
        .output()
        .unwrap();
    let sum = if tampered {
        format!("{}  {archive}\n", "0".repeat(64))
    } else {
        String::from_utf8(summed.stdout).unwrap()
    };
    fs::write(folder.join(format!("{archive}.sha256")), sum).unwrap();
    let address = serve(folder.clone());
    fs::write(
        folder.join("latest"),
        format!(
            "{{\n  \"tag_name\": \"v{version}\",\n  \"assets\": [\n    {{\n      \"name\": \"{archive}\",\n      \"browser_download_url\": \"{address}/{archive}\"\n    }}\n  ]\n}}\n"
        ),
    )
    .unwrap();
    format!("{address}/latest")
}

/// A home with the viewer of `installed` in it, if any, and its configuration.
fn home(installed: Option<&str>) -> PathBuf {
    let home = scratch();
    fs::create_dir_all(home.join(".local/bin")).unwrap();
    fs::create_dir_all(home.join(".config/grenier")).unwrap();
    fs::write(home.join(".config/grenier/key"), "a key").unwrap();
    if let Some(version) = installed {
        fake_viewer(&home.join(".local/bin/grenier-desktop"), version);
    }
    home
}

/// The script run as the owner would, from a copy outside the repository.
fn update(home: &Path, latest: &str, check: bool) -> Output {
    let copy = home.join("update.sh");
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/update.sh"),
        &copy,
    )
    .unwrap();
    let mut command = Command::new("sh");
    command
        .arg(&copy)
        .env("HOME", home)
        .env_remove("XDG_DATA_HOME")
        .env("GRENIER_RELEASES_API", latest);
    if check {
        command.arg("--check");
    }
    command.output().unwrap()
}

fn installed(home: &Path) -> String {
    let printed = Command::new(home.join(".local/bin/grenier-desktop"))
        .arg("--version")
        .output()
        .unwrap();
    String::from_utf8(printed.stdout).unwrap()
}

#[test]
fn a_newer_release_is_installed_with_its_launcher_and_icon_and_the_key_left_alone() {
    let home = home(Some("0.4.0"));
    let done = update(&home, &release("0.5.0", false), false);
    assert!(
        done.status.success(),
        "{}",
        String::from_utf8_lossy(&done.stderr)
    );
    assert_eq!(installed(&home), "grenier-desktop 0.5.0\n");
    let launcher =
        fs::read_to_string(home.join(".local/share/applications/grenier.desktop")).unwrap();
    assert!(launcher.contains(&format!(
        "Exec={}/.local/bin/grenier-desktop",
        home.display()
    )));
    assert!(
        home.join(".local/share/icons/hicolor/256x256/apps/grenier.png")
            .exists()
    );
    assert_eq!(
        fs::read_to_string(home.join(".config/grenier/key")).unwrap(),
        "a key"
    );
}

#[test]
fn the_same_version_installed_is_left_as_it_is() {
    let home = home(Some("0.5.0"));
    let done = update(&home, &release("0.5.0", false), false);
    assert!(done.status.success());
    assert_eq!(
        String::from_utf8_lossy(&done.stdout),
        "grenier-desktop 0.5.0 is the latest.\n"
    );
    assert!(
        !home
            .join(".local/share/applications/grenier.desktop")
            .exists()
    );
}

#[test]
fn a_wrong_checksum_is_refused_and_the_installed_viewer_stays() {
    let home = home(Some("0.4.0"));
    let done = update(&home, &release("0.5.0", true), false);
    assert!(!done.status.success());
    assert!(String::from_utf8_lossy(&done.stderr).contains("does not match"));
    assert_eq!(installed(&home), "grenier-desktop 0.4.0\n");
}

#[test]
fn check_says_an_update_exists_and_changes_nothing() {
    let home = home(Some("0.4.0"));
    let done = update(&home, &release("0.5.0", false), true);
    assert!(done.status.success());
    assert_eq!(
        String::from_utf8_lossy(&done.stdout),
        "grenier-desktop 0.5.0 is available (installed: 0.4.0).\n"
    );
    assert_eq!(installed(&home), "grenier-desktop 0.4.0\n");
}
