//! What the user asks for. Screens emit intents; the application decides what they mean (fetch
//! an entry, run a search, open a browser). A screen never acts on them itself.

use std::rc::Rc;

use gpui_kit::{Action, App, SharedString, Window, actions};
use serde::Deserialize;

/// What the user asks the viewer for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Intent {
    /// Open the entry of that id or slug.
    Open(SharedString),
    /// Open the ancestor at that depth of the open entry's path (0 is the root).
    OpenAncestor(usize),
    /// Search for that text, of one type when given.
    Search {
        query: SharedString,
        type_name: Option<SharedString>,
    },
    /// Open a web address in the browser.
    OpenUrl(SharedString),
    /// Go back, or forward, in what was opened.
    Back,
    Forward,
    /// Try again what failed.
    Retry,
}

/// Where a screen sends what the user asks for: the viewer turns it into an event.
pub type OnIntent = Rc<dyn Fn(Intent, &mut Window, &mut App)>;

/// A link of a rendered body was activated: an entry when it starts with `grenier://`, else a web
/// address.
#[derive(Action, Clone, Debug, PartialEq, Deserialize)]
#[action(namespace = viewer, no_json)]
pub struct FollowLink {
    pub url: SharedString,
}

actions!(viewer, [Back, Forward, FocusSearch]);

/// The scheme of a `[[slug]]` reference once rendered as a link.
pub const ENTRY_LINK: &str = "grenier://";

/// What following a link means: an entry of the vault, or a web address.
pub fn intent_of_link(url: &str) -> Intent {
    url.strip_prefix(ENTRY_LINK).map_or_else(
        || Intent::OpenUrl(url.to_string().into()),
        |slug| Intent::Open(slug.to_string().into()),
    )
}

/// A Markdown body with each `[[slug]]` reference turned into a link to the entry. References
/// inside code are left alone.
pub fn with_entry_links(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut fenced = false;
    for line in body.split_inclusive('\n') {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            fenced = !fenced;
        }
        if fenced {
            out.push_str(line);
            continue;
        }
        let mut rest = line;
        let mut in_code = false;
        while let Some(index) = rest.find(['`', '[']) {
            let (before, after) = rest.split_at(index);
            out.push_str(before);
            if let Some(code) = after.strip_prefix('`') {
                in_code = !in_code;
                out.push('`');
                rest = code;
            } else if !in_code
                && let Some(inner) = after.strip_prefix("[[")
                && let Some(end) = inner.find("]]")
                && !inner[..end].is_empty()
                && !inner[..end].contains(['[', ']', '\n'])
            {
                let slug = &inner[..end];
                out.push_str(&format!("[{slug}]({ENTRY_LINK}{slug})"));
                rest = &inner[end + 2..];
            } else {
                out.push('[');
                rest = &after[1..];
            }
        }
        out.push_str(rest);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reference_becomes_a_link_to_the_entry_but_not_in_code() {
        assert_eq!(
            with_entry_links("See [[plum-tart]] and `[[not-this]]`.\n```\n[[nor-this]]\n```\n"),
            "See [plum-tart](grenier://plum-tart) and `[[not-this]]`.\n```\n[[nor-this]]\n```\n"
        );
    }

    #[test]
    fn a_link_opens_an_entry_or_a_web_address() {
        assert_eq!(
            intent_of_link("grenier://plum-tart"),
            Intent::Open("plum-tart".into())
        );
        assert_eq!(
            intent_of_link("https://example.org/"),
            Intent::OpenUrl("https://example.org/".into())
        );
    }
}
