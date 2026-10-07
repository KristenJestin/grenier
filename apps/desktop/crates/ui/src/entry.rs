//! The open entry: where it sits, what it is, its fields, its body, and what it is tied to; and
//! beside it, the contents of the page, which follow the reading and jump to a section.

use std::f32::consts::FRAC_PI_2;
use std::time::{Duration, Instant};

use api::{Child, EntryRead, FieldDefinitionKind, Medium, Source, TypeDefinition};
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

use crate::intent::{FollowLink, Intent, OnIntent, with_entry_links};
use crate::load::Load;
use crate::motion::{SPRING, hoverable, reveal};
use crate::parts::{
    Card, card, cards, chip, heading, layout, lead, mix, page, plain_card, title, warning_chip,
};
use crate::status;
use crate::theme::{self, font, space, text, width};

/// What the server shows in place of a value the key may not see.
pub const HIDDEN: &str = "[hidden]";

/// An entry as the screen shows it: the entry as read, and its type, for the kinds of its fields.
#[derive(Clone, Debug)]
pub struct EntryData {
    pub read: EntryRead,
    pub type_definition: Option<TypeDefinition>,
}

/// The screen of one entry, in any state. `shown` counts what the pane has shown: a new value
/// plays the page's entrance again.
#[derive(IntoElement)]
pub struct EntryScreen {
    load: Load<EntryData>,
    on_intent: OnIntent,
    scroll: ScrollHandle,
    shown: usize,
}

impl EntryScreen {
    pub fn new(
        load: Load<EntryData>,
        on_intent: OnIntent,
        scroll: ScrollHandle,
        shown: usize,
    ) -> Self {
        Self {
            load,
            on_intent,
            scroll,
            shown,
        }
    }
}

impl RenderOnce for EntryScreen {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let article = match self.load {
            Load::Loading => page().child(status::loading(6)).into_any_element(),
            Load::Empty => page()
                .child(status::empty(
                    IconName::FileText,
                    "Aucune fiche ouverte",
                    "Choisissez une fiche à gauche, ou cherchez-la avec Ctrl K.",
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
                return ready(data, &self.on_intent, &self.scroll, self.shown, window, cx);
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

fn ready(
    data: EntryData,
    on_intent: &OnIntent,
    scroll: &ScrollHandle,
    shown: usize,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let EntryData {
        read,
        type_definition,
    } = data;
    let entry = &read.entry;
    let mut article = Article::default();
    if !read.path.is_empty() {
        article.push(crumbs(&read.path, on_intent, window, cx));
    }
    article.push(title(entry.title.clone()));
    if !entry.summary.is_empty() {
        article.push(lead(entry.summary.clone(), cx));
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
            .child(chip(Some(Icon::new(IconName::FileText)), type_label, cx))
            .children(
                (!entry.verified)
                    .then(|| warning_chip(Icon::new(IconName::CircleAlert), "Non vérifiée", cx)),
            )
            .children(entry.tags.iter().map(|tag| {
                chip(Some(Icon::new(IconName::Tag)), tag.clone(), cx)
                    .text_color(cx.theme().muted_foreground)
            })),
    );
    if let Some(fields) = fields(&read, type_definition.as_ref(), on_intent, window, cx) {
        article.anchored("Champs", 2, fields);
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
    links(&mut article, &read, on_intent, window, cx);
    sources(&mut article, &entry.sources, on_intent, window, cx);
    media(&mut article, &read.media, cx);
    article.push(
        h_flex()
            .mt(space::XXXL)
            .pt(space::L)
            .justify_between()
            .border_t_1()
            .border_color(border)
            .text_color(cx.theme().muted_foreground)
            .child(format!("Modifiée le {}", date_in_words(&entry.updated)))
            .child(if entry.verified {
                "Vérifiée"
            } else {
                "Non vérifiée"
            }),
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

/// Where the entry sits: each ancestor opens.
fn crumbs(path: &[String], on_intent: &OnIntent, window: &mut Window, cx: &mut App) -> Div {
    let theme = cx.theme();
    let (muted, foreground) = (theme.muted_foreground, theme.foreground);
    let mut row = h_flex()
        .gap(space::XS)
        .text_size(text::SMALL)
        .text_color(muted);
    for (depth, ancestor) in path.iter().enumerate() {
        if depth > 0 {
            row = row.child(Icon::new(IconName::ChevronRight).xsmall());
        }
        let on_intent = on_intent.clone();
        let ancestor = ancestor.clone();
        row = row.child(hoverable(
            ElementId::named_usize("crumb", depth),
            window,
            cx,
            move |element, hover| {
                element
                    .text_color(mix(muted, foreground, hover.0))
                    .cursor_pointer()
                    .on_click(move |_, window, cx| {
                        on_intent(Intent::OpenAncestor(depth), window, cx)
                    })
                    .child(ancestor)
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
                                read,
                                on_intent,
                                cx,
                            )))
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
                .on_click(move |_, _, cx| {
                    open_state.update(cx, |open, cx| {
                        *open = !*open;
                        cx.notify();
                    })
                })
                .child(chevron)
                .child("Champs")
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

/// A value as its kind reads best: a hidden value as hidden, dates in words, links that open.
fn value_of(
    value: &Value,
    kind: Option<FieldDefinitionKind>,
    read: &EntryRead,
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
            .child("masqué")
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
                SharedString::from(format!("field-url-{text_value}")),
                without_scheme(&text_value),
                browser(on_intent, text_value.clone()),
                cx,
            ))
            .into_any_element(),
        Some(FieldDefinitionKind::Entry) => {
            let title = read
                .links
                .iter()
                .chain(&read.backlinks)
                .find(|link| link.id == text_value || link.slug == text_value)
                .map_or_else(|| text_value.clone(), |link| link.title.clone());
            h_flex()
                .child(reference(
                    SharedString::from(format!("field-entry-{text_value}")),
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

/// `2026-10-05` (or a timestamp of that day) as `5 oct. 2026`; any other text as it is.
pub fn date_in_words(date: &str) -> String {
    const MONTHS: [&str; 12] = [
        "janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.",
        "déc.",
    ];
    let day_part = date.get(..10).unwrap_or(date);
    let parts: Vec<&str> = day_part.split('-').collect();
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
    let titled = with_entry_links(body, |slug| {
        read.links
            .iter()
            .chain(&read.backlinks)
            .find(|link| link.slug == slug)
            .map(|link| link.title.clone())
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
                    title: match hidden {
                        1 => "Une fiche masquée".into(),
                        count => format!("{count} fiches masquées").into(),
                    },
                    detail: Some("Cette clé ne voit pas les fiches sensibles.".into()),
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
        "Contient",
        2,
        v_flex()
            .child(heading("Contient", Some(read.children.len() + hidden), cx))
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
        .child(cell().child("Nom"))
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
                        |value| value_of(value, *kind, read, on_intent, cx),
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

/// The links of the entry, both ways: each card says how it relates.
fn links(
    article: &mut Article,
    read: &EntryRead,
    on_intent: &OnIntent,
    window: &mut Window,
    cx: &mut App,
) {
    if read.links.is_empty() && read.backlinks.is_empty() {
        return;
    }
    let outgoing = read.links.iter().map(|link| ("out", link));
    let incoming = read.backlinks.iter().map(|link| ("in", link));
    let list: Vec<AnyElement> = outgoing
        .chain(incoming)
        .map(|(way, link)| {
            let mut relation = label_of(&link.relation);
            if let Some(period) = &link.period {
                relation = format!("{relation} · {period}");
            }
            card(
                SharedString::from(format!("{way}-{}-{}", link.relation, link.id)),
                Card {
                    icon: Icon::new(if way == "out" {
                        IconName::ArrowRight
                    } else {
                        IconName::ArrowLeft
                    }),
                    title: link.title.clone().into(),
                    detail: None,
                    relation: Some(relation.into()),
                },
                opener(on_intent, link.slug.clone()),
                window,
                cx,
            )
        })
        .collect();
    article.anchored(
        "Liens",
        2,
        v_flex()
            .child(heading(
                "Liens",
                Some(read.links.len() + read.backlinks.len()),
                cx,
            ))
            .child(cards(list)),
    );
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
                        relation: Some("Fiche".into()),
                    },
                    opener(on_intent, entry.slug.clone()),
                    window,
                    cx,
                ),
                Source::Url(url) => card(
                    id,
                    Card {
                        icon: Icon::new(IconName::Globe),
                        title: without_scheme(&url.url).into(),
                        detail: note(&url.note),
                        relation: Some("Adresse web".into()),
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
                        relation: Some("Identifiant".into()),
                    },
                    cx,
                ),
                Source::Item(item) => quiet_source(
                    Card {
                        icon: Icon::new(IconName::Inbox),
                        title: format!("Élément de « {} »", item.source).into(),
                        detail: note(&item.note),
                        relation: Some("Élément".into()),
                    },
                    cx,
                ),
            }
        })
        .collect();
    article.anchored(
        "Sources",
        2,
        v_flex()
            .child(heading("Sources", Some(sources.len()), cx))
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
            (IconName::Image, "Image".to_string())
        } else {
            let subtype = medium.mime.rsplit('/').next().unwrap_or(&medium.mime);
            (IconName::FileText, subtype.to_uppercase())
        };
        let size = match (medium.width, medium.height) {
            (Some(width), Some(height)) => format!("{kind} · {width} × {height}"),
            _ => format!("{kind} · {} Ko", (medium.size + 500) / 1000),
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
                        "Sans description".to_string()
                    } else {
                        medium.alt.clone()
                    }))
                    .child(div().text_size(text::XS).text_color(faint).child(size)),
            )
            .into_any_element()
    });
    article.anchored(
        "Médias",
        2,
        v_flex()
            .child(heading("Médias", Some(media.len()), cx))
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
                        .child("Sur cette page"),
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
                        .child("Fiche"),
                )
                .child(format!("Créée le {}", date_in_words(&entry.created)))
                .child(format!("Modifiée le {}", date_in_words(&entry.updated)))
                .child(if entry.verified {
                    "Vérifiée par le propriétaire"
                } else {
                    "En attente de vérification"
                }),
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
    use super::parts_of;

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
