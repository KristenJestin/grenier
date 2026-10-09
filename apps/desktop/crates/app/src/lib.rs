//! The Hippocampe desktop viewer: the screens of `ui`, fed by the read API of a server.

pub mod client;
pub mod config;
pub mod shell;

/// The version of the viewer: the tag a release builds it from (`HIPPOCAMPE_VERSION`), `unknown` in a
/// local build.
pub const VERSION: &str = match option_env!("HIPPOCAMPE_VERSION") {
    Some(version) => version,
    None => "unknown",
};
