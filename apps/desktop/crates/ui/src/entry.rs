//! The open entry: where it sits, what it is, its fields, its body, and what it is tied to.

use api::{EntryRead, FieldDefinitionKind, Source, TypeDefinition};
use gpui_kit::component::breadcrumb::{Breadcrumb, BreadcrumbItem};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::link::Link;
use gpui_kit::component::tag::Tag;
use gpui_kit::component::text::TextView;
use gpui_kit::component::{ActiveTheme as _, Icon, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, FontWeight, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, div,
};
use serde_json::Value;

use crate::intent::{FollowLink, Intent, OnIntent, with_entry_links};
use crate::load::Load;
use crate::parts::{page, row, rows, section};
use crate::status;
use crate::theme::{space, text, width};

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

/// Opens an entry when called.
fn opener(
    on_intent: &OnIntent,
    target: impl Into<SharedString>,
) -> impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut App) + 'static {
    let on_intent = on_intent.clone();
    let target = target.into();
    move |_, window, cx| on_intent(Intent::Open(target.clone()), window, cx)
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

fn ready(data: EntryData, on_intent: &OnIntent, cx: &App) -> impl IntoElement {
    let EntryData {
        read,
        type_definition,
    } = data;
    let entry = &read.entry;
    let muted = cx.theme().muted_foreground;
    let path = (!read.path.is_empty()).then(|| {
        Breadcrumb::new().children(read.path.iter().enumerate().map(|(depth, title)| {
            let on_intent = on_intent.clone();
            BreadcrumbItem::new(title.clone())
                .on_click(move |_, window, cx| on_intent(Intent::OpenAncestor(depth), window, cx))
        }))
    });
    let unverified =
        (!entry.verified).then(|| Tag::warning().small().outline().child("Non vérifiée"));
    let summary = (!entry.summary.is_empty()).then(|| {
        div()
            .text_size(text::LEAD)
            .text_color(muted)
            .child(entry.summary.clone())
    });
    let header = v_flex()
        .gap(space::M)
        .children(path)
        .child(
            div()
                .text_size(text::TITLE)
                .font_weight(FontWeight::SEMIBOLD)
                .line_height(gpui_kit::relative(1.2))
                .child(entry.title.clone()),
        )
        .child(
            h_flex()
                .gap(space::S)
                .flex_wrap()
                .text_size(text::SMALL)
                .text_color(muted)
                .child(Tag::secondary().small().child(entry.type_.clone()))
                .children(unverified)
                .child(format!(
                    "Modifiée le {}",
                    date_in_words(&entry.updated[..entry.updated.len().min(10)])
                ))
                .children(entry.tags.iter().map(|tag| format!("#{tag}"))),
        )
        .children(summary);
    page(cx)
        .child(header)
        .children(fields(&read, type_definition.as_ref(), on_intent, cx))
        .children(body(entry.id.clone(), &entry.body))
        .children(children(&read, on_intent, cx))
        .children(links(&read, on_intent, cx))
        .children(sources(&entry.sources, on_intent, cx))
        .children(media(&read, cx))
}

/// The values of the entry's fields, in the order of its type, each shown by its kind.
fn fields(
    read: &EntryRead,
    type_definition: Option<&TypeDefinition>,
    on_intent: &OnIntent,
    cx: &App,
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
    let border = cx.theme().border;
    let muted = cx.theme().muted_foreground;
    let list = v_flex().children(ordered.into_iter().map(|(name, kind)| {
        h_flex()
            .items_start()
            .gap(space::L)
            .py(space::S)
            .border_b_1()
            .border_color(border)
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
                read,
                on_intent,
                cx,
            )))
    }));
    Some(section("Champs", None, list, cx))
}

/// A field name as a label: `monthly_cost` as `Monthly cost`.
fn label_of(name: &str) -> String {
    let spaced = name.replace('_', " ");
    let mut letters = spaced.chars();
    letters
        .next()
        .map(|first| first.to_uppercase().chain(letters).collect())
        .unwrap_or_default()
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
            .child(Tag::secondary().small().child(text_value))
            .into_any_element(),
        Some(FieldDefinitionKind::Url) => h_flex()
            .child(
                Link::new(SharedString::from(format!("field-url-{text_value}")))
                    .child(text_value.clone())
                    .on_click(browser(on_intent, text_value)),
            )
            .into_any_element(),
        Some(FieldDefinitionKind::Entry) => {
            let title = read
                .links
                .iter()
                .chain(&read.backlinks)
                .find(|link| link.id == text_value)
                .map_or_else(|| text_value.clone(), |link| link.title.clone());
            h_flex()
                .child(
                    Button::new(SharedString::from(format!("field-entry-{text_value}")))
                        .link()
                        .label(title)
                        .on_click(opener(on_intent, text_value)),
                )
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

/// The body, from Markdown, with `[[slug]]` references as links that open the entry.
fn body(id: String, body: &str) -> Option<AnyElement> {
    if body.trim().is_empty() {
        return None;
    }
    Some(
        TextView::markdown(
            SharedString::from(format!("body-{id}")),
            with_entry_links(body),
        )
        .selectable(true)
        .text_size(text::LEAD)
        .on_link_click(|url, _, window, cx| {
            window.dispatch_action(Box::new(FollowLink { url: url.clone() }), cx);
        })
        .into_any_element(),
    )
}

/// The entries filed under this one; those the key may not see, counted.
fn children(read: &EntryRead, on_intent: &OnIntent, cx: &App) -> Option<AnyElement> {
    if read.children.is_empty() && read.hidden_children == 0 {
        return None;
    }
    let hidden = (read.hidden_children > 0).then(|| {
        div()
            .px(space::S)
            .pt(space::XS)
            .text_size(text::SMALL)
            .text_color(cx.theme().muted_foreground)
            .child(match read.hidden_children {
                1 => "Et une fiche masquée.".to_string(),
                count => format!("Et {count} fiches masquées."),
            })
            .into_any_element()
    });
    let list = rows(
        read.children
            .iter()
            .map(|child| {
                row(
                    SharedString::from(format!("child-{}", child.id)),
                    gpui_kit::assets::IconName::FileText,
                    child.title.clone(),
                    Some(child.type_.clone().into()),
                    opener(on_intent, child.slug.clone()),
                    cx,
                )
            })
            .chain(hidden),
    );
    Some(section(
        "Contient",
        Some(read.children.len() + read.hidden_children.max(0) as usize),
        list,
        cx,
    ))
}

/// The links of the entry, both ways, by relation.
fn links(read: &EntryRead, on_intent: &OnIntent, cx: &App) -> Option<AnyElement> {
    if read.links.is_empty() && read.backlinks.is_empty() {
        return None;
    }
    let outgoing = read.links.iter().map(|link| ("out", link));
    let incoming = read.backlinks.iter().map(|link| ("in", link));
    let list = rows(outgoing.chain(incoming).map(|(way, link)| {
        let relation = label_of(&link.relation);
        row(
            SharedString::from(format!("{way}-{}-{}", link.relation, link.id)),
            if way == "out" {
                gpui_kit::assets::IconName::ArrowRight
            } else {
                gpui_kit::assets::IconName::ArrowLeft
            },
            link.title.clone(),
            Some(relation.into()),
            opener(on_intent, link.slug.clone()),
            cx,
        )
    }));
    Some(section(
        "Liens",
        Some(read.links.len() + read.backlinks.len()),
        list,
        cx,
    ))
}

/// Where the entry comes from.
fn sources(sources: &[Source], on_intent: &OnIntent, cx: &App) -> Option<AnyElement> {
    if sources.is_empty() {
        return None;
    }
    let list = rows(sources.iter().enumerate().map(|(index, source)| {
        let id = SharedString::from(format!("source-{index}"));
        let note = |note: &Option<String>| note.clone().map(SharedString::from);
        match source {
            Source::Entry(entry) => row(
                id,
                gpui_kit::assets::IconName::FileText,
                entry.title.clone(),
                note(&entry.note),
                opener(on_intent, entry.entry.clone()),
                cx,
            ),
            Source::Url(url) => row(
                id,
                gpui_kit::assets::IconName::Globe,
                url.url.clone(),
                note(&url.note),
                browser(on_intent, url.url.clone()),
                cx,
            ),
            Source::Identifier(identifier) => row(
                id,
                gpui_kit::assets::IconName::Hash,
                identifier
                    .label
                    .clone()
                    .unwrap_or_else(|| identifier.identifier.clone()),
                Some(identifier.identifier.clone().into()),
                |_, _, _| {},
                cx,
            ),
            Source::Item(item) => row(
                id,
                gpui_kit::assets::IconName::Inbox,
                format!("Élément de « {} »", item.source),
                note(&item.note),
                |_, _, _| {},
                cx,
            ),
        }
    }));
    Some(section("Sources", Some(sources.len()), list, cx))
}

/// The files of the entry, as cards: what each is, and its description.
fn media(read: &EntryRead, cx: &App) -> Option<AnyElement> {
    if read.media.is_empty() {
        return None;
    }
    let theme = cx.theme();
    let cards = h_flex()
        .gap(space::M)
        .flex_wrap()
        .children(read.media.iter().map(|medium| {
            let size = match (medium.width, medium.height) {
                (Some(width), Some(height)) => format!("{width} × {height}"),
                _ => medium.mime.clone(),
            };
            let icon = if medium.kind == "image" {
                gpui_kit::assets::IconName::Image
            } else {
                gpui_kit::assets::IconName::FileText
            };
            v_flex()
                .w(gpui_kit::px(176.))
                .rounded(theme.radius_lg)
                .border_1()
                .border_color(theme.border)
                .overflow_hidden()
                .child(
                    div()
                        .h(gpui_kit::px(112.))
                        .w_full()
                        .bg(theme.muted)
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(Icon::new(icon).large().text_color(theme.muted_foreground)),
                )
                .child(
                    v_flex()
                        .p(space::S)
                        .gap(gpui_kit::px(2.))
                        .child(div().text_size(text::SMALL).truncate().child(
                            if medium.alt.is_empty() {
                                "Sans description".to_string()
                            } else {
                                medium.alt.clone()
                            },
                        ))
                        .child(
                            div()
                                .text_size(text::SMALL)
                                .text_color(theme.muted_foreground)
                                .child(size),
                        ),
                )
        }));
    Some(section("Médias", Some(read.media.len()), cards, cx))
}
