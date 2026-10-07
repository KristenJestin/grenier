//! The viewer fed by a server: it turns what the user asks for into requests, keeps what was
//! opened for back and forward, and gives the screens the answers, or the problem.

use std::collections::{HashMap, HashSet};

use api::{TreeEntry, TypeDefinition};
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, Render, SharedString, Subscription, Task, Window,
};
use ui::entry::EntryData;
use ui::intent::Intent;
use ui::load::{Load, Problem};
use ui::search::SearchData;
use ui::viewer::{Pane, TreeNode, Viewer};

use crate::client::Client;

/// What the pane shows, as the history keeps it.
#[derive(Clone, Debug, PartialEq)]
enum Location {
    Entry(SharedString),
    Search {
        query: SharedString,
        type_name: Option<SharedString>,
    },
}

pub struct Shell {
    viewer: Entity<Viewer>,
    client: Option<Client>,
    types: Vec<TypeDefinition>,
    tree: Vec<TreeEntry>,
    history: Vec<Location>,
    at: usize,
    // A request replaced by another is dropped, and so cancelled: a late answer never shows.
    tree_request: Option<Task<()>>,
    pane_request: Option<Task<()>>,
    _intents: Subscription,
}

impl Shell {
    /// The viewer on the server of `client`, or saying what to set up.
    pub fn new(
        client: Result<Client, String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let viewer = cx.new(|cx| Viewer::new(window, cx));
        let intents = cx.subscribe_in(&viewer, window, |shell, _, intent: &Intent, window, cx| {
            shell.asked(intent.clone(), window, cx)
        });
        let mut shell = Self {
            viewer,
            client: None,
            types: Vec::new(),
            tree: Vec::new(),
            history: Vec::new(),
            at: 0,
            tree_request: None,
            pane_request: None,
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
                    viewer.set_connection(Some(host.into()), cx)
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
            Intent::OpenAncestor(depth) => {
                if let Some(id) = self.ancestor(depth, cx) {
                    self.go(Location::Entry(id), window, cx);
                }
            }
            Intent::Search { query, type_name } => {
                self.go(Location::Search { query, type_name }, window, cx)
            }
            Intent::OpenUrl(url) => cx.open_url(&url),
            Intent::OpenInApi(slug) => {
                if let Some(client) = &self.client {
                    cx.open_url(&format!("{}/api/entries/{slug}", client.server()));
                }
            }
            Intent::Back if self.at > 0 => {
                self.at -= 1;
                self.show(window, cx);
            }
            Intent::Forward if self.at + 1 < self.history.len() => {
                self.at += 1;
                self.show(window, cx);
            }
            Intent::Back | Intent::Forward => {}
            Intent::Retry => {
                self.load_tree(window, cx);
                if !self.history.is_empty() {
                    self.show(window, cx);
                }
            }
        }
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
                                    })
                                }
                                Err(problem) => Load::Failed(problem),
                            };
                            shell.set_pane(Pane::Entry(Box::new(load)), window, cx);
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
                            shell.tree = tree;
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

    /// The id of the ancestor at `depth` of the open entry, from the root; none when one of its
    /// ancestors is out of the tree this key sees.
    fn ancestor(&self, depth: usize, cx: &Context<Self>) -> Option<SharedString> {
        let viewer = self.viewer.read(cx);
        let opened = viewer.opened()?;
        let parents: HashMap<&str, Option<&str>> = self
            .tree
            .iter()
            .map(|entry| (entry.id.as_str(), entry.parent_id.as_deref()))
            .collect();
        let mut line = Vec::new();
        let mut at = parents.get(opened).copied().flatten();
        while let Some(id) = at {
            line.push(id);
            at = parents.get(id).copied().flatten();
        }
        line.reverse();
        line.get(depth).map(|id| SharedString::from(id.to_string()))
    }
}

/// The tree from its entries: each under its parent, by title as the server gives them; an entry
/// whose parent this key does not see stands at the top, so that none goes missing. A part of its
/// parent (`in_parent`) is read in the parent's page, not listed under it.
pub fn tree_of(entries: &[TreeEntry]) -> Vec<TreeNode> {
    let known: HashSet<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
    let mut under: HashMap<Option<&str>, Vec<&TreeEntry>> = HashMap::new();
    for entry in entries {
        let parent = entry
            .parent_id
            .as_deref()
            .filter(|parent| known.contains(parent));
        if entry.in_parent && parent.is_some() {
            continue;
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
