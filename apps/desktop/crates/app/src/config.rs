//! Where the viewer finds its server: a small JSON file that names the server's address and the
//! file holding the key. The key itself is never in the configuration.
//!
//! ```json
//! { "server": "http://127.0.0.1:3000", "key_file": "~/.config/grenier/key" }
//! ```

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::client::{Client, Key};

/// The environment variable that names another configuration file.
pub const CONFIG_VARIABLE: &str = "GRENIER_DESKTOP_CONFIG";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    server: String,
    key_file: String,
}

/// The configuration file: the one `GRENIER_DESKTOP_CONFIG` names, else `grenier/desktop.json`
/// in the system's configuration folder.
pub fn path() -> Option<PathBuf> {
    std::env::var_os(CONFIG_VARIABLE)
        .map(PathBuf::from)
        .or_else(|| dirs::config_dir().map(|folder| folder.join("grenier").join("desktop.json")))
}

/// The client the configuration describes, or a sentence that says what to fix.
pub fn client() -> Result<Client, String> {
    let path = path().ok_or("Aucun dossier de configuration sur ce système.")?;
    client_from(&path, dirs::home_dir().as_deref())
}

fn client_from(path: &Path, home: Option<&Path>) -> Result<Client, String> {
    let text = std::fs::read_to_string(path).map_err(|_| {
        format!(
            "Créez {} avec l'adresse du serveur et le fichier de la clé : \
             {{ \"server\": \"http://127.0.0.1:3000\", \"key_file\": \"~/.config/grenier/key\" }}",
            path.display()
        )
    })?;
    let config: Config = serde_json::from_str(&text)
        .map_err(|error| format!("{} ne se lit pas : {error}", path.display()))?;
    let key_file = match (config.key_file.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(&config.key_file),
    };
    let key = std::fs::read_to_string(&key_file)
        .map_err(|_| format!("Le fichier de la clé {} ne se lit pas.", key_file.display()))?;
    let key = key.trim();
    if key.is_empty() {
        return Err(format!(
            "Le fichier de la clé {} est vide.",
            key_file.display()
        ));
    }
    Ok(Client::new(config.server, Key::new(key)))
}

#[cfg(test)]
mod tests {
    use super::client_from;

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
                .contains("Créez")
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
}
