//! Where the viewer finds its server: a small JSON file that names the server's address and the
//! file holding the key. The key itself is never in the configuration.
//!
//! ```json
//! { "server": "http://127.0.0.1:3000", "key_file": "~/.config/grenier/key" }
//! ```
//!
//! The viewer keeps its preferences there too, beside them: `sidebar_width` and `theme`
//! (`system`, `light` or `dark`).

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::client::{Client, Key};
use ui::text as words;

/// The environment variable that names another configuration file.
pub const CONFIG_VARIABLE: &str = "HIPPOCAMPE_DESKTOP_CONFIG";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    server: String,
    key_file: String,
    #[serde(default, rename = "sidebar_width")]
    _sidebar_width: Option<u32>,
    #[serde(default, rename = "theme")]
    _theme: Option<String>,
}

/// What the viewer keeps from one start to the next.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Preferences {
    pub sidebar_width: Option<u32>,
    pub theme: Option<String>,
}

/// The preferences the configuration holds; none when it does not read.
pub fn preferences() -> Preferences {
    path()
        .map(|path| preferences_from(&path))
        .unwrap_or_default()
}

fn preferences_from(path: &Path) -> Preferences {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Keeps a preference in the configuration, the rest of it as it was. A configuration that does
/// not read is left alone: the preference is kept for this run only.
pub fn remember(name: &str, value: serde_json::Value) {
    if let Some(path) = path() {
        remember_in(&path, name, value);
    }
}

fn remember_in(path: &Path, name: &str, value: serde_json::Value) {
    let Some(mut config) = std::fs::read_to_string(path).ok().and_then(|text| {
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&text).ok()
    }) else {
        return;
    };
    config.insert(name.to_string(), value);
    let Ok(text) = serde_json::to_string_pretty(&config) else {
        return;
    };
    // Written beside it, then renamed over it: an interrupted write never leaves it empty.
    let file = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    let next = path.with_file_name(format!(".{file}.new"));
    if std::fs::write(&next, text + "\n").is_ok() {
        let _ = std::fs::rename(&next, path);
    }
}

/// The configuration file: the one `HIPPOCAMPE_DESKTOP_CONFIG` names, else `grenier/desktop.json`
/// in the system's configuration folder.
pub fn path() -> Option<PathBuf> {
    std::env::var_os(CONFIG_VARIABLE)
        .map(PathBuf::from)
        .or_else(|| dirs::config_dir().map(|folder| folder.join("grenier").join("desktop.json")))
}

/// The client the configuration describes, or a sentence that says what to fix.
pub fn client() -> Result<Client, String> {
    let path = path().ok_or(words::NO_CONFIGURATION_FOLDER)?;
    client_from(&path, dirs::home_dir().as_deref())
}

fn client_from(path: &Path, home: Option<&Path>) -> Result<Client, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|_| words::create_configuration(&path.display().to_string()))?;
    let config: Config = serde_json::from_str(&text).map_err(|error| {
        words::unreadable_configuration(&path.display().to_string(), &error.to_string())
    })?;
    let key_file = match (config.key_file.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(&config.key_file),
    };
    let key = std::fs::read_to_string(&key_file)
        .map_err(|_| words::unreadable_key(&key_file.display().to_string()))?;
    let key = key.trim();
    if key.is_empty() {
        return Err(words::empty_key(&key_file.display().to_string()));
    }
    Ok(Client::new(config.server, Key::new(key)))
}

#[cfg(test)]
mod tests {
    use super::{Preferences, client_from, preferences_from, remember_in};

    fn folder(name: &str) -> std::path::PathBuf {
        let folder =
            std::env::temp_dir().join(format!("grenier-config-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&folder).expect("a scratch folder");
        folder
    }

    #[test]
    fn the_server_and_the_key_file_under_home_are_read() {
        let home = folder("home");
        std::fs::write(home.join("key"), "secret-of-test\n").expect("the key is written");
        let config = home.join("desktop.json");
        std::fs::write(
            &config,
            r#"{ "server": "http://127.0.0.1:3000/", "key_file": "~/key" }"#,
        )
        .expect("the configuration is written");
        let client = client_from(&config, Some(&home)).expect("the configuration reads");
        assert_eq!(client.server(), "http://127.0.0.1:3000");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn a_missing_file_or_key_says_what_to_create() {
        let empty = folder("empty");
        let config = empty.join("desktop.json");
        assert!(
            client_from(&config, None)
                .expect_err("no configuration")
                .contains("Create")
        );
        std::fs::write(
            &config,
            r#"{ "server": "http://x", "key_file": "/nowhere/key" }"#,
        )
        .expect("the configuration is written");
        assert!(
            client_from(&config, None)
                .expect_err("no key")
                .contains("/nowhere/key")
        );
        std::fs::remove_dir_all(empty).ok();
    }

    #[test]
    fn a_preference_is_kept_beside_the_server_and_read_back() {
        let home = folder("preferences");
        std::fs::write(home.join("key"), "secret-of-test\n").expect("the key is written");
        let config = home.join("desktop.json");
        std::fs::write(&config, r#"{ "server": "http://x", "key_file": "~/key" }"#)
            .expect("the configuration is written");
        remember_in(&config, "sidebar_width", serde_json::json!(340));
        remember_in(&config, "theme", serde_json::json!("dark"));
        assert_eq!(
            preferences_from(&config),
            Preferences {
                sidebar_width: Some(340),
                theme: Some("dark".into())
            }
        );
        // The server and the key are still read from it.
        assert!(client_from(&config, Some(&home)).is_ok());
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn an_interrupted_write_keeps_the_configuration_as_it_was() {
        let home = folder("interrupted");
        let config = home.join("desktop.json");
        let before = r#"{ "server": "http://x", "key_file": "~/key" }"#;
        std::fs::write(&config, before).expect("the configuration is written");
        // The file the new configuration is written to first cannot be written.
        std::fs::create_dir_all(home.join(".desktop.json.new")).expect("a folder in its way");
        remember_in(&config, "theme", serde_json::json!("dark"));
        assert_eq!(
            std::fs::read_to_string(&config).expect("still there"),
            before
        );
        std::fs::remove_dir_all(home).ok();
    }
}
