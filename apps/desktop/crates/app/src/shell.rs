//! The viewer fed by a server: it turns what the user asks for into requests, keeps what was
//! opened for back and forward, and gives the screens the answers, or the problem.

use std::collections::HashMap;

use api::{TreeEntry, TypeDefinition};
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

/// The tree from its entries: each under its parent, by title as the server gives them; an entry
/// whose parent this key does not see stands at the top, so that none goes missing. A part of its
/// parent (`in_parent`) is read in the parent's page, not listed under it.
pub fn tree_of(entries: &[TreeEntry]) -> Vec<TreeNode> {
    let by_id: HashMap<&str, &TreeEntry> = entries
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();
    let mut under: HashMap<Option<&str>, Vec<&TreeEntry>> = HashMap::new();
    for entry in entries {
        let parent = entry
            .parent_id
            .as_deref()
            .filter(|parent| by_id.contains_key(parent));
        if entry.in_parent && parent.is_some() {
            continue;
        }
        // An entry filed under a part, which the tree does not list, goes under the whole.
        let mut parent = parent;
        while let Some(part) = parent
            .and_then(|id| by_id.get(id))
            .filter(|part| part.in_parent)
        {
            parent = part
                .parent_id
                .as_deref()
                .filter(|above| by_id.contains_key(above));
        }
        under.entry(parent).or_default().push(entry);
    }
    fn build(
        parent: Option<&str>,
        under: &HashMap<Option<&str>, Vec<&TreeEntry>>,
    ) -> Vec<TreeNode> {
        under
            .get(&parent)
            .map(|entries| {
                entries
                    .iter()
                    .map(|entry| TreeNode {
                        id: entry.id.clone().into(),
                        title: entry.title.clone().into(),
                        type_name: entry.type_.clone().into(),
                        archived: false,
                        children: build(Some(&entry.id), under),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    build(None, &under)
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.viewer.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::tree_of;
    use api::TreeEntry;

    #[test]
    fn the_children_of_a_part_are_filed_under_the_whole_it_belongs_to() {
        let mut disk = entry("disk", Some("computer"));
        disk.in_parent = true;
        let tree = tree_of(&[
            entry("computer", None),
            disk,
            entry("disk-manual", Some("disk")),
        ]);
        let shape: Vec<(&str, Vec<&str>)> = tree
            .iter()
            .map(|node| {
                (
                    node.id.as_ref(),
                    node.children
                        .iter()
                        .map(|child| child.id.as_ref())
                        .collect(),
                )
            })
            .collect();
        assert_eq!(shape, vec![("computer", vec!["disk-manual"])]);
    }

    fn entry(id: &str, parent: Option<&str>) -> TreeEntry {
        TreeEntry {
            id: id.into(),
            slug: id.into(),
            title: id.into(),
            type_: "note".into(),
            parent_id: parent.map(Into::into),
            in_parent: false,
        }
    }

    #[test]
    fn each_entry_goes_under_its_parent_and_one_whose_parent_is_unseen_stands_at_the_top() {
        let tree = tree_of(&[
            entry("kitchen", None),
            entry("plum-tart", Some("kitchen")),
            entry("diary-page", Some("hidden-diary")),
        ]);
        let shape: Vec<(&str, Vec<&str>)> = tree
            .iter()
            .map(|node| {
                (
                    node.id.as_ref(),
                    node.children
                        .iter()
                        .map(|child| child.id.as_ref())
                        .collect(),
                )
            })
            .collect();
        assert_eq!(
            shape,
            vec![("kitchen", vec!["plum-tart"]), ("diary-page", vec![])]
        );
    }
}
