//! The entries a filter keeps, without a query: of a type, with a tag, with supposed values. Opened from the
//! chips of an entry; each filter shown, and removed by a click.

use std::collections::HashMap;

use api::TreeEntry;
use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderOnce, ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _, Window,
    div, px,
};

use crate::intent::{Intent, ListFilter, OnIntent};
use crate::load::Load;
use crate::motion::hoverable;
use crate::parts::{chip, layout, lead, page, text_button, title};
use crate::status;
use crate::text as words;
use crate::theme::{self, space, text};

/// A listing as the screen shows it.
#[derive(Clone, Debug)]
pub struct ListData {
    pub filter: ListFilter,
    /// The label of each type, by its name.
    pub type_labels: HashMap<String, String>,
    pub entries: Load<Vec<TreeEntry>>,
    /// Whether more entries follow on the server.
    pub more: bool,
}

/// The screen of a listing, in any state.
#[derive(IntoElement)]
pub struct ListScreen {
    data: ListData,
    on_intent: OnIntent,
    scroll: ScrollHandle,
    shown: usize,
}

impl ListScreen {
    pub fn new(data: ListData, on_intent: OnIntent, scroll: ScrollHandle, shown: usize) -> Self {
        Self {
            data,
            on_intent,
            scroll,
            shown,
        }
    }
}

impl RenderOnce for ListScreen {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ListData {
            filter,
            type_labels,
            entries,
            more,
        } = self.data;
        let on_intent = self.on_intent;
        let count = match &entries {
            Load::Ready(found) => words::listed(found.len(), more),
            _ => String::new(),
        };
        let mut chips: Vec<AnyElement> = Vec::new();
        if let Some((_, label)) = &filter.type_name {
            let without = ListFilter {
                type_name: None,
                ..filter.clone()
            };
            chips.push(removable(
                "filter-type",
                words::of_type(label),
                without,
                &on_intent,
                cx,
            ));
        }
        if let Some(tag) = &filter.tag {
            let without = ListFilter {
                tag: None,
                ..filter.clone()
            };
            chips.push(removable(
                "filter-tag",
                words::with_tag(tag),
                without,
                &on_intent,
                cx,
            ));
        }
        if filter.supposed {
            let without = ListFilter {
                supposed: false,
                ..filter.clone()
            };
            chips.push(removable(
                "filter-supposed",
                words::WITH_SUPPOSED.to_string(),
                without,
                &on_intent,
                cx,
            ));
        }
        let body = match entries {
            Load::Loading => status::loading(6).into_any_element(),
            Load::Empty => status::empty(
                IconName::ListFilter,
                words::NOTHING_LISTED,
                words::NOTHING_LISTED_DETAIL,
                cx,
            )
            .into_any_element(),
            Load::Failed(problem) => {
                status::failed("list-retry", &problem, on_intent.clone(), window, cx)
            }
            Load::Ready(found) => v_flex()
                .children(
                    found
                        .into_iter()
                        .map(|entry| row(entry, &type_labels, &on_intent, window, cx)),
                )
                .into_any_element(),
        };
        let page = page()
            .child(title(words::ENTRIES))
            .child(lead(count, cx))
            .child(
                h_flex()
                    .mt(space::XL)
                    .mb(space::L)
                    .gap(space::S)
                    .flex_wrap()
                    .children(chips),
            )
            .child(body)
            .children(more.then(|| {
                let on_intent = on_intent.clone();
                div().pt(space::M).child(text_button(
                    "list-more",
                    words::MORE,
                    move |_, window, cx| on_intent(Intent::MoreListed, window, cx),
                    window,
                    cx,
                ))
            }));
        layout(window, &self.scroll, self.shown, page, None)
    }
}

/// A filter of the listing, removed by a click: the listing without it.
fn removable(
    id: &'static str,
    label: String,
    without: ListFilter,
    on_intent: &OnIntent,
    cx: &App,
) -> AnyElement {
    let on_intent = on_intent.clone();
    let accent = cx.theme().primary;
    chip(None, label, cx)
        .id(ElementId::Name(id.into()))
        .debug_selector(move || id.to_string())
        .border_color(accent)
        .text_color(accent)
        .bg(theme::accent_tint(cx))
        .cursor_pointer()
        .tooltip(move |window, cx| {
            gpui_kit::component::tooltip::Tooltip::new(words::REMOVE_FILTER).build(window, cx)
        })
        .on_click(move |_, window, cx| on_intent(Intent::List(without.clone()), window, cx))
        .child(Icon::new(IconName::X).xsmall())
        .into_any_element()
}

/// One entry of the listing: its title and its type.
fn row(
    entry: TreeEntry,
    type_labels: &HashMap<String, String>,
    on_intent: &OnIntent,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = cx.theme();
    let (muted, foreground, over, radius, border) = (
        theme.muted_foreground,
        theme.foreground,
        theme.accent,
        theme.radius,
        theme.border,
    );
    let type_label = type_labels
        .get(&entry.type_)
        .cloned()
        .unwrap_or_else(|| entry.type_.clone());
    let open = {
        let on_intent = on_intent.clone();
        let target: SharedString = entry.slug.clone().into();
        move |_: &gpui_kit::ClickEvent, window: &mut Window, cx: &mut App| {
            on_intent(Intent::Open(target.clone()), window, cx)
        }
    };
    let title = entry.title.clone();
    hoverable(
        SharedString::from(format!("listed-{}", entry.id)),
        window,
        cx,
        move |element, hover| {
            element
                .h(px(40.))
                .px(space::S)
                .flex()
                .items_center()
                .gap(space::S)
                .rounded(radius)
                .border_b_1()
                .border_color(border)
                .bg(over.opacity(hover.0))
                .cursor_pointer()
                .on_click(open)
                .child(Icon::new(IconName::FileText).small().text_color(muted))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(foreground)
                        .child(title),
                )
                .child(
                    div()
                        .text_size(text::SMALL)
                        .text_color(muted)
                        .child(type_label),
                )
        },
    )
}
