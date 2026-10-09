//! The read API of a Grenier server, as the viewer uses it: each call gives the data, or the
//! problem in the terms the screens show. Calls block: run them on the background executor.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use api::{
    EntryList, EntryRead, HistoryPage, SearchResult, SearchResults, TreeEntry, TypeDefinition,
    TypeList,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use ui::intent::ListFilter;
use ui::load::Problem;
use ui::text as words;

/// The key the server knows this viewer by. It is sent, never shown.
pub struct Key(String);

impl Key {
    pub fn new(secret: impl Into<String>) -> Self {
        Self(secret.into())
    }
}

impl fmt::Debug for Key {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Key(hidden)")
    }
}

/// A server and the key to read it with.
#[derive(Clone, Debug)]
pub struct Client {
    server: String,
    key: Arc<Key>,
    agent: Agent,
}

#[derive(Clone)]
struct Agent(ureq::Agent);

impl fmt::Debug for Agent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Agent")
    }
}

/// What the server says when it refuses.
#[derive(Deserialize)]
struct Refusal {
    message: String,
}

impl Client {
    pub fn new(server: impl Into<String>, key: Key) -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(15)))
            .build()
            .into();
        Self {
            server: server.into().trim_end_matches('/').to_string(),
            key: Arc::new(key),
            agent: Agent(agent),
        }
    }

    /// The address of the server.
    pub fn server(&self) -> &str {
        &self.server
    }

    pub fn types(&self) -> Result<Vec<TypeDefinition>, Problem> {
        self.get::<TypeList>("/api/types", &[])
            .map(|list| list.types)
    }

    /// Every entry the key may see, with its parent: the whole tree.
    pub fn tree(&self) -> Result<Vec<TreeEntry>, Problem> {
        self.get::<EntryList>("/api/entries", &[])
            .map(|list| list.entries)
    }

    /// The entry of that slug or id, with its place in the tree and what it is tied to.
    pub fn read(&self, entry: &str) -> Result<EntryRead, Problem> {
        self.get(&format!("/api/entries/{}", encoded(entry)), &[])
    }

    pub fn search(
        &self,
        query: &str,
        type_name: Option<&str>,
    ) -> Result<Vec<SearchResult>, Problem> {
        let mut parameters = vec![("q", query)];
        parameters.extend(type_name.map(|name| ("type", name)));
        self.get::<SearchResults>("/api/search", &parameters)
            .map(|found| found.results)
    }

    /// A page of the entries a filter keeps, by title, after `cursor` when given; and where the
    /// next page starts, if one does.
    pub fn list(
        &self,
        filter: &ListFilter,
        cursor: Option<&str>,
    ) -> Result<(Vec<TreeEntry>, Option<String>), Problem> {
        let mut parameters = Vec::new();
        if let Some((name, _)) = &filter.type_name {
            parameters.push(("type", name.to_string()));
        }
        if let Some(tag) = &filter.tag {
            parameters.push(("tag", tag.to_string()));
        }
        if filter.supposed {
            parameters.push(("supposed", "true".to_string()));
        }
        if let Some(cursor) = cursor {
            parameters.push(("cursor", cursor.to_string()));
        }
        let pairs: Vec<(&str, &str)> = parameters
            .iter()
            .map(|(name, value)| (*name, value.as_str()))
            .collect();
        self.get::<EntryList>("/api/entries", &pairs)
            .map(|list| (list.entries, list.next_cursor))
    }

    /// A page of the history of an entry, newest first, after `cursor` when given.
    pub fn history(&self, entry: &str, cursor: Option<&str>) -> Result<HistoryPage, Problem> {
        let query: Vec<(&str, &str)> = cursor
            .map(|cursor| ("cursor", cursor))
            .into_iter()
            .collect();
        self.get(&format!("/api/entries/{}/history", encoded(entry)), &query)
    }

    fn get<T: DeserializeOwned>(&self, path: &str, query: &[(&str, &str)]) -> Result<T, Problem> {
        let mut request = self
            .agent
            .0
            .get(format!("{}{path}", self.server))
            .header("Authorization", format!("Bearer {}", self.key.0));
        for (name, value) in query {
            request = request.query(*name, *value);
        }
        let mut response = request.call().map_err(|_| Problem::Unreachable)?;
        let status = response.status().as_u16();
        let body = response.body_mut();
        if status == 200 {
            return body.read_json::<T>().map_err(|error| {
                Problem::Refused(words::unreadable_answer(&error.to_string()).into())
            });
        }
        let sentence = body
            .read_json::<Refusal>()
            .map(|refusal| refusal.message)
            .unwrap_or_else(|_| words::server_answered(status));
        Err(match status {
            401 | 403 => Problem::KeyRefused(sentence.into()),
            _ => Problem::Refused(sentence.into()),
        })
    }
}

/// A slug or an id as one segment of a path: anything but letters, digits, `-`, `.`, `_` and `~`
/// escaped.
fn encoded(segment: &str) -> String {
    segment
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}
