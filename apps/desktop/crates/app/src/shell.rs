//! The viewer fed by a server: it turns what the user asks for into requests, keeps what was
//! opened for back and forward, and gives the screens the answers, or the problem.

use std::collections::HashMap;

use api::{TreeEntry, TreePlace, TypeDefinition};
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, Render, SharedString, Subscription, Task,
    Window, WindowAppearance, px,
};
use ui::entry::EntryData;
use ui::intent::Intent;
use ui::intent::ListFilter;
use ui::list::ListData;
use ui::load::{Load, Problem};
use ui::search::SearchData;
use ui::theme::ThemeChoice;
use ui::viewer::{Pane, TreeNode, Viewer};

use crate::client::Client;
use crate::config;

/// What the pane shows, as the history keeps it.
#[derive(Clone, Debug, PartialEq)]
enum Location {
    Entry(SharedString),
    Search {
        query: SharedString,
        type_name: Option<SharedString>,
    },
    List(ListFilter),
}

pub struct Shell {
    viewer: Entity<Viewer>,
    client: Option<Client>,
    types: Vec<TypeDefinition>,
    /// The heading the next entry opened glides to, named by the reference that opens it.
    jump: Option<SharedString>,
    history: Vec<Location>,
    at: usize,
    // A request replaced by another is dropped, and so cancelled: a late answer never shows.
    tree_request: Option<Task<()>>,
    pane_request: Option<Task<()>>,
    history_request: Option<Task<()>>,
    /// Where the history of the open entry continues, when it does.
    history_cursor: Option<String>,
    /// Where the listing shown continues, when it does.
    list_cursor: Option<String>,
    _intents: Subscription,
}

impl Shell {
    /// The viewer on the server of `client`, or saying what to set up.
    pub fn new(
        client: Result<Client, String>,
        preferences: &config::Preferences,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let viewer = cx.new(|cx| {
            let mut viewer = Viewer::new(window, cx);
            if let Some(width) = preferences.sidebar_width {
                viewer.set_sidebar_width(px(width as f32), cx);
            }
            let choice = ThemeChoice::from_name(preferences.theme.as_deref().unwrap_or(""));
            viewer.set_theme_choice(choice, cx);
            viewer
        });
        let intents = cx.subscribe_in(&viewer, window, |shell, _, intent: &Intent, window, cx| {
            shell.asked(intent.clone(), window, cx)
        });
        let mut shell = Self {
            viewer,
            client: None,
            types: Vec::new(),
            jump: None,
            history: Vec::new(),
            at: 0,
            tree_request: None,
            pane_request: None,
            history_request: None,
            history_cursor: None,
            list_cursor: None,
            _intents: intents,
        };
        match client {
            Ok(client) => {
                let host = client
                    .server()
                    .split("://")
                    .last()
                    .unwrap_or_default()
                    .to_string();
                shell.viewer.update(cx, |viewer, cx| {
                    viewer.set_connection(Some(host.into()), cx);
                    viewer.set_version(crate::VERSION.into(), cx);
                });
                shell.client = Some(client);
                shell.load_tree(window, cx);
            }
            Err(sentence) => {
                let problem = Problem::Unconfigured(sentence.into());
                shell.viewer.update(cx, |viewer, cx| {
                    viewer.set_tree(Load::Failed(problem.clone()), cx);
                    viewer.set_pane(Pane::Entry(Box::new(Load::Failed(problem))), window, cx);
                });
            }
        }
        shell
    }

    /// The viewer it feeds.
    pub fn viewer(&self) -> &Entity<Viewer> {
        &self.viewer
    }

    fn asked(&mut self, intent: Intent, window: &mut Window, cx: &mut Context<Self>) {
        match intent {
            Intent::Open(entry) => self.go(Location::Entry(entry), window, cx),
            Intent::OpenAt { entry, heading } => {
                self.jump = Some(heading);
                self.go(Location::Entry(entry), window, cx);
            }
            Intent::Search { query, type_name } => {
                self.go(Location::Search { query, type_name }, window, cx)
            }
            Intent::OpenUrl(url) => cx.open_url(&url),
            Intent::Back if self.at > 0 => {
                self.at -= 1;
                self.show(window, cx);
            }
            Intent::Forward if self.at + 1 < self.history.len() => {
                self.at += 1;
                self.show(window, cx);
            }
            Intent::Back | Intent::Forward => {}
            Intent::SidebarWidth(width) => config::remember("sidebar_width", width.into()),
            Intent::Theme(choice) => {
                config::remember("theme", choice.name().into());
                let system_dark = matches!(
                    window.appearance(),
                    WindowAppearance::Dark | WindowAppearance::VibrantDark
                );
                ui::theme::set_dark(choice.is_dark(system_dark), cx);
                window.refresh();
            }
            // No filter left: the listing closes, back to what was open before it.
            Intent::List(filter) if filter.is_empty() => {
                if self.at > 0 {
                    self.at -= 1;
                    self.show(window, cx);
                } else {
                    self.set_pane(Pane::Entry(Box::new(Load::Empty)), window, cx);
                }
            }
            Intent::List(filter) => self.go(Location::List(filter), window, cx),
            Intent::MoreListed => self.load_more_listed(window, cx),
            Intent::History => self.load_history(window, cx),
            // The viewer keeps its groups of links itself.
            Intent::ToggleLinks(_) => {}
            Intent::Retry => {
                self.load_tree(window, cx);
                if !self.history.is_empty() {
                    self.show(window, cx);
                }
            }
        }
    }

    /// Reads the next page of the listing shown, after the last one, and adds it.
    fn load_more_listed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(client), Some(cursor)) = (self.client.clone(), self.list_cursor.clone()) else {
            return;
        };
        let Some(Location::List(filter)) = self.history.get(self.at).cloned() else {
            return;
        };
        let request = cx
            .background_executor()
            .spawn(async move { client.list(&filter, Some(&cursor)) });
        self.pane_request = Some(cx.spawn_in(window, async move |shell, cx| {
            let answer = request.await;
            shell
                .update_in(cx, |shell, _, cx| match answer {
                    Ok((found, next)) => {
                        let more = next.is_some();
                        shell.list_cursor = next;
                        shell.viewer.update(cx, |viewer, cx| {
                            viewer.update_list(
                                |list| {
                                    list.more = more;
                                    if let Load::Ready(entries) = &mut list.entries {
                                        entries.extend(found);
                                    }
                                },
                                cx,
                            )
                        });
                    }
                    Err(problem) => shell.viewer.update(cx, |viewer, cx| {
                        viewer.update_list(|list| list.entries = Load::Failed(problem), cx)
                    }),
                })
                .ok();
        }));
    }

    /// Reads the history of the open entry: its first page, or the page after the one shown.
    fn load_history(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let Some((entry, older)) = self.viewer.read(cx).entry().map(|data| {
            (
                data.read.entry.id.clone(),
                matches!(data.history, Load::Ready(_)),
            )
        }) else {
            return;
        };
        let cursor = if older {
            self.history_cursor.clone()
        } else {
            None
        };
        if older && cursor.is_none() {
            return;
        }
        if !older {
            self.viewer.update(cx, |viewer, cx| {
                viewer.update_entry(|data| data.history = Load::Loading, cx)
            });
        }
        let entry_id = entry.clone();
        let request = cx
            .background_executor()
            .spawn(async move { client.history(&entry, cursor.as_deref()) });
        self.history_request = Some(cx.spawn_in(window, async move |shell, cx| {
            let answer = request.await;
            shell
                .update_in(cx, |shell, _, cx| {
                    // Another entry opened in the meantime: this history is not its own.
                    let still = shell
                        .viewer
                        .read(cx)
                        .entry()
                        .map(|data| data.read.entry.id.clone());
                    if still.as_deref() != Some(entry_id.as_str()) {
                        return;
                    }
                    shell.history_cursor = answer
                        .as_ref()
                        .ok()
                        .and_then(|page| page.next_cursor.clone());
                    shell.viewer.update(cx, |viewer, cx| {
                        viewer.update_entry(
                            |data| match answer {
                                Ok(page) => {
                                    data.more_history = page.next_cursor.is_some();
                                    data.history =
                                        match std::mem::replace(&mut data.history, Load::Loading) {
                                            Load::Ready(mut shown) if older => {
                                                shown.extend(page.events);
                                                Load::Ready(shown)
                                            }
                                            _ => Load::Ready(page.events),
                                        };
                                }
                                Err(problem) => data.history = Load::Failed(problem),
                            },
                            cx,
                        )
                    });
                })
                .ok();
        }));
    }

    /// Opens `location`, after what is open now: what was opened from there is forgotten.
    fn go(&mut self, location: Location, window: &mut Window, cx: &mut Context<Self>) {
        if self.history.get(self.at) != Some(&location) {
            self.history.truncate(self.at + 1);
            self.history.push(location);
            self.at = self.history.len() - 1;
        }
        self.show(window, cx);
    }

    fn show(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(client), Some(location)) = (self.client.clone(), self.history.get(self.at))
        else {
            return;
        };
        match location.clone() {
            Location::Entry(entry) => {
                let jump = self.jump.take();
                // A history still on its way is the previous entry's: dropped.
                self.history_request = None;
                self.history_cursor = None;
                self.set_pane(Pane::Entry(Box::new(Load::Loading)), window, cx);
                let request = cx
                    .background_executor()
                    .spawn(async move { client.read(&entry) });
                self.pane_request = Some(cx.spawn_in(window, async move |shell, cx| {
                    let answer = request.await;
                    shell
                        .update_in(cx, |shell, window, cx| {
                            let load = match answer {
                                Ok(read) => {
                                    let id: SharedString = read.entry.id.clone().into();
                                    shell.viewer.update(cx, |viewer, cx| viewer.reveal(&id, cx));
                                    let type_definition = shell
                                        .types
                                        .iter()
                                        .find(|definition| definition.name == read.entry.type_)
                                        .cloned();
                                    Load::Ready(EntryData {
                                        read,
                                        type_definition,
                                        history: Load::Empty,
                                        more_history: false,
                                    })
                                }
                                Err(problem) => Load::Failed(problem),
                            };
                            let ready = matches!(load, Load::Ready(_));
                            shell.set_pane(Pane::Entry(Box::new(load)), window, cx);
                            if let (true, Some(heading)) = (ready, jump) {
                                shell
                                    .viewer
                                    .update(cx, |viewer, cx| viewer.jump_to(heading, cx));
                            }
                        })
                        .ok();
                }));
            }
            Location::List(filter) => {
                let type_labels: HashMap<String, String> = self
                    .types
                    .iter()
                    .map(|definition| (definition.name.clone(), definition.label.to_string()))
                    .collect();
                let listed = {
                    let filter = filter.clone();
                    move |entries, more| {
                        Pane::List(ListData {
                            filter: filter.clone(),
                            type_labels: type_labels.clone(),
                            entries,
                            more,
                        })
                    }
                };
                self.set_pane(listed(Load::Loading, false), window, cx);
                self.list_cursor = None;
                let request = cx
                    .background_executor()
                    .spawn(async move { client.list(&filter, None) });
                self.pane_request = Some(cx.spawn_in(window, async move |shell, cx| {
                    let (entries, next) = match request.await {
                        Ok((found, _)) if found.is_empty() => (Load::Empty, None),
                        Ok((found, next)) => (Load::Ready(found), next),
                        Err(problem) => (Load::Failed(problem), None),
                    };
                    shell
                        .update_in(cx, |shell, window, cx| {
                            let more = next.is_some();
                            shell.list_cursor = next;
                            shell.set_pane(listed(entries, more), window, cx)
                        })
                        .ok();
                }));
            }
            Location::Search { query, type_name } => {
                let types: Vec<SharedString> = self
                    .types
                    .iter()
                    .map(|definition| definition.name.clone().into())
                    .collect();
                let (text, only) = (
                    query.to_string(),
                    type_name.as_ref().map(|name| name.to_string()),
                );
                let search = move |results| {
                    Pane::Search(SearchData {
                        query: query.clone(),
                        types: types.clone(),
                        type_name: type_name.clone(),
                        results,
                    })
                };
                self.set_pane(search(Load::Loading), window, cx);
                let request = cx
                    .background_executor()
                    .spawn(async move { client.search(&text, only.as_deref()) });
                self.pane_request = Some(cx.spawn_in(window, async move |shell, cx| {
                    let results = match request.await {
                        Ok(found) if found.is_empty() => Load::Empty,
                        Ok(found) => Load::Ready(found),
                        Err(problem) => Load::Failed(problem),
                    };
                    shell
                        .update_in(cx, |shell, window, cx| {
                            shell.set_pane(search(results), window, cx)
                        })
                        .ok();
                }));
            }
        }
    }

    fn set_pane(&self, pane: Pane, window: &mut Window, cx: &mut Context<Self>) {
        self.viewer
            .update(cx, |viewer, cx| viewer.set_pane(pane, window, cx));
    }

    /// The types and the tree, read again.
    fn load_tree(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        self.viewer
            .update(cx, |viewer, cx| viewer.set_tree(Load::Loading, cx));
        let request = cx
            .background_executor()
            .spawn(async move { client.types().and_then(|types| Ok((types, client.tree()?))) });
        self.tree_request = Some(cx.spawn_in(window, async move |shell, cx| {
            let answer = request.await;
            shell
                .update(cx, |shell, cx| {
                    let load = match answer {
                        Ok((types, tree)) => {
                            shell.types = types;
                            let nodes = tree_of(&tree);
                            if nodes.is_empty() {
                                Load::Empty
                            } else {
                                Load::Ready(nodes)
                            }
                        }
                        Err(problem) => Load::Failed(problem),
                    };
                    shell
                        .viewer
                        .update(cx, |viewer, cx| viewer.set_tree(load, cx));
                })
                .ok();
        }));
    }
}

/// The tree from its entries: each under every place it is part of, by title as the server gives
/// them, so that an entry with two places is drawn under both. An entry none of whose places this
/// key sees stands at the top, so that none goes missing. A part of its whole (`in_parent`) is read
/// in the whole's page, not listed under it; what is filed under such a part goes under the whole.
pub fn tree_of(entries: &[TreeEntry]) -> Vec<TreeNode> {
    let by_id: HashMap<&str, &TreeEntry> = entries
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();
    /// The places of an entry this key sees, the oldest first.
    fn seen<'a>(entry: &'a TreeEntry, by_id: &HashMap<&str, &TreeEntry>) -> Vec<&'a TreePlace> {
        entry
            .part_of
            .iter()
            .filter(|place| by_id.contains_key(place.id.as_str()))
            .collect()
    }
    /// Whether the tree lists no branch for an entry: it is read in the page of each of its places.
    fn is_part(entry: &TreeEntry, by_id: &HashMap<&str, &TreeEntry>) -> bool {
        let places = seen(entry, by_id);
        !places.is_empty() && places.iter().all(|place| place.in_parent)
    }
    /// Where what is filed under an entry stands in the tree: under the entry itself, or, when the
    /// tree lists no branch for it, under the wholes it is read in.
    fn stands<'a>(
        id: &'a str,
        by_id: &HashMap<&'a str, &'a TreeEntry>,
        chain: &mut Vec<&'a str>,
    ) -> Vec<&'a str> {
        let entry = by_id[id];
        if !is_part(entry, by_id) {
            return vec![id];
        }
        let mut found: Vec<&str> = Vec::new();
        chain.push(id);
        for place in seen(entry, by_id) {
            if chain.contains(&place.id.as_str()) {
                continue;
            }
            for home in stands(place.id.as_str(), by_id, chain) {
                if !found.contains(&home) {
                    found.push(home);
                }
            }
        }
        chain.pop();
        found
    }
    /// The entries to draw an entry under (`None` is the top): its places that list it.
    fn homes<'a>(
        entry: &'a TreeEntry,
        by_id: &HashMap<&'a str, &'a TreeEntry>,
    ) -> Vec<Option<&'a str>> {
        let places = seen(entry, by_id);
        if places.is_empty() {
            return vec![None];
        }
        let mut found: Vec<Option<&str>> = Vec::new();
        for place in places.iter().filter(|place| !place.in_parent) {
            for home in stands(place.id.as_str(), by_id, &mut Vec::new()) {
                if !found.contains(&Some(home)) {
                    found.push(Some(home));
                }
            }
        }
        found
    }
    let mut under: HashMap<Option<&str>, Vec<&TreeEntry>> = HashMap::new();
    for entry in entries {
        if is_part(entry, &by_id) {
            continue;
        }
        for home in homes(entry, &by_id) {
            under.entry(home).or_default().push(entry);
        }
    }
    fn build<'a>(
        parent: Option<&'a str>,
        under: &HashMap<Option<&'a str>, Vec<&'a TreeEntry>>,
        chain: &mut Vec<&'a str>,
    ) -> Vec<TreeNode> {
        let mut nodes = Vec::new();
        for entry in under.get(&parent).into_iter().flatten().copied() {
            // A loop among the places, which the server refuses, is never drawn.
            if chain.contains(&entry.id.as_str()) {
                continue;
            }
            chain.push(entry.id.as_str());
            let children = build(Some(&entry.id), under, chain);
            chain.pop();
            nodes.push(TreeNode {
                id: entry.id.clone().into(),
                title: entry.title.clone().into(),
                type_name: entry.type_.clone().into(),
                archived: false,
                children,
            });
        }
        nodes
    }
    build(None, &under, &mut Vec::new())
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.viewer.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::tree_of;
    use api::{TreeEntry, TreePlace};
    use ui::viewer::TreeNode;

    /// The tree as (entry, entries below it), one level.
    fn shape(tree: &[TreeNode]) -> Vec<(&str, Vec<&str>)> {
        tree.iter()
            .map(|node| {
                (
                    node.id.as_ref(),
                    node.children
                        .iter()
                        .map(|child| child.id.as_ref())
                        .collect(),
                )
            })
            .collect()
    }

    fn place(id: &str, in_parent: bool) -> TreePlace {
        TreePlace {
            id: id.into(),
            in_parent,
        }
    }

    fn entry(id: &str, places: Vec<TreePlace>) -> TreeEntry {
        TreeEntry {
            id: id.into(),
            slug: id.into(),
            title: id.into(),
            type_: "note".into(),
            part_of: places,
        }
    }

    #[test]
    fn the_children_of_a_part_are_filed_under_the_whole_it_belongs_to() {
        let tree = tree_of(&[
            entry("computer", vec![]),
            entry("disk", vec![place("computer", true)]),
            entry("disk-manual", vec![place("disk", false)]),
        ]);
        assert_eq!(shape(&tree), vec![("computer", vec!["disk-manual"])]);
    }

    #[test]
    fn each_entry_goes_under_its_place_and_one_whose_place_is_unseen_stands_at_the_top() {
        let tree = tree_of(&[
            entry("kitchen", vec![]),
            entry("plum-tart", vec![place("kitchen", false)]),
            entry("diary-page", vec![place("hidden-diary", false)]),
        ]);
        assert_eq!(
            shape(&tree),
            vec![("kitchen", vec!["plum-tart"]), ("diary-page", vec![])]
        );
    }

    #[test]
    fn an_entry_with_two_places_is_drawn_under_both() {
        let tree = tree_of(&[
            entry("desktop", vec![]),
            entry("laptop", vec![]),
            entry(
                "monitor",
                vec![place("desktop", false), place("laptop", false)],
            ),
        ]);
        assert_eq!(
            shape(&tree),
            vec![("desktop", vec!["monitor"]), ("laptop", vec!["monitor"])]
        );
    }

    #[test]
    fn an_entry_with_a_hidden_place_and_a_seen_one_is_drawn_under_the_seen_one_only() {
        let tree = tree_of(&[
            entry("laptop", vec![]),
            entry(
                "monitor",
                vec![place("hidden-diary", false), place("laptop", false)],
            ),
        ]);
        assert_eq!(shape(&tree), vec![("laptop", vec!["monitor"])]);
    }

    #[test]
    fn an_entry_read_in_one_whole_and_filed_under_another_is_drawn_under_the_second_only() {
        let tree = tree_of(&[
            entry("computer", vec![]),
            entry("shelf", vec![]),
            entry("fan", vec![place("computer", true), place("shelf", false)]),
        ]);
        assert_eq!(
            shape(&tree),
            vec![("computer", vec![]), ("shelf", vec!["fan"])]
        );
    }

    #[test]
    fn what_is_filed_under_a_part_goes_under_every_whole_the_part_is_read_in() {
        let tree = tree_of(&[
            entry("desktop", vec![]),
            entry("laptop", vec![]),
            entry(
                "monitor",
                vec![place("desktop", true), place("laptop", true)],
            ),
            entry("stand", vec![place("monitor", false)]),
        ]);
        assert_eq!(
            shape(&tree),
            vec![("desktop", vec!["stand"]), ("laptop", vec!["stand"])]
        );
    }

    #[test]
    fn a_loop_among_the_places_hangs_nothing() {
        let tree = tree_of(&[
            entry("east", vec![place("west", false)]),
            entry("west", vec![place("east", false)]),
            entry("lone", vec![]),
        ]);
        assert_eq!(shape(&tree), vec![("lone", vec![])]);
    }
}
