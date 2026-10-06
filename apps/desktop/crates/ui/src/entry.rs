//! The open entry: where it sits, what it is, its fields, its body, and what it is tied to.

use api::{EntryRead, FieldDefinitionKind, Source, TypeDefinition};
use gpui_kit::component::breadcrumb::{Breadcrumb, BreadcrumbItem};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::description_list::DescriptionList;
use gpui_kit::component::link::Link;
use gpui_kit::component::tag::Tag;
use gpui_kit::component::text::TextView;
use gpui_kit::component::{ActiveTheme as _, Icon, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _,
    Window, div,
};
use serde_json::Value;

use crate::intent::{FollowLink, Intent, OnIntent, with_entry_links};
use crate::load::Load;
use crate::status;
use crate::theme::{space, text};

/// What the server shows in place of a value the key may not see.
pub const HIDDEN: &str = "[hidden]";

/// An entry as the screen shows it: the entry as read, and its type, for the kinds of its fields.
#[derive(Clone, Debug)]
pub struct EntryData {
    pub read: EntryRead,
    pub type_definition: Option<TypeDefinition>,
}

/// The screen of one entry, in any state.
#[derive(IntoElement)]
pub struct EntryScreen {
    load: Load<EntryData>,
    on_intent: OnIntent,
}

impl EntryScreen {
    pub fn new(load: Load<EntryData>, on_intent: OnIntent) -> Self {
        Self { load, on_intent }
    }
}

impl RenderOnce for EntryScreen {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        match self.load {
            Load::Loading => status::loading(8).into_any_element(),
            Load::Empty => status::empty(
                "Aucune fiche ouverte",
                "Choisissez une fiche dans l'arbre, ou cherchez-la.",
                cx,
            )
            .into_any_element(),
            Load::Failed(problem) => {
                status::failed("entry-failed", &problem, self.on_intent).into_any_element()
            }
            Load::Ready(data) => ready(data, &self.on_intent, cx).into_any_element(),
        }
    }
}

fn section(title: &'static str, cx: &App) -> impl IntoElement {
    div()
        .text_size(text::SMALL)
        .text_color(cx.theme().muted_foreground)
        .child(title)
}

fn ready(data: EntryData, on_intent: &OnIntent, cx: &App) -> impl IntoElement {
    let EntryData {
        read,
        type_definition,
    } = data;
    let entry = &read.entry;
    let path = read.path.iter().enumerate().map(|(depth, title)| {
        let on_intent = on_intent.clone();
        BreadcrumbItem::new(title.clone())
            .on_click(move |_, window, cx| on_intent(Intent::OpenAncestor(depth), window, cx))
    });
    let header = v_flex()
        .gap(space::S)
        .when_some_path(read.path.is_empty().then_some(()), path)
        .child(
            h_flex()
                .gap(space::S)
                .items_start()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(text::TITLE)
                        .child(entry.title.clone()),
                )
                .child(Tag::secondary().small().child(entry.type_.clone()))
                .when_unverified(!entry.verified),
        )
        .when_summary(&entry.summary, cx);
    v_flex()
        .gap(space::XL)
        .p(space::L)
        .child(header)
        .child(fields(&read, type_definition.as_ref(), on_intent, cx))
        .child(body(entry.id.clone(), &entry.body))
        .child(related(&read, on_intent, cx))
        .child(sources(&entry.sources, on_intent, cx))
        .child(media(&read, cx))
}

/// Small helpers that keep the header readable.
trait HeaderExt: Sized {
    fn when_some_path(self, empty: Option<()>, path: impl Iterator<Item = BreadcrumbItem>) -> Self;
    fn when_unverified(self, unverified: bool) -> Self;
    fn when_summary(self, summary: &str, cx: &App) -> Self;
}

impl HeaderExt for gpui_kit::Div {
    fn when_some_path(self, empty: Option<()>, path: impl Iterator<Item = BreadcrumbItem>) -> Self {
        if empty.is_some() {
            self
        } else {
            self.child(Breadcrumb::new().children(path))
        }
    }

    fn when_unverified(self, unverified: bool) -> Self {
        if unverified {
            self.child(Tag::warning().small().outline().child("Non vérifiée"))
        } else {
            self
        }
    }

    fn when_summary(self, summary: &str, cx: &App) -> Self {
        if summary.is_empty() {
            self
        } else {
            self.child(
                div()
                    .text_size(text::BODY)
                    .text_color(cx.theme().muted_foreground)
                    .child(summary.to_string()),
            )
        }
    }
}

/// The values of the entry's fields, in the order of its type, each shown by its kind.
fn fields(
    read: &EntryRead,
    type_definition: Option<&TypeDefinition>,
    on_intent: &OnIntent,
    cx: &App,
) -> AnyElement {
    let values = &read.entry.fields;
    if values.is_empty() {
        return div().into_any_element();
    }
    let ordered: Vec<(String, Option<FieldDefinitionKind>)> = type_definition
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
    let list = ordered.into_iter().chain(rest).fold(
        DescriptionList::horizontal().bordered(true).columns(1),
        |list, (name, kind)| {
            let value = value_of(&values[&name], kind, read, on_intent, cx);
            list.item(name.replace('_', " "), value, 1)
        },
    );
    v_flex()
        .gap(space::S)
        .child(section("Champs", cx))
        .child(list)
        .into_any_element()
}

/// A value as its kind reads best: a hidden value as hidden, dates in words, links that open.
fn value_of(
    value: &Value,
    kind: Option<FieldDefinitionKind>,
    read: &EntryRead,
    on_intent: &OnIntent,
    cx: &App,
) -> AnyElement {
    if value.as_str() == Some(HIDDEN) {
        return h_flex()
            .gap(space::XS)
            .text_color(cx.theme().muted_foreground)
            .child(Icon::new(IconName::EyeOff).small())
            .child("Masquée")
            .into_any_element();
    }
    let text_value = match value {
        Value::String(text) => text.clone(),
        Value::Bool(true) => "Oui".into(),
        Value::Bool(false) => "Non".into(),
        other => other.to_string(),
    };
    match kind {
        Some(FieldDefinitionKind::Date) => date_in_words(&text_value).into_any_element(),
        Some(FieldDefinitionKind::Money) => text_value.replace('.', ",").into_any_element(),
        Some(FieldDefinitionKind::Enum) => h_flex()
            .child(Tag::new().small().child(text_value))
            .into_any_element(),
        Some(FieldDefinitionKind::Url) => {
            let on_intent = on_intent.clone();
            let url: SharedString = text_value.clone().into();
            Link::new(SharedString::from(format!("field-url-{text_value}")))
                .child(text_value)
                .on_click(move |_, window, cx| on_intent(Intent::OpenUrl(url.clone()), window, cx))
                .into_any_element()
        }
        Some(FieldDefinitionKind::Entry) => {
            let title = read
                .links
                .iter()
                .chain(&read.backlinks)
                .find(|link| link.id == text_value)
                .map_or_else(|| text_value.clone(), |link| link.title.clone());
            h_flex()
                .child(entry_button(
                    format!("field-entry-{text_value}"),
                    title,
                    text_value,
                    on_intent,
                ))
                .into_any_element()
        }
        _ => text_value.into_any_element(),
    }
}

/// `2026-10-05` as `5 oct. 2026`; any other text as it is.
pub fn date_in_words(date: &str) -> String {
    const MONTHS: [&str; 12] = [
        "janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.",
        "déc.",
    ];
    let parts: Vec<&str> = date.split('-').collect();
    match parts.as_slice() {
        [year, month, day] if year.len() == 4 => {
            match (month.parse::<usize>(), day.parse::<u32>()) {
                (Ok(month @ 1..=12), Ok(day)) => format!("{day} {} {year}", MONTHS[month - 1]),
                _ => date.to_string(),
            }
        }
        _ => date.to_string(),
    }
}

fn entry_button(
    id: String,
    title: impl Into<SharedString>,
    target: impl Into<SharedString>,
    on_intent: &OnIntent,
) -> AnyElement {
    let on_intent = on_intent.clone();
    let target = target.into();
    Button::new(SharedString::from(id))
        .link()
        .label(title)
        .on_click(move |_, window, cx| on_intent(Intent::Open(target.clone()), window, cx))
        .into_any_element()
}

/// The body, from Markdown, with `[[slug]]` references as links that open the entry.
fn body(id: String, body: &str) -> AnyElement {
    if body.trim().is_empty() {
        return div().into_any_element();
    }
    TextView::markdown(
        SharedString::from(format!("body-{id}")),
        with_entry_links(body),
    )
    .selectable(true)
    .on_link_click(|url, _, window, cx| {
        window.dispatch_action(Box::new(FollowLink { url: url.clone() }), cx);
    })
    .into_any_element()
}

/// The children of the entry, then its links both ways.
fn related(read: &EntryRead, on_intent: &OnIntent, cx: &App) -> AnyElement {
    let mut blocks = v_flex().gap(space::L);
    let mut any = false;
    if !read.children.is_empty() || read.hidden_children > 0 {
        any = true;
        let hidden = (read.hidden_children > 0).then(|| {
            div()
                .text_size(text::SMALL)
                .text_color(cx.theme().muted_foreground)
                .child(match read.hidden_children {
                    1 => "Et une fiche masquée.".to_string(),
                    count => format!("Et {count} fiches masquées."),
                })
        });
        blocks = blocks.child(
            v_flex()
                .gap(space::XS)
                .child(section("Contient", cx))
                .children(read.children.iter().map(|child| {
                    h_flex()
                        .gap(space::S)
                        .child(entry_button(
                            format!("child-{}", child.id),
                            child.title.clone(),
                            child.slug.clone(),
                            on_intent,
                        ))
                        .child(Tag::secondary().small().child(child.type_.clone()))
                }))
                .children(hidden),
        );
    }
    for (title, links, key) in [
        ("Liens", &read.links, "link"),
        ("Cité par", &read.backlinks, "backlink"),
    ] {
        if links.is_empty() {
            continue;
        }
        any = true;
        blocks = blocks.child(v_flex().gap(space::XS).child(section(title, cx)).children(
            links.iter().map(|link| {
                h_flex()
                    .gap(space::S)
                    .child(
                        div()
                            .w(gpui_kit::px(120.))
                            .text_size(text::SMALL)
                            .text_color(cx.theme().muted_foreground)
                            .child(link.relation.replace('_', " ")),
                    )
                    .child(entry_button(
                        format!("{key}-{}-{}", link.relation, link.id),
                        link.title.clone(),
                        link.slug.clone(),
                        on_intent,
                    ))
            }),
        ));
    }
    if any {
        blocks.into_any_element()
    } else {
        div().into_any_element()
    }
}

/// Where the entry comes from.
fn sources(sources: &[Source], on_intent: &OnIntent, cx: &App) -> AnyElement {
    if sources.is_empty() {
        return div().into_any_element();
    }
    v_flex()
        .gap(space::XS)
        .child(section("Sources", cx))
        .children(sources.iter().enumerate().map(|(index, source)| {
            let (shown, note): (AnyElement, Option<&String>) = match source {
                Source::Entry(entry) => (
                    entry_button(
                        format!("source-{index}"),
                        entry.title.clone(),
                        entry.entry.clone(),
                        on_intent,
                    ),
                    entry.note.as_ref(),
                ),
                Source::Url(url) => {
                    let on_intent = on_intent.clone();
                    let address: SharedString = url.url.clone().into();
                    (
                        Link::new(SharedString::from(format!("source-{index}")))
                            .child(url.url.clone())
                            .on_click(move |_, window, cx| {
                                on_intent(Intent::OpenUrl(address.clone()), window, cx)
                            })
                            .into_any_element(),
                        url.note.as_ref(),
                    )
                }
                Source::Identifier(identifier) => (
                    match &identifier.label {
                        Some(label) => format!("{label} ({})", identifier.identifier),
                        None => identifier.identifier.clone(),
                    }
                    .into_any_element(),
                    identifier.note.as_ref(),
                ),
                Source::Item(item) => (
                    format!("{} : {}", item.source, item.item).into_any_element(),
                    item.note.as_ref(),
                ),
            };
            h_flex()
                .gap(space::S)
                .child(shown)
                .children(note.map(|note| {
                    div()
                        .text_size(text::SMALL)
                        .text_color(cx.theme().muted_foreground)
                        .child(format!("— {note}"))
                }))
        }))
        .into_any_element()
}

/// The files of the entry, as tiles: what each is, and its description.
fn media(read: &EntryRead, cx: &App) -> AnyElement {
    if read.media.is_empty() {
        return div().into_any_element();
    }
    v_flex()
        .gap(space::XS)
        .child(section("Médias", cx))
        .child(
            h_flex()
                .gap(space::S)
                .flex_wrap()
                .children(read.media.iter().map(|medium| {
                    let size = match (medium.width, medium.height) {
                        (Some(width), Some(height)) => format!("{width} × {height}"),
                        _ => medium.mime.clone(),
                    };
                    v_flex()
                        .w(gpui_kit::px(160.))
                        .gap(space::XS)
                        .child(
                            div()
                                .h(gpui_kit::px(100.))
                                .w_full()
                                .rounded(cx.theme().radius)
                                .bg(cx.theme().muted)
                                .flex()
                                .items_center()
                                .justify_center()
                                .text_color(cx.theme().muted_foreground)
                                .child(medium.kind.clone()),
                        )
                        .child(
                            div()
                                .text_size(text::SMALL)
                                .child(if medium.alt.is_empty() {
                                    "Sans description".to_string()
                                } else {
                                    medium.alt.clone()
                                }),
                        )
                        .child(
                            div()
                                .text_size(text::SMALL)
                                .text_color(cx.theme().muted_foreground)
                                .child(size),
                        )
                })),
        )
        .into_any_element()
}
