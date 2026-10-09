//! The screens and components of the Hippocampe desktop viewer. A screen never reaches the network:
//! it receives plain data and a state (loading, empty, error, ready) and emits what the user
//! asks for (open an entry, search, follow a link). The gallery (`story`) shows each of them with
//! invented data; the application (`app`) feeds them from the server.

pub mod assets;
pub mod entry;
pub mod intent;
pub mod links;
pub mod list;
pub mod load;
pub mod motion;
pub mod parts;
pub mod search;
pub mod status;
pub mod text;
pub mod theme;
pub mod viewer;
