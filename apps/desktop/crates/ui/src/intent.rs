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
    /// The sidebar was dragged to this width, in pixels: to keep for the next start.
    SidebarWidth(u32),
    /// A theme was chosen: to show, and to keep for the next start.
    Theme(crate::theme::ThemeChoice),
    /// List the entries a filter keeps: of a type, with a tag, holding supposed values.
    List(ListFilter),
    /// Show the history of the open entry, or the next page of it.
    History,
    /// The next page of the listing shown.
    MoreListed,
    /// Open a group of links whole, or fold it again (the viewer keeps it, the application
    /// never sees it).
    ToggleLinks(SharedString),
}

/// What a listing keeps, each filter shown and removable.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ListFilter {
    /// A type, by its name, with its label to show.
    pub type_name: Option<(SharedString, SharedString)>,
    pub tag: Option<SharedString>,
    /// Only the entries that hold supposed values, links, body or summary.
    pub supposed: bool,
}

impl ListFilter {
    /// Whether it keeps every entry.
    pub fn is_empty(&self) -> bool {
        self.type_name.is_none() && self.tag.is_none() && !self.supposed
    }
}

/// Where a screen sends what the user asks for: the viewer turns it into an event.
pub type OnIntent = Rc<dyn Fn(Intent, &mut Window, &mut App)>;

/// A link of a rendered body was activated: an entry when it starts with `hippocampe://`, else a web
/// address.
#[derive(Action, Clone, Debug, PartialEq, Deserialize)]
#[action(namespace = viewer, no_json)]
pub struct FollowLink {
    pub url: SharedString,
}

actions!(viewer, [Back, Forward, FocusSearch]);

/// The scheme of a `[[slug]]` reference once rendered as a link.
pub const ENTRY_LINK: &str = "hippocampe://";

/// What following a link means: an entry of the vault, at one of its headings when the link names
/// one, or a web address.
pub fn intent_of_link(url: &str) -> Intent {
    match url.strip_prefix(ENTRY_LINK) {
        None => Intent::OpenUrl(url.to_string().into()),
        Some(target) => match target.split_once('#') {
            Some((entry, heading)) if !heading.is_empty() => Intent::OpenAt {
                entry: entry.to_string().into(),
                heading: decoded(heading).into(),
            },
            Some((entry, _)) => Intent::Open(entry.to_string().into()),
            None => Intent::Open(target.to_string().into()),
        },
    }
}

/// A heading as a link carries it: every byte but letters, digits and `-_.~` as `%XX`.
fn encoded(heading: &str) -> String {
    heading
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

/// A heading back from a link: each `%XX` as its byte.
fn decoded(heading: &str) -> String {
    let bytes = heading.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = bytes
            .get(at + 1..at + 3)
            .and_then(|pair| std::str::from_utf8(pair).ok())
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match (bytes[at], hex) {
            (b'%', Some(byte)) => {
                out.push(byte);
                at += 3;
            }
            (byte, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A Markdown body with each reference turned into a link to the entry `entry_of` says it names,
/// by its id and title, in the three forms the server reads: `[[slug]]`, `[[slug|text]]` and
/// `[[slug#heading]]` (the last two together too). A link is named by its text when it gives one,
/// else by the entry's title. A reference that names no entry yet (it waits for one) is plain text,
/// never a link that fails. References inside code are left alone.
pub fn with_entry_links(body: &str, entry_of: impl Fn(&str) -> Option<(String, String)>) -> String {
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
                let (slug, heading) = target
                    .split_once('#')
                    .map_or((target, None), |(slug, heading)| (slug, Some(heading)));
                // As the server reads it: `[[ plum-tart ]]` names `plum-tart`.
                let slug = slug.trim();
                match entry_of(slug) {
                    Some((id, title)) => {
                        let title = text.map_or(title, str::to_string);
                        // Encoded, so a heading with spaces stays one link target.
                        let anchor = heading
                            .map(|heading| format!("#{}", encoded(heading.trim())))
                            .unwrap_or_default();
                        out.push_str(&format!("[{title}]({ENTRY_LINK}{id}{anchor})"));
                    }
                    None => out.push_str(text.unwrap_or(slug)),
                }
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

    /// The one entry these tests know: `plum-tart`, whose id is `01a1-plum`.
    fn known(slug: &str) -> Option<(String, String)> {
        (slug == "plum-tart").then(|| ("01a1-plum".to_string(), "Plum tart".to_string()))
    }

    #[test]
    fn a_reference_becomes_a_link_to_the_entry_but_not_in_code() {
        assert_eq!(
            with_entry_links(
                "See [[plum-tart]] and `[[not-this]]`.\n```\n[[nor-this]]\n```\n",
                known
            ),
            "See [Plum tart](hippocampe://01a1-plum) and `[[not-this]]`.\n```\n[[nor-this]]\n```\n"
        );
    }

    #[test]
    fn a_reference_waiting_for_its_entry_is_plain_text() {
        assert_eq!(
            with_entry_links("See [[pear-tart]] and [[pear-tart|the pear one]].", known),
            "See pear-tart and the pear one."
        );
    }

    #[test]
    fn a_reference_may_name_its_text_and_a_heading() {
        assert_eq!(
            with_entry_links(
                "[[plum-tart|the tart]], [[plum-tart#method]], [[plum-tart#method|how]].",
                known
            ),
            "[the tart](hippocampe://01a1-plum), [Plum tart](hippocampe://01a1-plum#method), \
             [how](hippocampe://01a1-plum#method)."
        );
    }

    #[test]
    fn a_heading_with_spaces_goes_through_the_link_whole() {
        let linked = with_entry_links("[[plum-tart#Late pruning]].", known);
        assert_eq!(
            linked,
            "[Plum tart](hippocampe://01a1-plum#Late%20pruning)."
        );
        assert_eq!(
            intent_of_link("hippocampe://01a1-plum#Late%20pruning"),
            Intent::OpenAt {
                entry: "01a1-plum".into(),
                heading: "Late pruning".into()
            }
        );
    }

    #[test]
    fn a_reference_with_spaces_inside_its_brackets_names_its_slug() {
        assert_eq!(
            with_entry_links("See [[ plum-tart ]].", known),
            "See [Plum tart](hippocampe://01a1-plum)."
        );
    }

    #[test]
    fn a_link_to_a_heading_opens_the_entry_at_it() {
        assert_eq!(
            intent_of_link("hippocampe://plum-tart#method"),
            Intent::OpenAt {
                entry: "plum-tart".into(),
                heading: "method".into()
            }
        );
    }

    #[test]
    fn a_link_opens_an_entry_or_a_web_address() {
        assert_eq!(
            intent_of_link("hippocampe://plum-tart"),
            Intent::Open("plum-tart".into())
        );
        assert_eq!(
            intent_of_link("https://example.org/"),
            Intent::OpenUrl("https://example.org/".into())
        );
    }
}
