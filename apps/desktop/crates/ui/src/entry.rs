//! The open entry: where it sits, what it is, its fields, its body, and what it is tied to; and
//! beside it, the contents of the page, which follow the reading and jump to a section.

use std::collections::HashMap;
use std::f32::consts::FRAC_PI_2;
use std::time::{Duration, Instant};

use api::{
    Child, EntryProvenanceValue, EntryRead, EntryReadAncestorsItem, FieldDefinitionKind,
    HistoryEvent, Link, LinkProvenance, Medium, Source, TypeDefinition,
};
use gpui_kit::assets::IconName;
use gpui_kit::component::text::TextView;
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnimationExt as _, AnyElement, App, Div, ElementId, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement as _, Pixels, RenderOnce, ScrollHandle, SharedString,
    SpringAnimation, StatefulInteractiveElement as _, Styled as _, Window, div, ease_out_quint,
    point, px, radians,
};
use serde_json::Value;

use crate::intent::{FollowLink, Intent, ListFilter, OnIntent, with_entry_links};
use crate::links::LinksState;
use crate::load::Load;
use crate::motion::{SPRING, hoverable, reveal};
use crate::parts::{
    Card, card, cards, chip, heading, layout, lead, mix, page, plain_card, supposed_mark,
    text_button, title,
};
use crate::status;
use crate::text as words;
use crate::theme::{self, font, space, text, width};

/// What the server shows in place of a value the key may not see.
pub const HIDDEN: &str = "[hidden]";

/// An entry as the screen shows it: the entry as read, and its type, for the kinds of its fields.
#[derive(Clone, Debug)]
pub struct EntryData {
    pub read: EntryRead,
    pub type_definition: Option<TypeDefinition>,
    /// Its history, newest first, once asked for (`Empty` until then).
    pub history: Load<Vec<HistoryEvent>>,
    /// Whether older events wait on the server.
    pub more_history: bool,
}

/// The screen of one entry, in any state. `shown` counts what the pane has shown: a new value
/// plays the page's entrance again.
#[derive(IntoElement)]
pub struct EntryScreen {
    load: Load<EntryData>,
    on_intent: OnIntent,
    scroll: ScrollHandle,
    shown: usize,
    jump: Option<SharedString>,
    links: LinksState,
}

impl EntryScreen {
    /// The screen; `jump` names a heading of the body to glide to once the page is laid out.
    pub fn new(
        load: Load<EntryData>,
        on_intent: OnIntent,
        scroll: ScrollHandle,
        shown: usize,
        jump: Option<SharedString>,
    ) -> Self {
        Self {
            load,
            on_intent,
            scroll,
            shown,
            jump,
            links: LinksState::default(),
        }
    }

    /// Which groups of links are open whole, and the filter of the open one.
    pub fn with_links(mut self, links: LinksState) -> Self {
        self.links = links;
        self
    }
}

impl RenderOnce for EntryScreen {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let article = match self.load {
            Load::Loading => page().child(status::loading(6)).into_any_element(),
            Load::Empty => page()
                .child(status::empty(
                    IconName::FileText,
                    words::NO_ENTRY_OPEN,
                    words::NO_ENTRY_OPEN_DETAIL,
                    cx,
                ))
                .into_any_element(),
            Load::Failed(problem) => page()
                .child(status::failed(
                    "entry-retry",
                    &problem,
                    self.on_intent,
                    window,
                    cx,
                ))
                .into_any_element(),
            Load::Ready(data) => {
                let place = Place {
                    scroll: &self.scroll,
                    shown: self.shown,
                    jump: self.jump,
                };
                return ready(data, &self.links, &self.on_intent, place, window, cx);
            }
        };
        layout(window, &self.scroll, self.shown, article, None).into_any_element()
    }
}

/// Opens an entry when called.
fn opener(
    on_intent: &OnIntent,
    target: impl Into<SharedString>,
) -> impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut App) + 'static {
    let on_intent = on_intent.clone();
    let target = target.into();
    move |_, window, cx| on_intent(Intent::Open(target.clone()), window, cx)
}

/// The words of the mark of what the entry says under `name`, a field, `body` or `summary`: a
/// writer only supposed it, or sources disagree. What is known, and what was written before
/// writers were asked, carries none.
pub(crate) fn mark_of(read: &EntryRead, name: &str) -> Option<&'static str> {
    match read.entry.provenance.get(name) {
        Some(EntryProvenanceValue::Inferred) => Some(words::SUPPOSED),
        Some(EntryProvenanceValue::Ambiguous) => Some(words::DISPUTED),
        _ => None,
    }
}

/// The words of the mark of a link, by the same rule.
pub(crate) fn link_mark(link: &Link) -> Option<&'static str> {
    match link.provenance {
        LinkProvenance::Inferred => Some(words::SUPPOSED),
        LinkProvenance::Ambiguous => Some(words::DISPUTED),
        _ => None,
    }
}

/// Whether the entry holds anything not known: a value, its texts, or a link it makes.
fn holds_supposed(read: &EntryRead) -> bool {
    read.entry
        .provenance
        .keys()
        .any(|name| mark_of(read, name).is_some())
        || read.links.iter().any(|link| link_mark(link).is_some())
}

/// A chip that lists the entries it names: of that type, with that tag, holding supposed values.
fn lister(
    id: impl Into<SharedString>,
    chip: gpui_kit::Div,
    filter: ListFilter,
    on_intent: &OnIntent,
) -> AnyElement {
    let on_intent = on_intent.clone();
    let id = id.into();
    chip.id(ElementId::Name(id.clone()))
        .debug_selector(move || id.to_string())
        .cursor_pointer()
        .on_click(move |_, window, cx| on_intent(Intent::List(filter.clone()), window, cx))
        .into_any_element()
}

/// Opens a web address when called.
fn browser(
    on_intent: &OnIntent,
    url: impl Into<SharedString>,
) -> impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut App) + 'static {
    let on_intent = on_intent.clone();
    let url = url.into();
    move |_, window, cx| on_intent(Intent::OpenUrl(url.clone()), window, cx)
}

/// A place of the page the contents lead to.
struct Anchor {
    label: SharedString,
    /// 2 for a section, 3 for a part of one.
    level: u8,
}

/// The page, built from top to bottom; the parts the contents lead to are marked.
#[derive(Default)]
struct Article {
    children: Vec<AnyElement>,
    anchors: Vec<(usize, Anchor)>,
}

impl Article {
    fn push(&mut self, child: impl IntoElement) {
        self.children.push(child.into_any_element());
    }

    fn anchored(&mut self, label: impl Into<SharedString>, level: u8, child: impl IntoElement) {
        self.anchors.push((
            self.children.len(),
            Anchor {
                label: label.into(),
                level,
            },
        ));
        self.push(child);
    }
}

/// Where the page stands: its scroll, how many pages the pane has shown, the heading to glide to.
struct Place<'a> {
    scroll: &'a ScrollHandle,
    shown: usize,
    jump: Option<SharedString>,
}

fn ready(
    data: EntryData,
    links: &LinksState,
    on_intent: &OnIntent,
    place: Place,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let Place {
        scroll,
        shown,
        jump,
    } = place;
    let EntryData {
        read,
        type_definition,
        history,
        more_history,
    } = data;
    let entry = &read.entry;
    let mut article = Article::default();
    if !read.ancestors.is_empty() {
        article.push(crumbs(&read.ancestors, on_intent, window, cx));
    }
    article.push(title(entry.title.clone()));
    if !entry.summary.is_empty() {
        article.push(lead(entry.summary.clone(), cx));
        if let Some(mark) = mark_of(&read, "summary") {
            article.push(div().mt(space::S).child(supposed_mark(mark, cx)));
        }
    }
    let type_label = type_definition.as_ref().map_or_else(
        || entry.type_.clone(),
        |definition| definition.label.to_string(),
    );
    let border = cx.theme().border;
    article.push(
        h_flex()
            .mt(space::XL)
            .pb(space::XL)
            .gap(space::S)
            .flex_wrap()
            .border_b_1()
            .border_color(border)
            .child(lister(
                "chip-type",
                chip(Some(Icon::new(IconName::FileText)), type_label.clone(), cx),
                ListFilter {
                    type_name: Some((entry.type_.clone().into(), type_label.into())),
                    ..ListFilter::default()
                },
                on_intent,
            ))
            .children(holds_supposed(&read).then(|| {
                lister(
                    "chip-supposed",
                    chip(
                        Some(Icon::new(IconName::CircleAlert)),
                        words::WITH_SUPPOSED,
                        cx,
                    )
                    .text_color(cx.theme().muted_foreground),
                    ListFilter {
                        supposed: true,
                        ..ListFilter::default()
                    },
                    on_intent,
                )
            }))
            .children(entry.tags.iter().map(|tag| {
                lister(
                    SharedString::from(format!("chip-tag-{tag}")),
                    chip(Some(Icon::new(IconName::Tag)), tag.clone(), cx)
                        .text_color(cx.theme().muted_foreground),
                    ListFilter {
                        tag: Some(tag.clone().into()),
                        ..ListFilter::default()
                    },
                    on_intent,
                )
            })),
    );
    if let Some(fields) = fields(&read, type_definition.as_ref(), on_intent, window, cx) {
        article.anchored(words::FIELDS, 2, fields);
    }
    body(&mut article, entry.id.clone(), &entry.body, &read, cx);
    children(
        &mut article,
        &read,
        type_definition.as_ref(),
        on_intent,
        window,
        cx,
    );
    if let Some(section) = crate::links::section(
        &read,
        type_definition.as_ref(),
        links,
        on_intent,
        window,
        cx,
    ) {
        article.anchored(words::LINKS, 2, section);
    }
    sources(&mut article, &entry.sources, on_intent, window, cx);
    media(&mut article, &read.media, cx);
    article.anchored(
        words::HISTORY,
        2,
        history_section(&history, more_history, on_intent, window, cx),
    );
    article.push(
        h_flex()
            .mt(space::XXXL)
            .pt(space::L)
            .justify_between()
            .border_t_1()
            .border_color(border)
            .text_color(cx.theme().muted_foreground)
            .child(words::edited_on(&entry.updated)),
    );

    // Where each marked part sits in the page, measured as it is laid out, so the contents can
    // follow the reading and jump to a part.
    let places = window.use_keyed_state(
        SharedString::from(format!("places-{}", entry.id)),
        cx,
        |_, _| Vec::<Pixels>::new(),
    );
    // The part being read: the page is drawn again when it changes, not at each turn of the wheel.
    let reading = window.use_keyed_state(
        SharedString::from(format!("reading-{}", entry.id)),
        cx,
        |_, _| None::<usize>,
    );
    let follow = {
        let (places, scroll) = (places.clone(), scroll.clone());
        move |_: &mut Window, cx: &mut App| {
            let now = reading_at(places.read(cx), &scroll);
            reading.update(cx, |reading, cx| {
                if *reading != now {
                    *reading = now;
                    cx.notify();
                }
            });
        }
    };
    let marked: Vec<usize> = article.anchors.iter().map(|(index, _)| *index).collect();
    let viewport = scroll.clone();
    let known = places.read(cx).clone();
    // Once laid out, the page glides to the heading a reference named, once.
    if let Some(heading) = jump
        && let Some(index) = article
            .anchors
            .iter()
            .position(|(_, anchor)| anchor_of(&anchor.label) == anchor_of(&heading))
        && let Some(place) = known.get(index).copied()
    {
        let jumped = window.use_keyed_state(
            SharedString::from(format!("jumped-{}-{shown}", entry.id)),
            cx,
            |_, _| false,
        );
        if !*jumped.read(cx) {
            jumped.update(cx, |jumped, _| *jumped = true);
            let scroll = scroll.clone();
            window.defer(cx, move |window, cx| {
                glide(scroll, place - space::L, window, cx)
            });
        }
    }
    let page = page()
        .on_children_prepainted(move |bounds, _, cx| {
            let origin = viewport.bounds().top() + viewport.offset().y;
            let found: Vec<Pixels> = marked
                .iter()
                .filter_map(|index| bounds.get(*index))
                .map(|bounds| bounds.top() - origin)
                .collect();
            places.update(cx, |places, cx| {
                if *places != found {
                    *places = found;
                    cx.notify();
                }
            });
        })
        .children(article.children);
    let contents = contents(&article.anchors, &known, scroll, &read, window, cx);
    layout(
        window,
        scroll,
        shown,
        page,
        Some((contents, Box::new(follow))),
    )
    .into_any_element()
}

/// A heading as a reference names it: `## Late pruning` as `late-pruning`.
fn anchor_of(heading: &str) -> String {
    heading
        .to_lowercase()
        .split(|letter: char| !letter.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Where the entry sits: each ancestor opens, by its id; one the key may not see stays still.
fn crumbs(
    ancestors: &[EntryReadAncestorsItem],
    on_intent: &OnIntent,
    window: &mut Window,
    cx: &mut App,
) -> Div {
    let theme = cx.theme();
    let (muted, foreground) = (theme.muted_foreground, theme.foreground);
    let mut row = h_flex()
        .gap(space::XS)
        .text_size(text::SMALL)
        .text_color(muted);
    for (depth, ancestor) in ancestors.iter().enumerate() {
        if depth > 0 {
            row = row.child(Icon::new(IconName::ChevronRight).xsmall());
        }
        let title = ancestor.title.clone();
        let Some(id) = ancestor.id.clone() else {
            row = row.child(div().child(title));
            continue;
        };
        let open = opener(on_intent, id);
        row = row.child(hoverable(
            ElementId::named_usize("crumb", depth),
            window,
            cx,
            move |element, hover| {
                element
                    .text_color(mix(muted, foreground, hover.0))
                    .cursor_pointer()
                    .debug_selector(|| format!("crumb-{depth}"))
                    .on_click(open)
                    .child(title)
            },
        ));
    }
    row
}

/// The values of the entry's fields, in the order of its type, each shown by its kind: folded by
/// default under a line that names them, unfolded on a click.
fn fields(
    read: &EntryRead,
    type_definition: Option<&TypeDefinition>,
    on_intent: &OnIntent,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let values = &read.entry.fields;
    if values.is_empty() {
        return None;
    }
    let mut ordered: Vec<(String, Option<FieldDefinitionKind>)> = type_definition
        .map(|definition| {
            definition
                .fields
                .iter()
                .filter(|field| values.contains_key(&field.name))
                .map(|field| (field.name.clone(), Some(field.kind)))
                .collect()
        })
        .unwrap_or_default();
    let rest: Vec<(String, Option<FieldDefinitionKind>)> = values
        .keys()
        .filter(|name| !ordered.iter().any(|(known, _)| known == *name))
        .map(|name| (name.clone(), None))
        .collect();
    ordered.extend(rest);
    let id = read.entry.id.clone();
    let open_state = window.use_keyed_state(
        SharedString::from(format!("fields-open-{id}")),
        cx,
        |_, _| false,
    );
    let open = *open_state.read(cx);
    let count = ordered.len();
    let mut hint = ordered
        .iter()
        .take(4)
        .map(|(name, _)| label_of(name))
        .collect::<Vec<_>>()
        .join(", ");
    if count > 4 {
        hint.push('…');
    }
    let theme = cx.theme();
    let (card_bg, over, border, soft, muted, radius) = (
        theme.secondary,
        theme.accent,
        theme.border,
        theme.table_row_border,
        theme.muted_foreground,
        theme.radius_lg,
    );
    let faint = theme::faint(cx);
    let rows =
        v_flex()
            .border_t_1()
            .border_color(soft)
            .children(
                ordered
                    .into_iter()
                    .enumerate()
                    .map(|(index, (name, kind))| {
                        h_flex()
                            .items_start()
                            .gap(space::L)
                            .px(space::L)
                            .py(px(11.))
                            .when(index + 1 < count, |row| row.border_b_1().border_color(soft))
                            .child(
                                div()
                                    .w(width::LABEL)
                                    .flex_none()
                                    .text_color(muted)
                                    .child(label_of(&name)),
                            )
                            .child(div().flex_1().min_w_0().child(value_of(
                                &values[&name],
                                kind,
                                &Shown {
                                    scope: format!("field-{name}"),
                                    table: false,
                                    titles: &read.titles,
                                    read,
                                },
                                on_intent,
                                cx,
                            )))
                            .children(mark_of(read, &name).map(|mark| supposed_mark(mark, cx)))
                    }),
            );
    let chevron = Icon::new(IconName::ChevronRight)
        .xsmall()
        .text_color(muted)
        .with_spring(
            SharedString::from(format!("fields-chevron-{id}")),
            SpringAnimation::new(SPRING).to(open),
            |icon, turn| icon.rotate(radians(turn.0 * FRAC_PI_2)),
        );
    let hint = div()
        .flex_1()
        .min_w_0()
        .truncate()
        .text_size(text::SMALL)
        .font_weight(FontWeight::NORMAL)
        .text_color(faint)
        .child(hint)
        .with_spring(
            SharedString::from(format!("fields-hint-{id}")),
            SpringAnimation::new(SPRING).to(!open),
            |hint, shown| hint.opacity(shown.0.clamp(0., 1.)),
        );
    let header = hoverable(
        SharedString::from(format!("fields-header-{id}")),
        window,
        cx,
        move |element, hover| {
            element
                .flex()
                .items_center()
                .gap(space::S)
                .px(space::L)
                .py(space::M)
                .rounded(radius)
                .bg(mix(card_bg, over, hover.0))
                .font_weight(FontWeight::MEDIUM)
                .cursor_pointer()
                .debug_selector(|| "fields-header".into())
                .on_click(move |_, _, cx| {
                    open_state.update(cx, |open, cx| {
                        *open = !*open;
                        cx.notify();
                    })
                })
                .child(chevron)
                .child(words::FIELDS)
                .child(
                    div()
                        .text_size(text::SMALL)
                        .font_weight(FontWeight::NORMAL)
                        .text_color(faint)
                        .child(count.to_string()),
                )
                .child(hint)
        },
    );
    Some(
        v_flex()
            .mt(space::XL)
            .rounded(radius)
            .border_1()
            .border_color(border)
            .bg(card_bg)
            .child(header)
            .child(reveal(
                SharedString::from(format!("fields-body-{id}")),
                open,
                rows,
            ))
            .into_any_element(),
    )
}

/// A field name as a label: `monthly_cost` as `Monthly cost`.
pub fn label_of(name: &str) -> String {
    let spaced = name.replace('_', " ");
    let mut letters = spaced.chars();
    letters
        .next()
        .map(|first| first.to_uppercase().chain(letters).collect())
        .unwrap_or_default()
}

/// Text that opens something, underlined in the accent.
fn reference(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    div()
        .id(id.into())
        .font_weight(FontWeight::MEDIUM)
        .underline()
        .text_decoration_1()
        .text_decoration_color(cx.theme().primary)
        .cursor_pointer()
        .on_click(on_click)
        .child(label.into())
        .into_any_element()
}

/// Where a value is shown: the scope its elements are named in, and the titles of the entries it
/// may name, by id.
struct Shown<'a> {
    scope: String,
    /// In a table, where a date reads as `2026-10-07`.
    table: bool,
    titles: &'a HashMap<String, String>,
    read: &'a EntryRead,
}

/// The title of the entry an id names: as the server gave it with the value, else as a link of
/// the entry names it, else the id itself.
pub fn title_of(id: &str, titles: &HashMap<String, String>, read: &EntryRead) -> String {
    titles.get(id).cloned().unwrap_or_else(|| {
        read.links
            .iter()
            .chain(&read.backlinks)
            .find(|link| link.id == id || link.slug == id)
            .map_or_else(|| id.to_string(), |link| link.title.clone())
    })
}

/// A value as its kind reads best: a hidden value as hidden, dates in words, links that open; a
/// list as its values in their order, each by its kind (each entry a link to it).
fn value_of(
    value: &Value,
    kind: Option<FieldDefinitionKind>,
    shown: &Shown,
    on_intent: &OnIntent,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    if value.as_str() == Some(HIDDEN) {
        return h_flex()
            .gap(px(6.))
            .text_color(theme::faint(cx))
            .child(Icon::new(IconName::EyeOff).xsmall())
            .child("••••••")
            .child(words::HIDDEN_VALUE)
            .into_any_element();
    }
    if let Value::Array(items) = value {
        let last = items.len().saturating_sub(1);
        // Labels stand apart by themselves; any other value is followed by a comma.
        let comma = kind != Some(FieldDefinitionKind::Enum);
        return h_flex()
            .flex_wrap()
            .gap_x(px(6.))
            .gap_y(px(4.))
            .children(items.iter().enumerate().map(|(index, item)| {
                let one = value_of(
                    item,
                    kind,
                    &Shown {
                        scope: format!("{}-{index}", shown.scope),
                        table: shown.table,
                        titles: shown.titles,
                        read: shown.read,
                    },
                    on_intent,
                    cx,
                );
                if comma && index < last {
                    h_flex().child(one).child(",").into_any_element()
                } else {
                    one
                }
            }))
            .into_any_element();
    }
    let text_value = match value {
        Value::String(text) => text.clone(),
        Value::Bool(true) => words::YES.into(),
        Value::Bool(false) => words::NO.into(),
        other => other.to_string(),
    };
    match kind {
        Some(FieldDefinitionKind::Date) if shown.table => {
            words::date_in_table(&text_value).into_any_element()
        }
        Some(FieldDefinitionKind::Date) => words::date_in_words(&text_value).into_any_element(),
        Some(FieldDefinitionKind::Money) => text_value.into_any_element(),
        Some(FieldDefinitionKind::Enum) => h_flex()
            .child(
                div()
                    .h(px(22.))
                    .px(space::S)
                    .flex()
                    .items_center()
                    .rounded_full()
                    .bg(theme::accent_tint(cx))
                    .text_color(theme.primary)
                    .text_size(text::XS)
                    .font_weight(FontWeight::MEDIUM)
                    .child(text_value),
            )
            .into_any_element(),
        Some(FieldDefinitionKind::Url) => h_flex()
            .child(reference(
                SharedString::from(format!("{}-url-{text_value}", shown.scope)),
                without_scheme(&text_value),
                browser(on_intent, text_value.clone()),
                cx,
            ))
            .into_any_element(),
        Some(FieldDefinitionKind::Entry) => {
            let title = title_of(&text_value, shown.titles, shown.read);
            let selector = format!("{}-entry", shown.scope);
            h_flex()
                .debug_selector(|| selector)
                .child(reference(
                    SharedString::from(format!("{}-entry-{text_value}", shown.scope)),
                    title,
                    opener(on_intent, text_value),
                    cx,
                ))
                .into_any_element()
        }
        _ => text_value.into_any_element(),
    }
}

fn without_scheme(url: &str) -> String {
    url.trim_start_matches("https://")
        .trim_start_matches("http://")
        .to_string()
}

/// A body cut at its headings (`#`, `##` and `###`, outside code): each part, after its heading
/// when it has one, so the contents can lead to it.
pub fn parts_of(body: &str) -> Vec<(Option<(u8, String)>, String)> {
    let mut parts = vec![(None, String::new())];
    let mut fenced = false;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
        }
        let heading = (!fenced)
            .then(|| {
                let hashes = trimmed.chars().take_while(|c| *c == '#').count();
                let rest = &trimmed[hashes..];
                ((1..=3).contains(&hashes) && rest.starts_with(' '))
                    .then(|| (if hashes == 3 { 3 } else { 2 }, rest.trim().to_string()))
            })
            .flatten();
        match heading {
            Some(heading) => parts.push((Some(heading), String::new())),
            None => parts.last_mut().expect("there is a part").1.push_str(line),
        }
    }
    parts.retain(|(heading, text)| heading.is_some() || !text.trim().is_empty());
    parts
}

/// The body, from Markdown, part by part, with `[[slug]]` references as links that open the
/// entry, titled when the entry is among its links.
fn body(article: &mut Article, id: String, body: &str, read: &EntryRead, cx: &App) {
    if let Some(mark) = mark_of(read, "body").filter(|_| !body.is_empty()) {
        article.push(div().mt(space::XL).child(supposed_mark(mark, cx)));
    }
    // What the server says each reference names: an alias as well as a slug; nothing yet for a
    // reference that waits for its entry.
    let titled = with_entry_links(body, |reference| {
        read.references
            .iter()
            .find(|known| known.reference == reference)
            .and_then(|known| Some((known.id.clone()?, known.title.clone()?)))
    });
    for (index, (title_of_part, text)) in parts_of(&titled).into_iter().enumerate() {
        let prose = (!text.trim().is_empty()).then(|| {
            TextView::markdown(SharedString::from(format!("body-{id}-{index}")), text)
                .selectable(true)
                .text_size(text::PROSE)
                .on_link_click(|url, _, window, cx| {
                    window.dispatch_action(Box::new(FollowLink { url: url.clone() }), cx);
                })
        });
        match title_of_part {
            Some((level, label)) => {
                let title = if level == 2 {
                    heading(label.clone(), None, cx)
                } else {
                    div()
                        .mt(space::XXL)
                        .mb(space::M)
                        .font_family(font::HEADING)
                        .text_size(text::SUBHEADING)
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(label.clone())
                };
                article.anchored(label, level, v_flex().child(title).children(prose));
            }
            None => article.push(div().mt(space::XL).children(prose)),
        }
    }
}

/// The entries filed under this one: its parts as a table of their fields, the others as cards,
/// and those the key may not see as one quiet card.
fn children(
    article: &mut Article,
    read: &EntryRead,
    type_definition: Option<&TypeDefinition>,
    on_intent: &OnIntent,
    window: &mut Window,
    cx: &mut App,
) {
    let hidden = read.hidden_children.max(0) as usize;
    if read.children.is_empty() && hidden == 0 {
        return;
    }
    let (parts, others): (Vec<&Child>, Vec<&Child>) =
        read.children.iter().partition(|child| child.in_parent);
    let mut list: Vec<AnyElement> = others
        .iter()
        .map(|child| {
            card(
                SharedString::from(format!("child-{}", child.id)),
                Card {
                    icon: Icon::new(IconName::FileText),
                    title: child.title.clone().into(),
                    detail: (!child.summary.is_empty()).then(|| child.summary.clone().into()),
                    relation: Some(child.type_.clone().into()),
                },
                opener(on_intent, child.slug.clone()),
                window,
                cx,
            )
        })
        .collect();
    if hidden > 0 {
        list.push(
            plain_card(
                Card {
                    icon: Icon::new(IconName::EyeOff),
                    title: words::hidden_entries(hidden).into(),
                    detail: Some(words::HIDDEN_DETAIL.into()),
                    relation: None,
                },
                true,
                cx,
            )
            .into_any_element(),
        );
    }
    let table = (!parts.is_empty())
        .then(|| parts_table(&parts, read, type_definition, on_intent, window, cx));
    article.anchored(
        words::CONTAINS,
        2,
        v_flex()
            .child(heading(
                words::CONTAINS,
                Some(read.children.len() + hidden),
                cx,
            ))
            .children(table)
            .when(!list.is_empty(), |section| section.child(cards(list))),
    );
}

/// The parts of the entry as a table: a row each, which opens it, its title, then a column for
/// each field of the type that one of them fills, in the order of the type, each value shown as on
/// the part's own page.
fn parts_table(
    parts: &[&Child],
    read: &EntryRead,
    type_definition: Option<&TypeDefinition>,
    on_intent: &OnIntent,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let filled = |name: &String| parts.iter().any(|part| part.fields.contains_key(name));
    let mut columns: Vec<(String, Option<FieldDefinitionKind>)> = type_definition
        .map(|definition| {
            definition
                .fields
                .iter()
                .filter(|field| filled(&field.name))
                .map(|field| (field.name.clone(), Some(field.kind)))
                .collect()
        })
        .unwrap_or_default();
    let mut rest: Vec<String> = parts
        .iter()
        .flat_map(|part| part.fields.keys())
        .filter(|name| !columns.iter().any(|(known, _)| known == *name))
        .cloned()
        .collect();
    rest.sort();
    rest.dedup();
    columns.extend(rest.into_iter().map(|name| (name, None)));

    let theme = cx.theme();
    let (card_bg, over, border, soft, muted, radius) = (
        theme.secondary,
        theme.accent,
        theme.border,
        theme.table_row_border,
        theme.muted_foreground,
        theme.radius_lg,
    );
    let primary = theme.primary;
    let cell = || div().flex_1().min_w_0();
    let header = h_flex()
        .gap(space::L)
        .px(space::L)
        .py(space::S)
        .border_b_1()
        .border_color(soft)
        .text_size(text::SMALL)
        .text_color(muted)
        .child(cell().child(words::NAME))
        .children(
            columns
                .iter()
                .map(|(name, _)| cell().truncate().child(label_of(name))),
        );
    let count = parts.len();
    let rows = parts.iter().enumerate().map(|(index, part)| {
        let values: Vec<AnyElement> = columns
            .iter()
            .map(|(name, kind)| {
                cell()
                    .child(part.fields.get(name).map_or_else(
                        || {
                            div()
                                .text_color(theme::faint(cx))
                                .child("—")
                                .into_any_element()
                        },
                        |value| {
                            // An entry a part names: by the title the server gave with the part.
                            value_of(
                                value,
                                *kind,
                                &Shown {
                                    scope: format!("part-{}-{name}", part.id),
                                    table: true,
                                    titles: &part.titles,
                                    read,
                                },
                                on_intent,
                                cx,
                            )
                        },
                    ))
                    .into_any_element()
            })
            .collect();
        let title = part.title.clone();
        let open = opener(on_intent, part.slug.clone());
        let selector = format!("part-{}", part.slug);
        hoverable(
            SharedString::from(format!("part-{}", part.id)),
            window,
            cx,
            move |element, hover| {
                element
                    .flex()
                    .items_start()
                    .gap(space::L)
                    .px(space::L)
                    .py(px(11.))
                    .when(index + 1 < count, |row| row.border_b_1().border_color(soft))
                    .bg(mix(card_bg, over, hover.0))
                    .cursor_pointer()
                    .debug_selector(|| selector)
                    .on_click(open)
                    .child(
                        cell()
                            .font_weight(FontWeight::MEDIUM)
                            .underline()
                            .text_decoration_1()
                            .text_decoration_color(primary)
                            .child(title),
                    )
                    .children(values)
            },
        )
    });
    v_flex()
        .mt(space::M)
        .mb(space::M)
        .rounded(radius)
        .border_1()
        .border_color(border)
        .bg(card_bg)
        .overflow_hidden()
        .child(header)
        .children(rows)
        .into_any_element()
}

/// What a link says of itself, in a line: its note, then the dates it held between, such as
/// `accountant · since 1 January 2024`; nothing when it says nothing.
pub fn link_detail(link: &Link) -> Option<String> {
    let dates = words::held(link.valid_from.as_deref(), link.valid_until.as_deref());
    let said: Vec<String> = link.note.iter().cloned().chain(dates).collect();
    (!said.is_empty()).then(|| said.join(" · "))
}

/// The history of the entry, newest first: asked for, since it costs a read of its own.
fn history_section(
    history: &Load<Vec<HistoryEvent>>,
    more: bool,
    on_intent: &OnIntent,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let ask = {
        let on_intent = on_intent.clone();
        move |_: &gpui_kit::ClickEvent, window: &mut Window, cx: &mut App| {
            on_intent(Intent::History, window, cx)
        }
    };
    let body = match history {
        Load::Empty => text_button("history-show", words::SHOW_HISTORY, ask, window, cx),
        Load::Loading => status::loading(3).into_any_element(),
        Load::Failed(problem) => {
            status::failed("history-retry", problem, on_intent.clone(), window, cx)
                .into_any_element()
        }
        Load::Ready(events) => {
            let theme = cx.theme();
            let (border, muted) = (theme.border, theme.muted_foreground);
            let faint = theme::faint(cx);
            v_flex()
                .children(events.iter().map(|event| {
                    let shown: Vec<(String, String, String)> = event
                        .changes
                        .iter()
                        .take(HISTORY_CHANGES)
                        .map(|change| {
                            (
                                format!("{}:", field_label(&change.field)),
                                value_text(&change.before),
                                value_text(&change.after),
                            )
                        })
                        .collect();
                    let hidden = event.changes.len().saturating_sub(HISTORY_CHANGES);
                    v_flex()
                        .debug_selector({
                            let id = event.id.clone();
                            move || format!("history-{id}")
                        })
                        .py(space::S)
                        .border_b_1()
                        .border_color(border)
                        .gap(px(2.))
                        .child(
                            h_flex()
                                .gap(space::S)
                                .child(
                                    div()
                                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                                        .child(words::action(&event.action)),
                                )
                                .child(
                                    div()
                                        .text_size(text::SMALL)
                                        .text_color(muted)
                                        .child(words::by_on(&event.actor, &event.at)),
                                ),
                        )
                        .children(shown.into_iter().map(|(field, before, after)| {
                            h_flex()
                                .gap(px(6.))
                                .min_w_0()
                                .text_size(text::SMALL)
                                .text_color(muted)
                                .child(div().flex_none().child(field))
                                .child(div().min_w_0().truncate().child(before))
                                .child(Icon::new(IconName::ArrowRight).xsmall().text_color(faint))
                                .child(div().min_w_0().truncate().child(after))
                        }))
                        .children((hidden > 0).then(|| {
                            div()
                                .text_size(text::SMALL)
                                .text_color(faint)
                                .child(words::more_changes(hidden))
                        }))
                }))
                .children(more.then(|| {
                    div().pt(space::S).child(text_button(
                        "history-older",
                        words::OLDER,
                        ask,
                        window,
                        cx,
                    ))
                }))
                .into_any_element()
        }
    };
    v_flex()
        .child(heading(words::HISTORY, None, cx))
        .child(body)
        .into_any_element()
}

/// How many changes of one event the history shows.
const HISTORY_CHANGES: usize = 3;

/// A field of an event as a person reads it: `fields.provider` as `Provider`.
fn field_label(field: &str) -> String {
    let name = field
        .strip_prefix("fields.")
        .or_else(|| field.strip_prefix("links."))
        .unwrap_or(field);
    label_of(name)
}

/// A value of an event in a few words, on one line: text as it is, a long text by its excerpt,
/// nothing as `—`.
fn value_text(value: &Value) -> String {
    let text = match value {
        Value::Null => "—".to_string(),
        Value::String(text) => text.clone(),
        Value::Object(object) => match object.get("excerpt") {
            Some(Value::String(excerpt)) => excerpt.clone(),
            _ => value.to_string(),
        },
        other => other.to_string(),
    };
    // On one line: a body's excerpt keeps its breaks in the history.
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Where the entry comes from.
fn sources(
    article: &mut Article,
    sources: &[Source],
    on_intent: &OnIntent,
    window: &mut Window,
    cx: &mut App,
) {
    if sources.is_empty() {
        return;
    }
    let note = |note: &Option<String>| note.clone().map(SharedString::from);
    let list: Vec<AnyElement> = sources
        .iter()
        .enumerate()
        .map(|(index, source)| {
            let id = SharedString::from(format!("source-{index}"));
            match source {
                Source::Entry(entry) => card(
                    id,
                    Card {
                        icon: Icon::new(IconName::FileText),
                        title: entry.title.clone().into(),
                        detail: note(&entry.note),
                        relation: Some(words::ENTRY.into()),
                    },
                    opener(on_intent, entry.slug.clone()),
                    window,
                    cx,
                ),
                Source::Said(said) if said.said_by == HIDDEN => quiet_source(
                    Card {
                        icon: Icon::new(IconName::User),
                        title: words::HIDDEN_VALUE.into(),
                        detail: Some(words::said_on(&said.on, said.note.as_deref()).into()),
                        relation: Some(words::SAID_BY.into()),
                    },
                    cx,
                ),
                Source::Said(said) => card(
                    id,
                    Card {
                        icon: Icon::new(IconName::User),
                        title: said.title.clone().into(),
                        detail: Some(words::said_on(&said.on, said.note.as_deref()).into()),
                        relation: Some(words::SAID_BY.into()),
                    },
                    opener(on_intent, said.slug.clone()),
                    window,
                    cx,
                ),
                Source::Url(url) => card(
                    id,
                    Card {
                        icon: Icon::new(IconName::Globe),
                        title: without_scheme(&url.url).into(),
                        detail: note(&url.note),
                        relation: Some(words::WEB_ADDRESS.into()),
                    },
                    browser(on_intent, url.url.clone()),
                    window,
                    cx,
                ),
                Source::Identifier(identifier) => quiet_source(
                    Card {
                        icon: Icon::new(IconName::Hash),
                        title: identifier
                            .label
                            .clone()
                            .unwrap_or_else(|| identifier.identifier.clone())
                            .into(),
                        detail: Some(identifier.identifier.clone().into()),
                        relation: Some(words::IDENTIFIER.into()),
                    },
                    cx,
                ),
                Source::Item(item) => quiet_source(
                    Card {
                        icon: Icon::new(IconName::Inbox),
                        title: words::item_of(&item.source).into(),
                        detail: note(&item.note),
                        relation: Some(words::INBOX_ITEM.into()),
                    },
                    cx,
                ),
            }
        })
        .collect();
    article.anchored(
        words::SOURCES,
        2,
        v_flex()
            .child(heading(words::SOURCES, Some(sources.len()), cx))
            .child(cards(list)),
    );
}

/// A source that opens nothing: framed like a card, still.
fn quiet_source(card: Card, cx: &App) -> AnyElement {
    plain_card(card, false, cx).into_any_element()
}

/// The files of the entry, three by row: a preview, what each is, and its size.
fn media(article: &mut Article, media: &[Medium], cx: &App) {
    if media.is_empty() {
        return;
    }
    let theme = cx.theme();
    let faint = theme::faint(cx);
    let tiles = media.iter().map(|medium| {
        let (icon, kind) = if medium.kind == "image" {
            (IconName::Image, words::IMAGE.to_string())
        } else {
            let subtype = medium.mime.rsplit('/').next().unwrap_or(&medium.mime);
            (IconName::FileText, subtype.to_uppercase())
        };
        let size = match (medium.width, medium.height) {
            (Some(width), Some(height)) => format!("{kind} · {width} × {height}"),
            _ => format!("{kind} · {}", words::kilobytes(medium.size)),
        };
        v_flex()
            .rounded(theme.radius_lg)
            .border_1()
            .border_color(theme.border)
            .bg(theme.secondary)
            .overflow_hidden()
            .child(
                div()
                    .h(px(132.))
                    .w_full()
                    .bg(theme.muted)
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(Icon::new(icon).large().text_color(faint)),
            )
            .child(
                v_flex()
                    .p(space::M)
                    .gap(px(2.))
                    .text_size(text::SMALL)
                    .child(div().truncate().child(if medium.alt.is_empty() {
                        words::NO_DESCRIPTION.to_string()
                    } else {
                        medium.alt.clone()
                    }))
                    .child(div().text_size(text::XS).text_color(faint).child(size)),
            )
            .into_any_element()
    });
    article.anchored(
        words::MEDIA,
        2,
        v_flex()
            .child(heading(words::MEDIA, Some(media.len()), cx))
            .child(div().grid().grid_cols(3).gap(space::M).children(tiles)),
    );
}

/// The part being read: the last one whose top has passed under the top of the page, or the last
/// one once the page is scrolled to its end.
fn reading_at(places: &[Pixels], scroll: &ScrollHandle) -> Option<usize> {
    let reading = -scroll.offset().y + px(96.);
    let at_end = scroll.offset().y.abs() >= scroll.max_offset().y.abs() - px(1.)
        && scroll.max_offset().y.abs() > px(0.);
    if at_end {
        places.len().checked_sub(1)
    } else {
        places.iter().rposition(|place| *place <= reading)
    }
    .or((!places.is_empty()).then_some(0))
}

/// The contents of the page: each part, the one being read marked in the accent, a click glides
/// to it; then what the entry is, in a box.
fn contents(
    anchors: &[(usize, Anchor)],
    places: &[Pixels],
    scroll: &ScrollHandle,
    read: &EntryRead,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let current = reading_at(places, scroll);
    let theme = cx.theme();
    let (muted, foreground, accent, tint, over, border, radius) = (
        theme.muted_foreground,
        theme.foreground,
        theme.primary,
        theme::accent_tint(cx),
        theme.accent,
        theme.border,
        theme.radius_lg,
    );
    let items: Vec<AnyElement> = anchors
        .iter()
        .enumerate()
        .map(|(index, (_, anchor))| {
            let active = current == Some(index);
            let place = places.get(index).copied();
            let scroll = scroll.clone();
            let label = anchor.label.clone();
            let indent = if anchor.level == 3 { px(20.) } else { space::S };
            hoverable(
                ElementId::named_usize("contents", index),
                window,
                cx,
                move |element, hover| {
                    let (bg, fg) = if active {
                        (tint, accent)
                    } else {
                        (over.opacity(0.), mix(muted, foreground, hover.0))
                    };
                    element
                        .py(px(5.))
                        .pl(indent)
                        .pr(space::S)
                        .rounded(px(6.))
                        .bg(bg)
                        .text_color(fg)
                        .cursor_pointer()
                        .truncate()
                        .on_click(move |_, window, cx| {
                            if let Some(place) = place {
                                glide(scroll.clone(), place - space::L, window, cx);
                            }
                        })
                        .child(label)
                },
            )
        })
        .collect();
    let entry = &read.entry;
    v_flex()
        .w(width::CONTENTS)
        .flex_none()
        .pt(space::XL)
        .text_size(text::SMALL)
        .children((!items.is_empty()).then(|| {
            v_flex()
                .child(
                    h_flex()
                        .gap(space::S)
                        .mb(space::M)
                        .text_color(muted)
                        .child(Icon::new(IconName::List).xsmall())
                        .child(words::ON_THIS_PAGE),
                )
                .children(items)
        }))
        .child(
            v_flex()
                .mt(space::XL)
                .p(space::M)
                .gap(space::S)
                .rounded(radius)
                .border_1()
                .border_color(border)
                .text_color(muted)
                .child(
                    div()
                        .text_color(foreground)
                        .font_weight(FontWeight::MEDIUM)
                        .child(words::ENTRY),
                )
                .child(words::created_on(&entry.created))
                .child(words::edited_on(&entry.updated)),
        )
        .into_any_element()
}

/// Scrolls the page so that `place` comes to its top, gliding there on the page's curve.
fn glide(scroll: ScrollHandle, place: Pixels, window: &mut Window, cx: &mut App) {
    const LENGTH: Duration = Duration::from_millis(320);
    let from = scroll.offset().y;
    let to = -place.max(px(0.)).min(scroll.max_offset().y.abs());
    let ease = ease_out_quint();
    window
        .spawn(cx, async move |cx| {
            let start = Instant::now();
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(8))
                    .await;
                let progress = (start.elapsed().as_secs_f32() / LENGTH.as_secs_f32()).min(1.);
                scroll.set_offset(point(px(0.), from + (to - from) * ease(progress)));
                if cx.update(|window, _| window.refresh()).is_err() || progress >= 1. {
                    break;
                }
            }
        })
        .detach();
}

#[cfg(test)]
mod tests {
    use super::{holds_supposed, link_detail, mark_of, parts_of};
    use api::{Link, LinkProvenance};

    fn link(note: Option<&str>, from: Option<&str>, until: Option<&str>) -> Link {
        Link {
            relation: "works_at".into(),
            period: None,
            field: None,
            note: note.map(Into::into),
            valid_from: from.map(Into::into),
            valid_until: until.map(Into::into),
            provenance: api::LinkProvenance::Extracted,
            id: "atelier".into(),
            slug: "atelier".into(),
            title: "Atelier".into(),
        }
    }

    #[test]
    fn a_link_says_its_note_and_its_dates_in_one_line() {
        let said = |note, from, until| link_detail(&link(note, from, until));
        assert_eq!(
            said(Some("accountant"), Some("2024-01-01"), None).as_deref(),
            Some("accountant · since 1 January 2024")
        );
        assert_eq!(
            said(None, Some("2024-01-01"), Some("2025-06-30")).as_deref(),
            Some("from 1 January 2024 to 30 June 2025")
        );
        assert_eq!(
            said(Some("processor"), None, Some("2025-06-30")).as_deref(),
            Some("processor · until 30 June 2025")
        );
        assert_eq!(said(None, None, None), None);
    }

    fn read_with(provenance: serde_json::Value, links: Vec<Link>) -> api::EntryRead {
        let mut read: api::EntryRead = serde_json::from_value(serde_json::json!({
            "entry": {
                "id": "e1", "type": "note", "title": "Harbor", "slug": "harbor", "aliases": [],
                "tags": [], "parent_id": null, "fields": { "depth": "9 m", "quay": "north" },
                "provenance": provenance, "sources": [], "body": "Quiet.", "summary": "A harbor.",
                "created": "2026-10-01T00:00:00Z", "updated": "2026-10-01T00:00:00Z",
                "valid_from": null, "valid_until": null, "superseded_by": null,
                "archived_at": null, "archived_reason": null
            },
            "path": [], "references": [], "ancestors": [], "links": [], "media": [],
            "backlinks": [], "titles": {}, "children": [], "hidden_children": 0, "cited_by": []
        }))
        .expect("a read");
        read.links = links;
        read
    }

    #[test]
    fn only_what_a_writer_supposed_is_marked_not_what_is_known_nor_what_was_unstated() {
        let read = read_with(
            serde_json::json!({
                "depth": "inferred", "quay": "extracted", "summary": "unstated",
                "body": "inferred", "tide": "ambiguous"
            }),
            Vec::new(),
        );
        assert_eq!(mark_of(&read, "depth"), Some("Supposed"));
        assert_eq!(mark_of(&read, "quay"), None);
        assert_eq!(mark_of(&read, "summary"), None);
        assert_eq!(mark_of(&read, "body"), Some("Supposed"));
        // Not known either, and said in other words.
        assert_eq!(mark_of(&read, "tide"), Some("Sources disagree"));
        assert_eq!(mark_of(&read, "never_written"), None);
    }

    #[test]
    fn an_entry_holds_suppositions_through_a_value_or_a_link() {
        let known = serde_json::json!({ "depth": "extracted", "summary": "unstated" });
        assert!(!holds_supposed(&read_with(known.clone(), Vec::new())));
        assert!(holds_supposed(&read_with(
            serde_json::json!({ "depth": "inferred" }),
            Vec::new()
        )));
        let mut guessed = link(None, None, None);
        guessed.provenance = LinkProvenance::Inferred;
        assert!(holds_supposed(&read_with(known.clone(), vec![guessed])));
        let mut disputed = link(None, None, None);
        disputed.provenance = LinkProvenance::Ambiguous;
        assert!(holds_supposed(&read_with(known, vec![disputed])));
    }

    #[test]
    fn a_body_is_cut_at_its_headings_but_not_in_code() {
        let parts = parts_of("Intro.\n## First\nText.\n```\n## not this\n```\n### Second\nMore.\n");
        assert_eq!(
            parts,
            vec![
                (None, "Intro.\n".to_string()),
                (
                    Some((2, "First".to_string())),
                    "Text.\n```\n## not this\n```\n".to_string()
                ),
                (Some((3, "Second".to_string())), "More.\n".to_string()),
            ]
        );
    }
}
