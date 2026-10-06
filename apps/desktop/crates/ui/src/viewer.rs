//! The viewer: a sidebar with the search field and the tree of entries, its top-level folders as
//! groups, and a panel with the open entry or a search. It owns no data: the application gives
//! it what to show and listens to what the user asks for.

use std::collections::HashSet;
use std::f32::consts::FRAC_PI_2;
use std::rc::Rc;

use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnimationExt as _, AnyElement, App, AppContext as _, ClickEvent, ClipboardItem, Context, Div,
    ElementId, Entity, EventEmitter, FocusHandle, Focusable, FontWeight, InteractiveElement as _,
    IntoElement, KeyBinding, ParentElement as _, Render, ScrollHandle, SharedString,
    SpringAnimation, StatefulInteractiveElement as _, Styled as _, Subscription, Window, actions,
    div, linear_color_stop, linear_gradient, point, px, radians,
};

use gpui_kit::prelude::FluentBuilder as _;

use crate::entry::{EntryData, EntryScreen};
use crate::intent::{Back, FocusSearch, FollowLink, Forward, Intent, OnIntent, intent_of_link};
use crate::load::{Load, Problem};
use crate::motion::{SPRING, hoverable, reveal};
use crate::parts::mix;
use crate::search::{SearchData, SearchScreen};
use crate::status;
use crate::theme::{self, space, text, width};

const CONTEXT: &str = "Viewer";
const TREE: &str = "ViewerTree";

actions!(viewer, [SelectPrevious, SelectNext, Collapse, Expand]);

/// The keys of the viewer: search, back and forward; and in the tree, the arrows.
pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("ctrl-k", FocusSearch, Some(CONTEXT)),
        KeyBinding::new("/", FocusSearch, Some(CONTEXT)),
        KeyBinding::new("alt-left", Back, Some(CONTEXT)),
        KeyBinding::new("alt-right", Forward, Some(CONTEXT)),
        KeyBinding::new("up", SelectPrevious, Some(TREE)),
        KeyBinding::new("down", SelectNext, Some(TREE)),
        KeyBinding::new("left", Collapse, Some(TREE)),
        KeyBinding::new("right", Expand, Some(TREE)),
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

/// One line of the tree as the keyboard walks it: the entry, its parent, and whether it holds
/// others.
struct Line {
    id: SharedString,
    parent: Option<SharedString>,
    folder: bool,
}

/// The viewer, as one screen: sidebar and panel.
pub struct Viewer {
    nodes: Vec<TreeNode>,
    tree_load: Load<()>,
    expanded: HashSet<SharedString>,
    selected: Option<SharedString>,
    search: Entity<InputState>,
    pane: Pane,
    /// How many panes were shown: each new one comes in.
    shown: usize,
    scroll: ScrollHandle,
    sidebar_open: bool,
    connection: Option<SharedString>,
    focus: FocusHandle,
    tree_focus: FocusHandle,
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
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Chercher"));
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
        Self {
            nodes: Vec::new(),
            tree_load: Load::Loading,
            expanded: HashSet::new(),
            selected: None,
            search,
            pane: Pane::Entry(Box::new(Load::Empty)),
            shown: 0,
            scroll: ScrollHandle::new(),
            sidebar_open: true,
            connection: None,
            focus: cx.focus_handle(),
            tree_focus: cx.focus_handle(),
            _subscriptions: vec![searched],
        }
    }

    /// The tree of entries, or its state. Archived entries are left out.
    pub fn set_tree(&mut self, load: Load<Vec<TreeNode>>, cx: &mut Context<Self>) {
        fn current(nodes: Vec<TreeNode>) -> Vec<TreeNode> {
            nodes
                .into_iter()
                .filter(|node| !node.archived)
                .map(|node| TreeNode {
                    children: current(node.children),
                    ..node
                })
                .collect()
        }
        (self.tree_load, self.nodes) = match load {
            Load::Ready(nodes) => (Load::Ready(()), current(nodes)),
            Load::Loading => (Load::Loading, Vec::new()),
            Load::Empty => (Load::Empty, Vec::new()),
            Load::Failed(problem) => (Load::Failed(problem), Vec::new()),
        };
        cx.notify();
    }

    /// The server the viewer reads, named at the foot of the sidebar.
    pub fn set_connection(&mut self, name: Option<SharedString>, cx: &mut Context<Self>) {
        self.connection = name;
        cx.notify();
    }

    /// Shows an entry, or a search, in the main pane, which comes in from the top; the field
    /// shows what was searched.
    pub fn set_pane(&mut self, pane: Pane, window: &mut Window, cx: &mut Context<Self>) {
        if let Pane::Search(search) = &pane {
            let query = search.query.clone();
            self.search
                .update(cx, |field, cx| field.set_value(query, window, cx));
        }
        self.pane = pane;
        self.shown += 1;
        self.scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }

    /// Selects an entry of the tree, its ancestors unfolded, and opens it.
    pub fn select(&mut self, id: &SharedString, cx: &mut Context<Self>) {
        let mut path = Vec::new();
        if path_to(&self.nodes, id, &mut path) {
            self.expanded.extend(path);
        }
        if self.selected.as_ref() != Some(id) {
            self.selected = Some(id.clone());
            cx.emit(Intent::Open(id.clone()));
        }
        cx.notify();
    }

    /// The id of the entry the main pane shows, if it shows one.
    pub fn opened(&self) -> Option<&str> {
        self.opened_entry().map(|data| data.read.entry.id.as_str())
    }

    fn opened_entry(&self) -> Option<&EntryData> {
        match &self.pane {
            Pane::Entry(load) => match load.as_ref() {
                Load::Ready(data) => Some(data),
                _ => None,
            },
            Pane::Search(_) => None,
        }
    }

    /// Puts the keyboard in the tree.
    pub fn focus_tree(&self, window: &mut Window, cx: &mut App) {
        window.focus(&self.tree_focus, cx);
    }

    fn on_intent(&self, cx: &mut Context<Self>) -> OnIntent {
        let viewer = cx.entity().downgrade();
        Rc::new(move |intent, _, cx| {
            viewer.update(cx, |_, cx| cx.emit(intent)).ok();
        })
    }

    /// The lines of the tree in the order they are shown: each top-level folder as a group with
    /// what it holds, then the entries filed nowhere; folded folders hide what they hold.
    fn lines(&self) -> Vec<Line> {
        fn walk(
            nodes: &[TreeNode],
            parent: Option<&SharedString>,
            expanded: &HashSet<SharedString>,
            lines: &mut Vec<Line>,
        ) {
            for node in nodes {
                lines.push(Line {
                    id: node.id.clone(),
                    parent: parent.cloned(),
                    folder: !node.children.is_empty(),
                });
                if expanded.contains(&node.id) {
                    walk(&node.children, Some(&node.id), expanded, lines);
                }
            }
        }
        let mut lines = Vec::new();
        for group in self.nodes.iter().filter(|node| !node.children.is_empty()) {
            lines.push(Line {
                id: group.id.clone(),
                parent: None,
                folder: false,
            });
            walk(&group.children, Some(&group.id), &self.expanded, &mut lines);
        }
        let loose: Vec<TreeNode> = self
            .nodes
            .iter()
            .filter(|node| node.children.is_empty())
            .cloned()
            .collect();
        walk(&loose, None, &self.expanded, &mut lines);
        lines
    }

    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        let lines = self.lines();
        let at = self
            .selected
            .as_ref()
            .and_then(|id| lines.iter().position(|line| &line.id == id));
        let next = match at {
            Some(at) => at
                .saturating_add_signed(by)
                .min(lines.len().saturating_sub(1)),
            None => 0,
        };
        if let Some(line) = lines.get(next) {
            let id = line.id.clone();
            self.select(&id, cx);
        }
    }

    fn fold(&mut self, open: bool, cx: &mut Context<Self>) {
        let lines = self.lines();
        let Some(line) = self
            .selected
            .as_ref()
            .and_then(|id| lines.iter().find(|line| &line.id == id))
        else {
            return;
        };
        let is_open = self.expanded.contains(&line.id);
        match (open, line.folder, is_open) {
            (true, true, false) => {
                self.expanded.insert(line.id.clone());
            }
            (true, true, true) => self.step(1, cx),
            (false, true, true) => {
                self.expanded.remove(&line.id);
            }
            (false, _, _) => {
                if let Some(parent) = line.parent.clone() {
                    self.select(&parent, cx);
                }
            }
            _ => {}
        }
        cx.notify();
    }

    /// A click on a line: it opens, and a folder folds or unfolds.
    fn clicked(&mut self, id: &SharedString, folder: bool, cx: &mut Context<Self>) {
        if folder && !self.expanded.remove(id) {
            self.expanded.insert(id.clone());
        }
        self.select(id, cx);
    }

    fn sidebar(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let (muted, primary, cyan, border) = (
            theme.muted_foreground,
            theme.primary,
            theme.cyan,
            theme.table_row_border,
        );
        let success = theme.success;
        let tree: AnyElement = match &self.tree_load {
            Load::Loading => v_flex()
                .px(space::M)
                .pt(space::S)
                .child(status::loading(6))
                .into_any_element(),
            Load::Empty => status::side_note(
                IconName::Inbox,
                "Aucune fiche",
                "Les fiches écrites par les agents apparaîtront ici.",
                false,
                cx,
            )
            .into_any_element(),
            Load::Failed(problem) => {
                let (title, detail) = match problem {
                    Problem::Unreachable => ("Hors ligne", "Le serveur ne répond pas."),
                    Problem::KeyRefused(_) => ("Clé refusée", "Demandez une nouvelle clé."),
                };
                status::side_note(IconName::TriangleAlert, title, detail, true, cx)
                    .into_any_element()
            }
            Load::Ready(()) => self.tree(window, cx),
        };
        let toggle = ghost(
            "sidebar-close",
            IconName::PanelLeft,
            None,
            "Replier",
            cx.listener(|viewer, _, _, cx| {
                viewer.sidebar_open = false;
                cx.notify();
            }),
            window,
            cx,
        );
        let content = v_flex()
            .w(width::SIDEBAR)
            .h_full()
            .flex_none()
            .px(space::M)
            .pt(space::M)
            .gap(space::S)
            .child(
                h_flex()
                    .h(px(36.))
                    .px(space::S)
                    .gap(space::S)
                    .child(div().size(px(20.)).rounded(px(6.)).bg(linear_gradient(
                        135.,
                        linear_color_stop(primary, 0.),
                        linear_color_stop(mix(primary, cyan, 0.55), 1.),
                    )))
                    .child(
                        div()
                            .flex_1()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Grenier"),
                    )
                    .child(toggle),
            )
            .child(
                Input::new(&self.search)
                    .prefix(Icon::new(IconName::Search).xsmall().text_color(muted))
                    .suffix(kbd(&["Ctrl", "K"], cx)),
            )
            .child(
                div()
                    .id("tree")
                    .flex_1()
                    .min_h_0()
                    .mx(-space::XS)
                    .pt(space::S)
                    .pb(space::L)
                    .track_focus(&self.tree_focus)
                    .key_context(TREE)
                    .on_action(cx.listener(|viewer, _: &SelectPrevious, _, cx| viewer.step(-1, cx)))
                    .on_action(cx.listener(|viewer, _: &SelectNext, _, cx| viewer.step(1, cx)))
                    .on_action(cx.listener(|viewer, _: &Collapse, _, cx| viewer.fold(false, cx)))
                    .on_action(cx.listener(|viewer, _: &Expand, _, cx| viewer.fold(true, cx)))
                    .overflow_y_scrollbar()
                    .child(tree),
            )
            .children(self.connection.clone().map(|name| {
                h_flex()
                    .gap(space::S)
                    .px(space::S)
                    .pt(space::S)
                    .pb(space::M)
                    .border_t_1()
                    .border_color(border)
                    .text_size(text::XS)
                    .text_color(muted)
                    .child(div().size(px(6.)).rounded_full().bg(success))
                    .child(format!("Connecté à {name}"))
            }));
        div()
            .h_full()
            .flex_none()
            .overflow_hidden()
            .child(content)
            .with_spring(
                "sidebar",
                SpringAnimation::new(SPRING).to(self.sidebar_open),
                |element, open| {
                    let open = open.0.clamp(0., 1.);
                    element.w(width::SIDEBAR * open).opacity(open)
                },
            )
            .into_any_element()
    }

    fn tree(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut groups: Vec<AnyElement> = Vec::new();
        for (index, group) in self
            .nodes
            .iter()
            .filter(|node| !node.children.is_empty())
            .enumerate()
        {
            let header = self.group_title(group, index == 0, window, cx);
            let items = self.items(&group.children, window, cx);
            groups.push(v_flex().child(header).children(items).into_any_element());
        }
        let loose: Vec<TreeNode> = self
            .nodes
            .iter()
            .filter(|node| node.children.is_empty())
            .cloned()
            .collect();
        if !loose.is_empty() {
            let items = self.items(&loose, window, cx);
            groups.push(
                v_flex()
                    .child(group_label("Sans dossier", groups.is_empty(), cx))
                    .children(items)
                    .into_any_element(),
            );
        }
        v_flex().children(groups).into_any_element()
    }

    /// The title of a group: the top-level folder, which opens like any entry.
    fn group_title(
        &self,
        group: &TreeNode,
        first: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let selected = self.selected.as_ref() == Some(&group.id);
        let theme = cx.theme();
        let (muted, foreground, accent) = (theme.muted_foreground, theme.foreground, theme.primary);
        let id = group.id.clone();
        let title = group.title.clone();
        let open = cx.listener(move |viewer, _: &ClickEvent, _, cx| viewer.select(&id, cx));
        hoverable(
            SharedString::from(format!("group-{}", group.id)),
            window,
            cx,
            move |element, hover| {
                element
                    .mt(if first { space::XS } else { space::L })
                    .px(space::M)
                    .pb(space::XS)
                    .text_size(text::XS)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(if selected {
                        accent
                    } else {
                        mix(muted, foreground, hover.0)
                    })
                    .cursor_pointer()
                    .on_click(open)
                    .child(title)
            },
        )
    }

    /// The lines of a list of entries, each folder followed by what it holds, which unfolds.
    fn items(
        &self,
        nodes: &[TreeNode],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let mut items = Vec::new();
        for node in nodes {
            let folder = !node.children.is_empty();
            let open = self.expanded.contains(&node.id);
            items.push(self.item(node, folder, open, window, cx));
            if folder {
                let children = self.items(&node.children, window, cx);
                let guide = cx.theme().border;
                items.push(
                    reveal(
                        SharedString::from(format!("under-{}", node.id)),
                        open,
                        v_flex()
                            .ml(px(19.))
                            .pl(space::XS)
                            .border_l_1()
                            .border_color(guide)
                            .children(children),
                    )
                    .into_any_element(),
                );
            }
        }
        items
    }

    fn item(
        &self,
        node: &TreeNode,
        folder: bool,
        open: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let selected = self.selected.as_ref() == Some(&node.id);
        let theme = cx.theme();
        let (muted, foreground, accent, over) = (
            theme.muted_foreground,
            theme.foreground,
            theme.primary,
            theme.accent,
        );
        let (tint, radius) = (theme::accent_tint(cx), theme.radius);
        let icon = match (folder, open) {
            (true, true) => IconName::FolderOpen,
            (true, false) => IconName::Folder,
            (false, _) => IconName::FileText,
        };
        let chevron = folder.then(|| {
            Icon::new(IconName::ChevronRight).xsmall().with_spring(
                SharedString::from(format!("chevron-{}", node.id)),
                SpringAnimation::new(SPRING).to(open),
                |icon, turn| icon.rotate(radians(turn.0 * FRAC_PI_2)),
            )
        });
        let id = node.id.clone();
        let click =
            cx.listener(move |viewer, _: &ClickEvent, _, cx| viewer.clicked(&id, folder, cx));
        let title = node.title.clone();
        hoverable(
            SharedString::from(format!("item-{}", node.id)),
            window,
            cx,
            move |element, hover| {
                let (bg, fg) = if selected {
                    (tint, accent)
                } else {
                    (over.opacity(hover.0), mix(muted, foreground, hover.0))
                };
                element
                    .h(width::ROW)
                    .mx(space::XS)
                    .px(space::M)
                    .flex()
                    .items_center()
                    .gap(space::S)
                    .rounded(radius)
                    .bg(bg)
                    .text_color(fg)
                    .cursor_pointer()
                    .on_click(click)
                    .child(Icon::new(icon).small())
                    .child(div().flex_1().min_w_0().truncate().child(title))
                    .children(chevron)
            },
        )
    }

    fn panel(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let on_intent = self.on_intent(cx);
        let pane = match self.pane.clone() {
            Pane::Entry(load) => {
                EntryScreen::new(*load, on_intent, self.scroll.clone(), self.shown)
                    .into_any_element()
            }
            Pane::Search(search) => {
                SearchScreen::new(search, on_intent, self.scroll.clone(), self.shown)
                    .into_any_element()
            }
        };
        let mut bar = h_flex().h(px(52.)).flex_none().px(space::L).gap(space::XS);
        if !self.sidebar_open {
            bar = bar.child(ghost(
                "sidebar-open",
                IconName::PanelLeft,
                None,
                "Déplier",
                cx.listener(|viewer, _, _, cx| {
                    viewer.sidebar_open = true;
                    cx.notify();
                }),
                window,
                cx,
            ));
        }
        bar = bar
            .child(ghost(
                "back",
                IconName::ArrowLeft,
                None,
                "Retour (Alt+←)",
                cx.listener(|_, _, _, cx| cx.emit(Intent::Back)),
                window,
                cx,
            ))
            .child(ghost(
                "forward",
                IconName::ArrowRight,
                None,
                "Avancer (Alt+→)",
                cx.listener(|_, _, _, cx| cx.emit(Intent::Forward)),
                window,
                cx,
            ))
            .child(div().flex_1());
        if let Some(slug) = self.opened_entry().map(|data| data.read.entry.slug.clone()) {
            let link = format!("grenier://{slug}");
            bar = bar
                .child(ghost(
                    "copy-link",
                    IconName::Link,
                    Some("Copier le lien"),
                    "Copier le lien de la fiche",
                    move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(link.clone())),
                    window,
                    cx,
                ))
                .child(ghost(
                    "open-in-api",
                    IconName::ExternalLink,
                    Some("Ouvrir dans l'API"),
                    "La fiche telle que l'API la renvoie",
                    cx.listener(move |_, _, _, cx| cx.emit(Intent::OpenInApi(slug.clone().into()))),
                    window,
                    cx,
                ));
        }
        let theme = cx.theme();
        v_flex()
            .flex_1()
            .min_w_0()
            .m(space::S)
            .when(self.sidebar_open, |panel| panel.ml_0())
            .rounded(px(16.))
            .border_1()
            .border_color(theme.border)
            .bg(theme.background)
            .overflow_hidden()
            .child(bar)
            .child(div().flex_1().min_h_0().child(pane))
            .into_any_element()
    }
}

/// The path from the top of the tree to `id`, its ancestors only; whether `id` was found.
fn path_to(nodes: &[TreeNode], id: &SharedString, path: &mut Vec<SharedString>) -> bool {
    for node in nodes {
        if &node.id == id {
            return true;
        }
        path.push(node.id.clone());
        if path_to(&node.children, id, path) {
            return true;
        }
        path.pop();
    }
    false
}

/// A group label that is no entry: the entries filed nowhere.
fn group_label(label: &'static str, first: bool, cx: &App) -> Div {
    div()
        .mt(if first { space::XS } else { space::L })
        .px(space::M)
        .pb(space::XS)
        .text_size(text::XS)
        .font_weight(FontWeight::MEDIUM)
        .text_color(cx.theme().muted_foreground)
        .child(label)
}

/// Keys as the keyboard shows them.
fn kbd(keys: &[&'static str], cx: &App) -> Div {
    let theme = cx.theme();
    h_flex().gap(px(3.)).children(keys.iter().map(|key| {
        div()
            .px(px(5.))
            .rounded(px(4.))
            .border_1()
            .border_color(theme.border)
            .bg(theme.muted)
            .text_size(px(11.))
            .text_color(theme.muted_foreground)
            .child(*key)
    }))
}

/// A quiet button: an icon, a label when it needs one, and a hint under the pointer.
fn ghost(
    id: &'static str,
    icon: IconName,
    label: Option<&'static str>,
    hint: &'static str,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
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
    hoverable(
        ElementId::Name(id.into()),
        window,
        cx,
        move |element, hover| {
            element
                .h(px(30.))
                .min_w(px(30.))
                .px(if label.is_some() { px(10.) } else { px(0.) })
                .flex()
                .items_center()
                .justify_center()
                .gap(px(6.))
                .rounded(radius)
                .bg(over.opacity(hover.0))
                .text_color(mix(muted, foreground, hover.0))
                .cursor_pointer()
                .tooltip(move |window, cx| Tooltip::new(hint).build(window, cx))
                .on_click(on_click)
                .child(Icon::new(icon).xsmall())
                .children(label)
        },
    )
}

impl Render for Viewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (page, foreground) = (theme.sidebar, theme.foreground);
        let sidebar = self.sidebar(window, cx);
        let panel = self.panel(window, cx);
        div()
            .flex()
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
            .bg(page)
            .text_color(foreground)
            .text_size(text::BODY)
            .child(sidebar)
            .child(panel)
    }
}
