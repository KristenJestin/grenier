//! The screens and components of the Grenier desktop viewer. A screen never reaches the network:
//! it receives plain data and a state (loading, empty, error, ready) and emits what the user
//! asks for (open an entry, search, follow a link). The gallery (`story`) shows each of them with
//! invented data; the application (`app`) feeds them from the server.

pub mod placeholder;
pub mod theme;
