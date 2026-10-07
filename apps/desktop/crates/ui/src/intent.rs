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
    /// Open the entry of that slug at a heading of its body, named as `[[slug#heading]]` names it.
    OpenAt {
        entry: SharedString,
        heading: SharedString,
    },
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

/// What following a link means: an entry of the vault, at one of its headings when the link names
/// one, or a web address.
pub fn intent_of_link(url: &str) -> Intent {
    match url.strip_prefix(ENTRY_LINK) {
        None => Intent::OpenUrl(url.to_string().into()),
        Some(target) => match target.split_once('#') {
            Some((entry, heading)) if !heading.is_empty() => Intent::OpenAt {
                entry: entry.to_string().into(),
                heading: heading.to_string().into(),
            },
            Some((entry, _)) => Intent::Open(entry.to_string().into()),
            None => Intent::Open(target.to_string().into()),
        },
    }
}

/// A Markdown body with each reference turned into a link to the entry, in the three forms the
/// server reads: `[[slug]]`, `[[slug|text]]` and `[[slug#heading]]` (the last two together too).
/// A link is named by its text when it gives one, else by the entry's title when `title_of`
/// knows it, else by its slug. References inside code are left alone.
pub fn with_entry_links(body: &str, title_of: impl Fn(&str) -> Option<String>) -> String {
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
                let (target, text) = inner[..end]
                    .split_once('|')
                    .map_or((&inner[..end], None), |(target, text)| (target, Some(text)));
                let slug = target.split_once('#').map_or(target, |(slug, _)| slug);
                let title = text
                    .map(str::to_string)
                    .or_else(|| title_of(slug))
                    .unwrap_or_else(|| slug.to_string());
                out.push_str(&format!("[{title}]({ENTRY_LINK}{target})"));
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
            with_entry_links(
                "See [[plum-tart]] and `[[not-this]]`.\n```\n[[nor-this]]\n```\n",
                |_| None
            ),
            "See [plum-tart](grenier://plum-tart) and `[[not-this]]`.\n```\n[[nor-this]]\n```\n"
        );
    }

    #[test]
    fn a_reference_is_named_by_the_title_of_its_entry_when_known() {
        assert_eq!(
            with_entry_links("See [[plum-tart]].", |slug| {
                (slug == "plum-tart").then(|| "Plum tart".to_string())
            }),
            "See [Plum tart](grenier://plum-tart)."
        );
    }

    #[test]
    fn a_reference_may_name_its_text_and_a_heading() {
        let title_of = |slug: &str| (slug == "plum-tart").then(|| "Plum tart".to_string());
        assert_eq!(
            with_entry_links(
                "[[plum-tart|the tart]], [[plum-tart#method]], [[plum-tart#method|how]].",
                title_of
            ),
            "[the tart](grenier://plum-tart), [Plum tart](grenier://plum-tart#method), \
             [how](grenier://plum-tart#method)."
        );
    }

    #[test]
    fn a_link_to_a_heading_opens_the_entry_at_it() {
        assert_eq!(
            intent_of_link("grenier://plum-tart#method"),
            Intent::OpenAt {
                entry: "plum-tart".into(),
                heading: "method".into()
            }
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
