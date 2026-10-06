//! The results of a search: what each entry is, where it sits, and the words that matched.

use api::SearchResult;
use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, ElementId, FontWeight, HighlightStyle, IntoElement, ParentElement as _,
    RenderOnce, ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledText, Window, div, px,
};

use crate::intent::{Intent, OnIntent};
use crate::load::Load;
use crate::motion::hoverable;
use crate::parts::{icon_box, layout, lead, mix, page, title};
use crate::status;
use crate::theme::{self, space, text};

/// A search as the screen shows it.
#[derive(Clone, Debug)]
pub struct SearchData {
    /// What was searched.
    pub query: SharedString,
    /// The types a search may be narrowed to.
    pub types: Vec<SharedString>,
    /// The type it is narrowed to, if any.
    pub type_name: Option<SharedString>,
    pub results: Load<Vec<SearchResult>>,
}

/// The screen of a search, in any state. `shown` counts what the pane has shown: a new value
/// plays the page's entrance again.
#[derive(IntoElement)]
pub struct SearchScreen {
    data: SearchData,
    on_intent: OnIntent,
    scroll: ScrollHandle,
    shown: usize,
}

impl SearchScreen {
    pub fn new(data: SearchData, on_intent: OnIntent, scroll: ScrollHandle, shown: usize) -> Self {
        Self {
            data,
            on_intent,
            scroll,
            shown,
        }
    }
}

/// An excerpt as the server marks it (`<mark>` around matched words): the text, and the ranges
/// to highlight.
pub fn marked(excerpt: &str) -> (String, Vec<std::ops::Range<usize>>) {
    let mut text = String::with_capacity(excerpt.len());
    let mut ranges = Vec::new();
    let mut rest = excerpt;
    while let Some(start) = rest.find("<mark>") {
        text.push_str(&rest[..start]);
        rest = &rest[start + "<mark>".len()..];
        let end = rest.find("</mark>").unwrap_or(rest.len());
        let from = text.len();
        text.push_str(&rest[..end]);
        ranges.push(from..text.len());
        rest = rest.get(end + "</mark>".len()..).unwrap_or("");
    }
    text.push_str(rest);
    (text, ranges)
}

impl RenderOnce for SearchScreen {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let on_intent = self.on_intent.clone();
        let SearchData {
            query,
            types,
            type_name,
            results,
        } = self.data;
        let found = match &results {
            Load::Ready(found) => match found.len() {
                1 => "1 fiche trouvée".to_string(),
                count => format!("{count} fiches trouvées"),
            },
            _ => "Recherche".to_string(),
        };
        let filters: Vec<AnyElement> = std::iter::once(None)
            .chain(types.into_iter().map(Some))
            .map(|filter| filter_chip(filter, &type_name, &query, &on_intent, window, cx))
            .collect();
        let body = match results {
            Load::Loading => status::loading(6).into_any_element(),
            Load::Empty => status::empty(
                IconName::Search,
                format!("Rien pour « {query} »"),
                "Essayez d'autres mots, ou tous les types.",
                cx,
            )
            .into_any_element(),
            Load::Failed(problem) => {
                status::failed("search-retry", &problem, on_intent.clone(), window, cx)
            }
            Load::Ready(found) => v_flex()
                .gap(space::S)
                .children(
                    found
                        .into_iter()
                        .map(|result| result_card(result, &on_intent, window, cx)),
                )
                .into_any_element(),
        };
        let page = page()
            .child(title(format!("« {query} »")))
            .child(lead(found, cx))
            .child(
                h_flex()
                    .mt(space::XL)
                    .mb(space::L)
                    .gap(space::S)
                    .flex_wrap()
                    .children(filters),
            )
            .child(body);
        layout(&self.scroll, self.shown, page, None)
    }
}

/// A type the search may be narrowed to, or all of them; the chosen one in the accent.
fn filter_chip(
    filter: Option<SharedString>,
    chosen: &Option<SharedString>,
    query: &SharedString,
    on_intent: &OnIntent,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let on = filter == *chosen;
    let theme = cx.theme();
    let (idle, over, border, muted, foreground, accent, radius) = (
        theme.secondary,
        theme.accent,
        theme.border,
        theme.muted_foreground,
        theme.foreground,
        theme.primary,
        theme.radius,
    );
    let tint = theme::accent_tint(cx);
    let on_intent = on_intent.clone();
    let query = query.clone();
    let label = filter.clone().unwrap_or_else(|| "Tous".into());
    hoverable(
        ElementId::Name(format!("filter-{}", filter.as_deref().unwrap_or("*")).into()),
        window,
        cx,
        move |element, hover| {
            let element = element
                .h(px(28.))
                .px(px(10.))
                .flex()
                .items_center()
                .rounded(radius)
                .border_1()
                .text_size(text::SMALL)
                .cursor_pointer()
                .on_click(move |_, window, cx| {
                    on_intent(
                        Intent::Search {
                            query: query.clone(),
                            type_name: filter.clone(),
                        },
                        window,
                        cx,
                    )
                })
                .child(label);
            if on {
                element
                    .border_color(tint.opacity(0.))
                    .bg(tint)
                    .text_color(accent)
            } else {
                element
                    .border_color(border)
                    .bg(mix(idle, over, hover.0))
                    .text_color(mix(muted, foreground, hover.0))
            }
        },
    )
}

/// One result, as a card: its title, its type, where it sits, and the words that matched; the
/// whole card opens it.
fn result_card(
    result: SearchResult,
    on_intent: &OnIntent,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let on_intent = on_intent.clone();
    let slug: SharedString = result.slug.clone().into();
    let (excerpt, ranges) = marked(&result.excerpt);
    let theme = cx.theme();
    let emphasis = HighlightStyle {
        color: Some(theme.foreground),
        background_color: Some(theme.warning.opacity(0.22)),
        ..Default::default()
    };
    let (idle, over, border, muted, radius) = (
        theme.secondary,
        theme.accent,
        theme.border,
        theme.muted_foreground,
        theme.radius_lg,
    );
    let faint = theme::faint(cx);
    let content = h_flex()
        .items_start()
        .gap(space::M)
        .child(icon_box(IconName::FileText, px(32.), cx))
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .gap(space::XS)
                .child(
                    h_flex()
                        .gap(space::S)
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .font_weight(FontWeight::MEDIUM)
                                .child(result.title.clone()),
                        )
                        .child(
                            div()
                                .h(px(22.))
                                .px(space::S)
                                .flex()
                                .items_center()
                                .rounded(px(6.))
                                .border_1()
                                .border_color(border)
                                .text_size(text::XS)
                                .text_color(muted)
                                .child(result.type_.clone()),
                        ),
                )
                .children((!result.path.is_empty()).then(|| {
                    div()
                        .text_size(text::XS)
                        .text_color(faint)
                        .child(result.path.join(" › "))
                }))
                .child(
                    div().text_color(muted).child(
                        StyledText::new(excerpt)
                            .with_highlights(ranges.into_iter().map(|range| (range, emphasis))),
                    ),
                ),
        );
    hoverable(
        SharedString::from(format!("result-{}", result.id)),
        window,
        cx,
        move |element, hover| {
            element
                .p(space::L)
                .rounded(radius)
                .border_1()
                .border_color(border)
                .bg(mix(idle, over, hover.0))
                .cursor_pointer()
                .on_click(move |_, window, cx| on_intent(Intent::Open(slug.clone()), window, cx))
                .child(content)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::marked;

    #[test]
    fn the_marked_words_of_an_excerpt_are_found() {
        assert_eq!(
            marked("A <mark>plum</mark> tart with <mark>plums</mark>."),
            ("A plum tart with plums.".to_string(), vec![2..6, 17..22])
        );
    }
}
