//! The viewer: the tree of entries in a sidebar, a search field at the top, and the open entry or
//! a search in the main pane. It owns no data: the application gives it what to show and listens
//! to what the user asks for.

use std::collections::HashMap;
use std::rc::Rc;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::list::ListItem;
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::tree::{TreeItem, TreeState, tree};
use gpui_kit::component::{ActiveTheme as _, Icon, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, FontWeight,
    InteractiveElement as _, IntoElement, KeyBinding, ParentElement as _, Render, SharedString,
    Styled as _, Subscription, Window, div, px,
};

use crate::entry::{EntryData, EntryScreen};
use crate::intent::{Back, FocusSearch, FollowLink, Forward, Intent, OnIntent, intent_of_link};
use crate::load::Load;
use crate::search::{SearchData, SearchScreen};
use crate::status;
use crate::theme::{space, text, width};

const CONTEXT: &str = "Viewer";

/// The keys of the viewer: search, back and forward.
pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("ctrl-k", FocusSearch, Some(CONTEXT)),
        KeyBinding::new("/", FocusSearch, Some(CONTEXT)),
        KeyBinding::new("alt-left", Back, Some(CONTEXT)),
        KeyBinding::new("alt-right", Forward, Some(CONTEXT)),
    ]);
}

/// One entry of the tree: what it is, and what it holds.
#[derive(Clone, Debug)]
pub struct TreeNode {
    pub id: SharedString,
    pub title: SharedString,
    pub type_name: SharedString,
    pub archived: bool,
    pub children: Vec<TreeNode>,
}

/// What the main pane shows.
#[derive(Clone, Debug)]
pub enum Pane {
    Entry(Box<Load<EntryData>>),
    Search(SearchData),
}

/// The viewer, as one screen: tree, search field and main pane.
pub struct Viewer {
    tree: Entity<TreeState>,
    tree_load: Load<()>,
    selected: Option<SharedString>,
    types: HashMap<SharedString, SharedString>,
    show_archived: bool,
    search: Entity<InputState>,
    pane: Pane,
    focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<Intent> for Viewer {}

impl Focusable for Viewer {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Viewer {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let tree = cx.new(|cx| TreeState::new(cx));
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Chercher dans Grenier"));
        let searched = cx.subscribe_in(&search, window, |viewer, state, event, _, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                let query: SharedString = state.read(cx).value().trim().to_string().into();
                if !query.is_empty() {
                    let type_name = match &viewer.pane {
                        Pane::Search(search) => search.type_name.clone(),
                        Pane::Entry(_) => None,
                    };
                    cx.emit(Intent::Search { query, type_name });
                }
            }
        });
        // Moving in the tree opens the entry under the selection, once per move.
        let moved = cx.observe(&tree, |viewer, tree, cx| {
            let selected = tree.read(cx).selected_item().map(|item| item.id.clone());
            if selected != viewer.selected {
                viewer.selected = selected.clone();
                if let Some(id) = selected {
                    cx.emit(Intent::Open(id));
                }
            }
        });
        Self {
            tree,
            tree_load: Load::Loading,
            selected: None,
            types: HashMap::new(),
            show_archived: false,
            search,
            pane: Pane::Entry(Box::new(Load::Empty)),
            focus: cx.focus_handle(),
            _subscriptions: vec![searched, moved],
        }
    }

    /// The tree of entries, or its state.
    pub fn set_tree(&mut self, load: Load<Vec<TreeNode>>, cx: &mut Context<Self>) {
        let nodes = match load {
            Load::Ready(nodes) => {
                self.tree_load = Load::Ready(());
                nodes
            }
            Load::Loading => {
                self.tree_load = Load::Loading;
                Vec::new()
            }
            Load::Empty => {
                self.tree_load = Load::Empty;
                Vec::new()
            }
            Load::Failed(problem) => {
                self.tree_load = Load::Failed(problem);
                Vec::new()
            }
        };
        self.types.clear();
        let items = self.items_of(&nodes);
        self.tree.update(cx, |tree, cx| tree.set_items(items, cx));
        cx.notify();
    }

    fn items_of(&mut self, nodes: &[TreeNode]) -> Vec<TreeItem> {
        let show_archived = self.show_archived;
        let mut items = Vec::with_capacity(nodes.len());
        for node in nodes.iter().filter(|node| show_archived || !node.archived) {
            self.types.insert(node.id.clone(), node.type_name.clone());
            let children = self.items_of(&node.children);
            items.push(TreeItem::new(node.id.clone(), node.title.clone()).children(children));
        }
        items
    }

    /// Shows an entry, or a search, in the main pane; the field shows what was searched.
    pub fn set_pane(&mut self, pane: Pane, window: &mut Window, cx: &mut Context<Self>) {
        if let Pane::Search(search) = &pane {
            let query = search.query.clone();
            self.search
                .update(cx, |field, cx| field.set_value(query, window, cx));
        }
        self.pane = pane;
        cx.notify();
    }

    /// Selects an entry of the tree, its ancestors expanded.
    pub fn select(&mut self, id: &SharedString, cx: &mut Context<Self>) {
        self.tree.update(cx, |tree, cx| {
            tree.reveal_item(id, gpui_kit::ScrollStrategy::Center, cx);
            let index = tree.index_of(id);
            tree.set_selected_index(index, cx);
        });
    }

    /// The id of the entry the main pane shows, if it shows one.
    pub fn opened(&self) -> Option<&str> {
        match &self.pane {
            Pane::Entry(load) => match load.as_ref() {
                Load::Ready(data) => Some(&data.read.entry.id),
                _ => None,
            },
            Pane::Search(_) => None,
        }
    }

    /// Puts the keyboard in the tree.
    pub fn focus_tree(&self, window: &mut Window, cx: &mut App) {
        self.tree.update(cx, |tree, cx| tree.focus(window, cx));
    }

    fn on_intent(&self, cx: &mut Context<Self>) -> OnIntent {
        let viewer = cx.entity().downgrade();
        Rc::new(move |intent, _, cx| {
            viewer.update(cx, |_, cx| cx.emit(intent)).ok();
        })
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let types = self.types.clone();
        let muted = cx.theme().muted_foreground;
        let body = match &self.tree_load {
            Load::Loading => status::loading(10).into_any_element(),
            Load::Empty => status::empty(
                "Aucune fiche",
                "Les fiches écrites par les agents apparaîtront ici.",
                cx,
            )
            .into_any_element(),
            Load::Failed(problem) => {
                status::failed("tree-failed", problem, self.on_intent(cx)).into_any_element()
            }
            Load::Ready(()) => tree(&self.tree, move |index, entry, selected, _, _| {
                let item = entry.item();
                let type_name = types.get(&item.id).cloned().unwrap_or_default();
                let icon = match (entry.is_folder(), entry.is_expanded()) {
                    (true, true) => gpui_kit::assets::IconName::FolderOpen,
                    (true, false) => gpui_kit::assets::IconName::Folder,
                    (false, _) => gpui_kit::assets::IconName::FileText,
                };
                ListItem::new(index)
                    .selected(selected)
                    .py(px(3.))
                    .pl(px(14.) * entry.depth() as f32 + space::S)
                    .pr(space::S)
                    .child(
                        h_flex()
                            .gap(space::S)
                            .w_full()
                            .child(Icon::new(icon).small().text_color(muted))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .child(item.label.clone()),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .text_size(text::SMALL)
                                    .text_color(muted)
                                    .child(type_name),
                            ),
                    )
            })
            .size_full()
            .into_any_element(),
        };
        v_flex()
            .w(width::SIDEBAR)
            .h_full()
            .flex_none()
            .border_r_1()
            .border_color(cx.theme().sidebar_border)
            .bg(cx.theme().sidebar)
            .text_color(cx.theme().sidebar_foreground)
            .child(
                div()
                    .px(space::L)
                    .pt(space::L)
                    .pb(space::S)
                    .text_size(text::SMALL)
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(muted)
                    .child("FICHES"),
            )
            .child(div().flex_1().min_h_0().px(space::S).child(body))
    }
}

impl Render for Viewer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let on_intent = self.on_intent(cx);
        let pane = match self.pane.clone() {
            Pane::Entry(load) => EntryScreen::new(*load, on_intent).into_any_element(),
            Pane::Search(search) => SearchScreen::new(search, on_intent).into_any_element(),
        };
        v_flex()
            .key_context(CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(|_, action: &FollowLink, _, cx| {
                cx.emit(intent_of_link(&action.url));
            }))
            .on_action(cx.listener(|_, _: &Back, _, cx| cx.emit(Intent::Back)))
            .on_action(cx.listener(|_, _: &Forward, _, cx| cx.emit(Intent::Forward)))
            .on_action(cx.listener(|viewer, _: &FocusSearch, window, cx| {
                viewer
                    .search
                    .update(cx, |search, cx| search.focus(window, cx));
            }))
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .text_size(text::BODY)
            .child(
                h_flex()
                    .h(px(48.))
                    .flex_none()
                    .px(space::M)
                    .gap(space::S)
                    .border_b_1()
                    .border_color(cx.theme().title_bar_border)
                    .bg(cx.theme().title_bar)
                    .child(
                        h_flex()
                            .w(width::SIDEBAR - space::M)
                            .gap(space::XS)
                            .child(
                                Button::new("back")
                                    .ghost()
                                    .small()
                                    .icon(gpui_kit::assets::IconName::ArrowLeft)
                                    .tooltip("Retour (Alt+←)")
                                    .on_click(cx.listener(|_, _, _, cx| cx.emit(Intent::Back))),
                            )
                            .child(
                                Button::new("forward")
                                    .ghost()
                                    .small()
                                    .icon(gpui_kit::assets::IconName::ArrowRight)
                                    .tooltip("Avancer (Alt+→)")
                                    .on_click(cx.listener(|_, _, _, cx| cx.emit(Intent::Forward))),
                            )
                            .child(
                                div()
                                    .pl(space::S)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Grenier"),
                            ),
                    )
                    .child(
                        h_flex().flex_1().justify_center().child(
                            div().w(width::SEARCH).child(
                                Input::new(&self.search)
                                    .prefix(Icon::new(IconName::Search).small())
                                    .suffix(
                                        div()
                                            .text_size(text::SMALL)
                                            .text_color(cx.theme().muted_foreground)
                                            .child("Ctrl K"),
                                    ),
                            ),
                        ),
                    )
                    .child(div().w(width::SIDEBAR - space::M)),
            )
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .items_start()
                    .child(self.sidebar(cx))
                    .child(
                        div()
                            .id("pane")
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .overflow_y_scrollbar()
                            .child(pane),
                    ),
            )
    }
}
