//! The gallery of the viewer's screens: every screen in every state, with invented data, without
//! a server. A sidebar lists the stories, a switch toggles light and dark, and
//! `cargo run -p story -- --story <name>` opens one story directly, for a screenshot.

pub mod fixtures;

use gpui_kit::component::list::ListItem;
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{ActiveTheme as _, v_flex};
use gpui_kit::{
    AnyView, App, AppContext as _, Context, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Window, div, px,
};
use ui::load::{Load, Problem};
use ui::search::SearchData;
use ui::theme::{self, space, text};
use ui::viewer::{Pane, TreeNode, Viewer};

/// One screen in one state.
pub struct Story {
    /// Its name, `screen/state`: what `--story` takes.
    pub name: &'static str,
    build: fn(&mut Window, &mut App) -> AnyView,
}

fn refused() -> Problem {
    Problem::KeyRefused("This key was revoked: ask the owner of Grenier for a new one.".into())
}

/// A viewer showing that tree and that pane.
fn viewer(
    tree: Load<Vec<TreeNode>>,
    selected: Option<&'static str>,
    pane: Pane,
    window: &mut Window,
    cx: &mut App,
) -> AnyView {
    cx.new(|cx| {
        let mut viewer = Viewer::new(window, cx);
        viewer.set_tree(tree, cx);
        viewer.set_connection(Some("grenier.local".into()), cx);
        viewer.set_pane(pane, window, cx);
        if let Some(id) = selected {
            viewer.select(&id.into(), cx);
        }
        viewer
    })
    .into()
}

fn search(results: Load<Vec<api::SearchResult>>, type_name: Option<&str>) -> Pane {
    Pane::Search(SearchData {
        query: "fibre".into(),
        types: fixtures::types(),
        type_name: type_name.map(|name| name.to_string().into()),
        results,
    })
}

/// Every story, in the order of the sidebar.
pub fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "viewer/entry",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    Some("fibre-maison"),
                    Pane::Entry(Box::new(Load::Ready(fixtures::contract()))),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "viewer/parts",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    Pane::Entry(Box::new(Load::Ready(fixtures::machine()))),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "viewer/search",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    search(Load::Ready(fixtures::results(4)), None),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "viewer/nothing-open",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    Pane::Entry(Box::new(Load::Empty)),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "tree/deep-and-long",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::deep_tree()),
                    Some("niveau-8"),
                    Pane::Entry(Box::new(Load::Ready(fixtures::bare()))),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "tree/long-titles",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::long_titles_tree()),
                    Some("contrat-technique-1"),
                    Pane::Entry(Box::new(Load::Ready(fixtures::bare()))),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "tree/empty",
            build: |window, cx| {
                viewer(
                    Load::Empty,
                    None,
                    Pane::Entry(Box::new(Load::Empty)),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "tree/loading",
            build: |window, cx| {
                viewer(
                    Load::Loading,
                    None,
                    Pane::Entry(Box::new(Load::Loading)),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "tree/unreachable",
            build: |window, cx| {
                viewer(
                    Load::Failed(Problem::Unreachable),
                    None,
                    Pane::Entry(Box::new(Load::Failed(Problem::Unreachable))),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "tree/key-refused",
            build: |window, cx| {
                viewer(
                    Load::Failed(refused()),
                    None,
                    Pane::Entry(Box::new(Load::Failed(refused()))),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "entry/relations",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    Pane::Entry(Box::new(Load::Ready(fixtures::person()))),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "entry/supposed",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    Some("fibre-maison"),
                    Pane::Entry(Box::new(Load::Ready(fixtures::supposed()))),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "entry/many-links",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::long_titles_tree()),
                    Some("phare"),
                    Pane::Entry(Box::new(Load::Ready(fixtures::many_links()))),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "entry/many-links-open",
            build: |window, cx| {
                cx.new(|cx| {
                    let mut viewer = Viewer::new(window, cx);
                    viewer.set_tree(Load::Ready(fixtures::long_titles_tree()), cx);
                    viewer.set_connection(Some("grenier.local".into()), cx);
                    viewer.set_pane(
                        Pane::Entry(Box::new(Load::Ready(fixtures::many_links()))),
                        window,
                        cx,
                    );
                    viewer.toggle_links("in-mentions".into(), window, cx);
                    viewer
                })
                .into()
            },
        },
        Story {
            name: "entry/history",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    Some("fibre-maison"),
                    Pane::Entry(Box::new(Load::Ready(fixtures::with_history()))),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "entry/bare",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    Some("idee"),
                    Pane::Entry(Box::new(Load::Ready(fixtures::bare()))),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "entry/long",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    Pane::Entry(Box::new(Load::Ready(fixtures::long()))),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "entry/loading",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    Pane::Entry(Box::new(Load::Loading)),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "entry/unreachable",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    Pane::Entry(Box::new(Load::Failed(Problem::Unreachable))),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "entry/key-refused",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    Pane::Entry(Box::new(Load::Failed(refused()))),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "results/filtered",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    Pane::List(fixtures::listed()),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "results/supposed",
            build: |window, cx| {
                let mut listed = fixtures::listed();
                listed.filter = ui::intent::ListFilter {
                    supposed: true,
                    ..ui::intent::ListFilter::default()
                };
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    Pane::List(listed),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "search/filtered",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    search(Load::Ready(fixtures::results(1)), Some("contract")),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "search/many",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    search(Load::Ready(fixtures::results(40)), None),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "search/nothing-found",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    search(Load::Empty, None),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "search/loading",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    search(Load::Loading, None),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "search/unreachable",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    search(Load::Failed(Problem::Unreachable), None),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "search/key-refused",
            build: |window, cx| {
                viewer(
                    Load::Ready(fixtures::tree()),
                    None,
                    search(Load::Failed(refused()), None),
                    window,
                    cx,
                )
            },
        },
        Story {
            name: "theme/typography",
            build: |_, cx| cx.new(|_| Typography).into(),
        },
    ]
}

/// The two families of the viewer at every size of its type scale, with the letters French needs.
struct Typography;

impl Render for Typography {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        const SAMPLE: &str = "Mémoire du grenier : « l’œuvre à ranger », déjà vue, çà et là.";
        let sizes = [
            ("TITLE", text::TITLE),
            ("HEADING", text::HEADING),
            ("SUBHEADING", text::SUBHEADING),
            ("LEAD", text::LEAD),
            ("PROSE", text::PROSE),
            ("BODY", text::BODY),
            ("SMALL", text::SMALL),
            ("XS", text::XS),
        ];
        let theme = cx.theme();
        let family = |name: &'static str, family: &'static str| {
            v_flex()
                .gap(space::M)
                .child(
                    div()
                        .text_size(text::SMALL)
                        .text_color(theme.muted_foreground)
                        .child(format!("{name} — {family}")),
                )
                .children(sizes.iter().map(|(label, size)| {
                    div()
                        .flex()
                        .items_baseline()
                        .gap(space::L)
                        .child(
                            div()
                                .w(px(96.))
                                .flex_none()
                                .text_size(text::XS)
                                .text_color(theme.muted_foreground)
                                .child(format!("{label} {}", f32::from(*size))),
                        )
                        .child(div().font_family(family).text_size(*size).child(SAMPLE))
                }))
                .child(
                    div()
                        .flex()
                        .gap(space::L)
                        .font_family(family)
                        .text_size(text::LEAD)
                        .child(div().font_weight(FontWeight::NORMAL).child("Normal"))
                        .child(div().font_weight(FontWeight::MEDIUM).child("Medium"))
                        .child(div().font_weight(FontWeight::SEMIBOLD).child("Semibold"))
                        .child(div().font_weight(FontWeight::BOLD).child("Bold"))
                        .child(div().italic().child("Italique")),
                )
        };
        v_flex()
            .size_full()
            .p(space::XXL)
            .gap(space::XXL)
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(family("Texte", theme::font::TEXT))
            .child(family("Titres", theme::font::HEADING))
    }
}

/// The gallery: the list of stories, the one shown, and light or dark.
pub struct Gallery {
    stories: Vec<Story>,
    shown: &'static str,
    view: Option<AnyView>,
}

impl Gallery {
    /// The gallery, showing `shown` when it names a story, else the first one.
    pub fn new(shown: Option<&str>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let stories = stories();
        let shown = shown
            .and_then(|name| stories.iter().find(|story| story.name == name))
            .or(stories.first())
            .map_or("", |story| story.name);
        let mut gallery = Self {
            stories,
            shown: "",
            view: None,
        };
        gallery.show(shown, window, cx);
        gallery
    }

    /// The name of the story shown.
    pub fn shown(&self) -> &'static str {
        self.shown
    }

    /// Shows the story of that name.
    pub fn show(&mut self, name: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        self.shown = name;
        self.view = self
            .stories
            .iter()
            .find(|story| story.name == name)
            .map(|story| (story.build)(window, cx));
        cx.notify();
    }
}

impl Render for Gallery {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dark = theme::is_dark(cx);
        let muted = cx.theme().muted_foreground;
        // The stories grouped by screen, in the order they come.
        let mut groups: Vec<(&'static str, Vec<&'static str>)> = Vec::new();
        for story in &self.stories {
            let (screen, _) = story.name.split_once('/').unwrap_or((story.name, ""));
            match groups.last_mut() {
                Some((last, names)) if *last == screen => names.push(story.name),
                _ => groups.push((screen, vec![story.name])),
            }
        }
        let shown = self.shown;
        let list =
            groups.into_iter().map(|(screen, names)| {
                v_flex()
                    .gap(px(1.))
                    .child(
                        div()
                            .px(space::S)
                            .pt(space::M)
                            .pb(space::XS)
                            .text_size(text::SMALL)
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(muted)
                            .child(screen.to_uppercase()),
                    )
                    .children(names.into_iter().map(|name| {
                        let state = name.split_once('/').map_or(name, |(_, state)| state);
                        ListItem::new(SharedString::from(name))
                            .selected(name == shown)
                            .px(space::S)
                            .py(px(3.))
                            .child(state)
                            .on_click(cx.listener(move |gallery, _, window, cx| {
                                gallery.show(name, window, cx)
                            }))
                    }))
            });
        div()
            .size_full()
            .flex()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .text_size(text::BODY)
            .child(
                v_flex()
                    .id("stories")
                    .w(px(200.))
                    .h_full()
                    .flex_none()
                    .p(space::S)
                    .border_r_1()
                    .border_color(cx.theme().border)
                    .overflow_y_scrollbar()
                    .child(
                        div()
                            .px(space::S)
                            .pt(space::S)
                            .text_size(text::HEADING)
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Gallery"),
                    )
                    .child(
                        div().px(space::S).pt(space::S).child(
                            Switch::new("dark")
                                .label("Dark")
                                .checked(dark)
                                .on_change(cx.listener(|_, dark: &bool, _, cx| {
                                    theme::set_dark(*dark, cx);
                                    cx.notify();
                                })),
                        ),
                    )
                    .children(list),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .children(self.view.clone()),
            )
    }
}
