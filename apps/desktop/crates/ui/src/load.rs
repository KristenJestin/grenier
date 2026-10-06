//! What a screen shows while its data comes: nothing yet, nothing at all, a problem, or the data.

use gpui_kit::SharedString;

/// The state of what a screen shows.
#[derive(Clone, Debug)]
pub enum Load<T> {
    /// The data is on its way.
    Loading,
    /// The data came, and there is none.
    Empty,
    /// The data could not come.
    Failed(Problem),
    /// The data.
    Ready(T),
}

/// Why the data could not come, as the owner can act on it.
#[derive(Clone, Debug)]
pub enum Problem {
    /// The server does not answer.
    Unreachable,
    /// The server refused the key, with its sentence.
    KeyRefused(SharedString),
    /// The server refused what was asked, with its sentence: an entry that does not exist.
    Refused(SharedString),
    /// The viewer is not set up to reach a server: what to do about it.
    Unconfigured(SharedString),
}
