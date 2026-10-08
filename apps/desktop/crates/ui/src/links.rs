//! The links of an entry as a list grouped by what they say: the entries its fields name and the
//! links it makes first, then the links that reach it, then the mentions both ways. A group shows
//! its first rows and opens whole on demand, with a filter by title.

use std::collections::HashSet;

use api::{EntryRead, FieldDefinitionKind, Link, TypeDefinition};
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

use crate::entry::{label_of, link_detail, title_of};
use crate::intent::{Intent, OnIntent};
use crate::motion::hoverable;
use crate::parts::{heading, text_button};
use crate::text as words;
use crate::theme::{self, space, text};

/// How many rows a folded group shows.
pub const FOLDED_ROWS: usize = 5;

/// The relation the server gives a `[[slug]]` reference.
const MENTIONS: &str = "mentions";

/// Which way a row goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Way {
    /// A field of the entry names it.
    Field,
    /// The entry links to it.
    Out,
    /// It links to the entry.
    In,
}

/// One row: the entry at the other end, and what the link says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkRow {
    pub way: Way,
    pub title: String,
    /// The slug or id that opens it.
    pub target: String,
    /// The relation or the field, as a label, with the period of a `fulfills`.
    pub said: String,
    /// The note and the dates of the link.
    pub detail: Option<String>,
}

/// A group of rows, by relation or by field; `key` names it for folding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkGroup {
    pub key: String,
    pub label: String,
    /// Which way its links go: a group of links that reach the entry is marked as such.
    pub way: Way,
    pub rows: Vec<LinkRow>,
}

fn row(way: Way, link: &Link) -> LinkRow {
    let mut said = label_of(&link.relation);
    if let Some(period) = &link.period {
        said = format!("{said} · {period}");
    }
    LinkRow {
        way,
        title: link.title.clone(),
        target: link.slug.clone(),
        said,
        detail: link_detail(link),
    }
}

/// The groups of an entry's links, in order: what its fields name, each relation it links by,
/// each relation that reaches it, then the mentions it makes and those it receives. Rows by title.
pub fn link_groups(read: &EntryRead, type_definition: Option<&TypeDefinition>) -> Vec<LinkGroup> {
    let mut groups = Vec::new();
    let named: Vec<LinkRow> = type_definition
        .map(|definition| definition.fields.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|field| field.kind == FieldDefinitionKind::Entry)
        .flat_map(|field| {
            let values = match read.entry.fields.get(&field.name) {
                Some(serde_json::Value::String(id)) => vec![id.clone()],
                Some(serde_json::Value::Array(ids)) => ids
                    .iter()
                    .filter_map(|id| id.as_str().map(str::to_string))
                    .collect(),
                _ => Vec::new(),
            };
            let label = label_of(&field.name);
            values
                .into_iter()
                .filter(|id| id != crate::entry::HIDDEN)
                .map(move |id| LinkRow {
                    way: Way::Field,
                    title: String::new(),
                    target: id,
                    said: label.clone(),
                    detail: None,
                })
                .collect::<Vec<_>>()
        })
        .map(|mut field_row| {
            field_row.title = title_of(&field_row.target, &read.titles, read);
            field_row
        })
        .collect();
    if !named.is_empty() {
        groups.push(LinkGroup {
            key: "fields".into(),
            label: words::NAMED_BY_FIELDS.into(),
            way: Way::Field,
            rows: named,
        });
    }
    let by_relation = |links: &[Link], way: Way, mentions: bool| {
        let mut relations: Vec<&str> = links
            .iter()
            .map(|link| link.relation.as_str())
            .filter(|relation| (*relation == MENTIONS) == mentions)
            .collect();
        relations.sort_unstable();
        relations.dedup();
        relations
            .into_iter()
            .map(|relation| {
                let mut rows: Vec<LinkRow> = links
                    .iter()
                    .filter(|link| link.relation == relation)
                    .map(|link| row(way, link))
                    .collect();
                rows.sort_by(|left, right| left.title.cmp(&right.title));
                let label = match (way, mentions) {
                    (Way::In, true) => words::MENTIONED_BY.to_string(),
                    (_, true) => words::MENTIONS.to_string(),
                    _ => label_of(relation),
                };
                let side = if way == Way::In { "in" } else { "out" };
                LinkGroup {
                    key: format!("{side}-{relation}"),
                    label,
                    way,
                    rows,
                }
            })
            .collect::<Vec<_>>()
    };
    groups.extend(by_relation(&read.links, Way::Out, false));
    groups.extend(by_relation(&read.backlinks, Way::In, false));
    groups.extend(by_relation(&read.links, Way::Out, true));
    groups.extend(by_relation(&read.backlinks, Way::In, true));
    groups
}

/// The rows a group shows: its first ones while folded; open, those whose title holds the filter
/// (case aside). With how many it leaves out.
pub fn shown_rows<'a>(group: &'a LinkGroup, open: bool, filter: &str) -> (Vec<&'a LinkRow>, usize) {
    if !open {
        let shown: Vec<&LinkRow> = group.rows.iter().take(FOLDED_ROWS).collect();
        let left = group.rows.len() - shown.len();
        return (shown, left);
    }
    let wanted = filter.trim().to_lowercase();
    let shown: Vec<&LinkRow> = group
        .rows
        .iter()
        .filter(|row| wanted.is_empty() || row.title.to_lowercase().contains(&wanted))
        .collect();
    let left = group.rows.len() - shown.len();
    (shown, left)
}

/// What the page keeps of its links between two renders: the groups open whole, and the filter
/// of the open one.
#[derive(Clone, Default)]
pub struct LinksState {
    pub open: HashSet<SharedString>,
    pub filter: Option<Entity<InputState>>,
}

/// The links of an entry, as a list in groups; nothing when it has none.
pub fn section(
    read: &EntryRead,
    type_definition: Option<&TypeDefinition>,
    state: &LinksState,
    on_intent: &OnIntent,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let groups = link_groups(read, type_definition);
    let count: usize = groups.iter().map(|group| group.rows.len()).sum();
    if count == 0 {
        return None;
    }
    let filter_text = state
        .filter
        .as_ref()
        .map(|filter| filter.read(cx).value().to_string())
        .unwrap_or_default();
    let blocks: Vec<AnyElement> = groups
        .iter()
        .map(|group| {
            let open = state.open.contains(group.key.as_str());
            block(
                group,
                open,
                state.filter.as_ref(),
                &filter_text,
                on_intent,
                window,
                cx,
            )
        })
        .collect();
    Some(
        v_flex()
            .child(heading(words::LINKS, Some(count), cx))
            .child(v_flex().gap(space::L).children(blocks))
            .into_any_element(),
    )
}

/// One group: its label and count, its rows, and what opens or folds it.
fn block(
    group: &LinkGroup,
    open: bool,
    filter: Option<&Entity<InputState>>,
    filter_text: &str,
    on_intent: &OnIntent,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let (shown, left) = shown_rows(group, open, filter_text);
    let theme = cx.theme();
    let border = theme.border;
    let key: SharedString = group.key.clone().into();
    let toggle = {
        let on_intent = on_intent.clone();
        let key = key.clone();
        move |_: &gpui_kit::ClickEvent, window: &mut Window, cx: &mut App| {
            on_intent(Intent::ToggleLinks(key.clone()), window, cx)
        }
    };
    let foldable = group.rows.len() > FOLDED_ROWS;
    let header = h_flex()
        .gap(space::S)
        .pb(space::XS)
        .border_b_1()
        .border_color(border)
        .children((group.way == Way::In).then(|| {
            Icon::new(IconName::ArrowLeft)
                .xsmall()
                .text_color(theme.muted_foreground)
        }))
        .child(
            div()
                .text_size(text::SMALL)
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .child(group.label.clone()),
        )
        .child(
            div()
                .text_size(text::SMALL)
                .text_color(theme::faint(cx))
                .child(group.rows.len().to_string()),
        )
        .child(div().flex_1())
        .children(foldable.then(|| {
            text_button(
                SharedString::from(format!("links-toggle-{}", group.key)),
                if open {
                    words::FOLD.to_string()
                } else {
                    words::show_all(group.rows.len())
                },
                toggle,
                window,
                cx,
            )
        }));
    let rows: Vec<AnyElement> = shown
        .into_iter()
        .map(|link| row_element(&group.key, link, on_intent, window, cx))
        .collect();
    v_flex()
        .debug_selector({
            let key = group.key.clone();
            move || format!("links-{key}")
        })
        .child(header)
        .children(
            (open && foldable)
                .then_some(filter)
                .flatten()
                .map(|filter| {
                    div().py(space::S).child(
                        Input::new(filter)
                            .small()
                            .prefix(Icon::new(IconName::ListFilter).xsmall()),
                    )
                }),
        )
        .children(rows)
        .children((open && left > 0).then(|| {
            div()
                .pt(space::XS)
                .text_size(text::SMALL)
                .text_color(theme::faint(cx))
                .child(words::filtered_out(left))
        }))
        .into_any_element()
}

/// One link in a line: which way, the entry, what the link says.
fn row_element(
    group: &str,
    link: &LinkRow,
    on_intent: &OnIntent,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = cx.theme();
    let (muted, foreground, over, radius) = (
        theme.muted_foreground,
        theme.foreground,
        theme.accent,
        theme.radius,
    );
    let faint = theme::faint(cx);
    let icon = match link.way {
        Way::Field => IconName::Link,
        Way::Out => IconName::ArrowRight,
        Way::In => IconName::ArrowLeft,
    };
    let open = {
        let on_intent = on_intent.clone();
        let target: SharedString = link.target.clone().into();
        move |_: &gpui_kit::ClickEvent, window: &mut Window, cx: &mut App| {
            on_intent(Intent::Open(target.clone()), window, cx)
        }
    };
    let (title, said, detail) = (link.title.clone(), link.said.clone(), link.detail.clone());
    let selector = format!("link-{group}-{}", link.target);
    hoverable(
        SharedString::from(selector.clone()),
        window,
        cx,
        move |element, hover| {
            element
                .debug_selector(move || selector)
                .h(px(32.))
                .px(space::S)
                .flex()
                .items_center()
                .gap(space::S)
                .rounded(radius)
                .bg(over.opacity(hover.0))
                .cursor_pointer()
                .on_click(open)
                .child(Icon::new(icon).xsmall().text_color(muted))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(foreground)
                        .child(title),
                )
                .children(detail.map(|detail| {
                    div()
                        .max_w(px(260.))
                        .truncate()
                        .text_size(text::SMALL)
                        .text_color(faint)
                        .child(detail)
                }))
                .child(
                    div()
                        .flex_none()
                        .text_size(text::SMALL)
                        .text_color(muted)
                        .child(said),
                )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(relation: &str, title: &str) -> Link {
        Link {
            relation: relation.into(),
            period: None,
            field: None,
            note: None,
            valid_from: None,
            valid_until: None,
            id: title.to_lowercase(),
            slug: title.to_lowercase(),
            title: title.into(),
        }
    }

    fn read(links: Vec<Link>, backlinks: Vec<Link>) -> EntryRead {
        let mut read: EntryRead = serde_json::from_value(serde_json::json!({
            "entry": {
                "id": "e1", "type": "note", "title": "Hub", "slug": "hub", "aliases": [], "tags": [],
                "parent_id": null, "fields": {}, "provenance": {}, "sources": [], "body": "",
                "summary": "", "verified": false, "created": "2026-10-01T00:00:00Z",
                "updated": "2026-10-01T00:00:00Z", "valid_from": null, "valid_until": null,
                "superseded_by": null, "archived_at": null, "archived_reason": null
            },
            "path": [], "references": [], "ancestors": [], "links": [], "media": [],
            "backlinks": [], "titles": {}, "children": [], "hidden_children": 0, "cited_by": []
        }))
        .expect("a read");
        read.links = links;
        read.backlinks = backlinks;
        read
    }

    #[test]
    fn links_are_grouped_by_relation_their_own_first_then_reaching_then_mentions() {
        let groups = link_groups(
            &read(
                vec![
                    link("mentions", "Zeta"),
                    link("works_at", "Lamp shop"),
                    link("mentions", "Alpha"),
                ],
                vec![link("signed_by", "Lease"), link("mentions", "Diary")],
            ),
            None,
        );
        let labels: Vec<&str> = groups.iter().map(|group| group.label.as_str()).collect();
        assert_eq!(
            labels,
            ["Works at", "Signed by", "Mentions", "Mentioned by"]
        );
        let ways: Vec<Way> = groups.iter().map(|group| group.way).collect();
        assert_eq!(ways, [Way::Out, Way::In, Way::Out, Way::In]);
        let mentioned: Vec<&str> = groups[2]
            .rows
            .iter()
            .map(|row| row.title.as_str())
            .collect();
        assert_eq!(mentioned, ["Alpha", "Zeta"]);
    }

    #[test]
    fn a_group_folded_shows_its_first_rows_and_open_filters_by_title() {
        let many = (1..=160)
            .map(|n| link("mentions", &format!("Page {n:03}")))
            .collect();
        let groups = link_groups(&read(many, vec![]), None);
        let (folded, left) = shown_rows(&groups[0], false, "");
        assert_eq!((folded.len(), left), (FOLDED_ROWS, 155));
        let (open, none) = shown_rows(&groups[0], true, "");
        assert_eq!((open.len(), none), (160, 0));
        let (matching, rest) = shown_rows(&groups[0], true, "page 15");
        // Pages 150 to 159.
        assert_eq!((matching.len(), rest), (10, 150));
    }
}
