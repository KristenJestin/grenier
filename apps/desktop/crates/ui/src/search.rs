//! The results of a search: what each entry is, where it sits, and the words that matched.

use api::SearchResult;
use gpui_kit::base::Selectable as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::list::ListItem;
use gpui_kit::component::tag::Tag;
use gpui_kit::component::{ActiveTheme as _, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    App, FontWeight, HighlightStyle, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, StyledText, Window, div,
};

use crate::intent::{Intent, OnIntent};
use crate::load::Load;
use crate::parts::page;
use crate::status;
use crate::theme::{space, text};

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

/// The screen of a search, in any state.
#[derive(IntoElement)]
pub struct SearchScreen {
    data: SearchData,
    on_intent: OnIntent,
}

impl SearchScreen {
    pub fn new(data: SearchData, on_intent: OnIntent) -> Self {
        Self { data, on_intent }
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
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let on_intent = self.on_intent.clone();
        let SearchData {
            query,
            types,
            type_name,
            results,
        } = self.data;
        let body_count = match &results {
            Load::Ready(found) => Some(found.len()),
            _ => None,
        };
        let filters = h_flex().gap(space::XS).flex_wrap().children(
            std::iter::once(None)
                .chain(types.into_iter().map(Some))
                .map(|filter| {
                    let on_intent = on_intent.clone();
                    let query = query.clone();
                    let selected = filter == type_name;
                    Button::new(SharedString::from(format!(
                        "filter-{}",
                        filter.as_deref().unwrap_or("*")
                    )))
                    .ghost()
                    .small()
                    .selected(selected)
                    .label(filter.clone().unwrap_or_else(|| "Tous les types".into()))
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
                }),
        );
        let body = match results {
            Load::Loading => status::loading(6).into_any_element(),
            Load::Empty => status::empty(
                format!("Rien pour « {query} »"),
                "Essayez d'autres mots, ou tous les types.",
                cx,
            )
            .into_any_element(),
            Load::Failed(problem) => {
                status::failed("search-failed", &problem, on_intent.clone()).into_any_element()
            }
            Load::Ready(found) => v_flex()
                .gap(space::XS)
                .children(
                    found
                        .into_iter()
                        .map(|result| result_row(result, &on_intent, cx)),
                )
                .into_any_element(),
        };
        let count = match &body_count {
            Some(count) => format!("{count} résultat{}", if *count == 1 { "" } else { "s" }),
            None => String::new(),
        };
        page(cx)
            .gap(space::L)
            .child(
                v_flex()
                    .gap(space::XS)
                    .child(
                        div()
                            .text_size(text::TITLE)
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(format!("« {query} »")),
                    )
                    .child(
                        div()
                            .text_size(text::SMALL)
                            .text_color(cx.theme().muted_foreground)
                            .child(count),
                    ),
            )
            .child(filters)
            .child(body)
    }
}

/// One result: its title, its type, where it sits, and its excerpt; the whole row opens it.
fn result_row(result: SearchResult, on_intent: &OnIntent, cx: &App) -> impl IntoElement {
    let on_intent = on_intent.clone();
    let slug: SharedString = result.slug.clone().into();
    let (excerpt, ranges) = marked(&result.excerpt);
    let emphasis = HighlightStyle {
        font_weight: Some(FontWeight::SEMIBOLD),
        background_color: Some(cx.theme().warning.opacity(0.22)),
        ..Default::default()
    };
    let muted = cx.theme().muted_foreground;
    ListItem::new(SharedString::from(format!("result-{}", result.id)))
        .px(space::M)
        .py(space::S)
        .rounded(cx.theme().radius_lg)
        .on_click(move |_, window, cx| on_intent(Intent::Open(slug.clone()), window, cx))
        .child(
            v_flex()
                .w_full()
                .gap(space::XS)
                .child(
                    h_flex()
                        .gap(space::S)
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(result.title.clone()),
                        )
                        .child(Tag::secondary().small().child(result.type_.clone())),
                )
                .children((!result.path.is_empty()).then(|| {
                    div()
                        .text_size(text::SMALL)
                        .text_color(muted)
                        .child(result.path.join(" › "))
                }))
                .child(
                    div().text_color(muted).child(
                        StyledText::new(excerpt)
                            .with_highlights(ranges.into_iter().map(|range| (range, emphasis))),
                    ),
                ),
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
