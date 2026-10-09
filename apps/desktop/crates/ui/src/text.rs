//! The viewer's own words, in English: every heading, button, state and sentence a screen writes,
//! and the dates it writes out. A screen names its words only through this module, so that a
//! translation has one place to change. What comes from the server (titles, bodies, the labels of
//! types and fields, the sentences of a refusal) is shown as it was written, never through here.

/// The name of the application.
pub const GRENIER: &str = "Grenier";

// The sidebar.
pub const SEARCH_PLACEHOLDER: &str = "Search";
pub const NO_ENTRIES: &str = "No entries";
pub const NO_ENTRIES_DETAIL: &str = "The entries agents write will appear here.";
pub const OFFLINE: &str = "Offline";
pub const OFFLINE_DETAIL: &str = "The server does not answer.";
pub const KEY_REFUSED_SHORT: &str = "Key refused";
pub const KEY_REFUSED_DETAIL: &str = "Ask for a new key.";
pub const REFUSED_SHORT: &str = "Refused";
pub const TREE_REFUSED_DETAIL: &str = "The server refused the tree.";
pub const NO_SERVER: &str = "No server";
pub const NO_SERVER_DETAIL: &str = "See the configuration.";
pub const COLLAPSE: &str = "Collapse";
pub const EXPAND: &str = "Expand";
pub const UNFILED: &str = "Unfiled";
pub const THEME_SYSTEM: &str = "Theme of the system";
pub const THEME_LIGHT: &str = "Light theme";
pub const THEME_DARK: &str = "Dark theme";

/// The foot of the sidebar: the server the viewer reads.
pub fn connected_to(server: &str) -> String {
    format!("Connected to {server}")
}

/// The version of the viewer, beside the server; a build of no release says so.
pub fn version(version: &str) -> String {
    match version {
        "unknown" => "local build".to_string(),
        version => format!("v{version}"),
    }
}

// The toolbar of an entry.
pub const BACK: &str = "Back (Alt+←)";
pub const FORWARD: &str = "Forward (Alt+→)";
pub const COPY_LINK: &str = "Copy link";
pub const COPY_LINK_DETAIL: &str = "Copy the link of the entry";

// An entry.
pub const NO_ENTRY_OPEN: &str = "No entry open";
pub const NO_ENTRY_OPEN_DETAIL: &str = "Choose an entry on the left, or search for it with Ctrl K.";
pub const FIELDS: &str = "Fields";
/// The mark of what a writer supposed, not knew: a value, a link, the body or the summary.
pub const SUPPOSED: &str = "Supposed";
/// The chip of an entry that holds some, and the filter it lists the entries that do by.
pub const WITH_SUPPOSED: &str = "With supposed values";
pub const HIDDEN_VALUE: &str = "hidden";
pub const YES: &str = "Yes";
pub const NO: &str = "No";
pub const CONTAINS: &str = "Contains";
pub const NAME: &str = "Name";
pub const LINKS: &str = "Links";
pub const NAMED_BY_FIELDS: &str = "In its fields";
pub const MENTIONS: &str = "Mentions";
pub const MENTIONED_BY: &str = "Mentioned by";
pub const FILTER_BY_TITLE: &str = "Filter by title";
pub const FOLD: &str = "Fold";

/// What opens a folded group whole.
pub fn show_all(count: usize) -> String {
    format!("Show all {count}")
}

/// The rows a filter leaves out of an open group.
pub fn filtered_out(count: usize) -> String {
    format!("{count} not matching")
}
pub const SOURCES: &str = "Sources";
pub const MEDIA: &str = "Media";
pub const ENTRY: &str = "Entry";
pub const WEB_ADDRESS: &str = "Web address";
pub const SAID_BY: &str = "Said by";
pub const IDENTIFIER: &str = "Identifier";
pub const INBOX_ITEM: &str = "Item";
pub const IMAGE: &str = "Image";
pub const NO_DESCRIPTION: &str = "No description";
pub const ON_THIS_PAGE: &str = "On this page";
pub const HIDDEN_DETAIL: &str = "This key does not see sensitive entries.";

/// When an entry was created, in words.
pub fn created_on(date: &str) -> String {
    format!("Created {}", date_in_words(date))
}

/// When an entry was last changed, in words.
pub fn edited_on(date: &str) -> String {
    format!("Edited {}", date_in_words(date))
}

/// What a person said as a source, and when, with the note it carries.
pub fn said_on(date: &str, note: Option<&str>) -> String {
    match note {
        Some(note) => format!("{} · {note}", date_in_words(date)),
        None => date_in_words(date),
    }
}

/// The entries of a parent the caller may not see.
pub fn hidden_entries(count: usize) -> String {
    match count {
        1 => "One hidden entry".to_string(),
        count => format!("{count} hidden entries"),
    }
}

/// An item of a source the viewer does not open.
pub fn item_of(source: &str) -> String {
    format!("Item of “{source}”")
}

/// The size of a file in kilobytes.
pub fn kilobytes(bytes: i64) -> String {
    format!("{} KB", (bytes + 500) / 1000)
}

/// The dates a link held between, in words; nothing when it gives none.
pub fn held(from: Option<&str>, until: Option<&str>) -> Option<String> {
    match (from, until) {
        (Some(from), Some(until)) => Some(format!(
            "from {} to {}",
            date_in_words(from),
            date_in_words(until)
        )),
        (Some(from), None) => Some(format!("since {}", date_in_words(from))),
        (None, Some(until)) => Some(format!("until {}", date_in_words(until))),
        (None, None) => None,
    }
}

// A listing.
pub const ENTRIES: &str = "Entries";
pub const REMOVE_FILTER: &str = "Remove this filter";
pub const NOTHING_LISTED: &str = "No entry keeps every filter";
pub const NOTHING_LISTED_DETAIL: &str = "Remove a filter to see more.";
pub const MORE: &str = "More";

/// A filter by type, in a listing.
pub fn of_type(label: &str) -> String {
    format!("Type: {label}")
}

/// A filter by tag, in a listing.
pub fn with_tag(tag: &str) -> String {
    format!("Tag: {tag}")
}

/// How many entries a listing shows, and whether more follow.
pub fn listed(count: usize, more: bool) -> String {
    match (count, more) {
        (1, false) => "1 entry".to_string(),
        (count, false) => format!("{count} entries"),
        (count, true) => format!("{count} entries and more"),
    }
}

// The history of an entry.
pub const HISTORY: &str = "History";
pub const SHOW_HISTORY: &str = "Show the history";
pub const OLDER: &str = "Older";

/// What a write did, as the history names it.
pub fn action(action: &str) -> String {
    match action {
        "create" => "Created".to_string(),
        "update" => "Edited".to_string(),
        "rewrite" => "Rewritten after a rename".to_string(),
        "archive" => "Archived".to_string(),
        "link" => "Linked".to_string(),
        "unlink" => "Unlinked".to_string(),
        "attach" => "Media attached".to_string(),
        "describe" => "Media described".to_string(),
        other => other.replace('_', " "),
    }
}

/// Who wrote, and when.
pub fn by_on(actor: &str, at: &str) -> String {
    format!("by {actor} · {}", date_in_words(at))
}

/// More changes in an event than are shown.
pub fn more_changes(count: usize) -> String {
    format!("and {count} more")
}

// A search.
pub const SEARCH: &str = "Search";
pub const ALL_TYPES: &str = "All";
pub const NOTHING_FOUND_DETAIL: &str = "Try other words, or every type.";

/// How many entries a search found.
pub fn found(count: usize) -> String {
    match count {
        1 => "1 entry found".to_string(),
        count => format!("{count} entries found"),
    }
}

/// What a search was for.
pub fn searched(query: &str) -> String {
    format!("“{query}”")
}

/// A search that found nothing.
pub fn nothing_for(query: &str) -> String {
    format!("Nothing for “{query}”")
}

// What went wrong, and what to do.
pub const RETRY: &str = "Retry";
pub const UNREACHABLE: &str = "The server does not answer";
pub const UNREACHABLE_DETAIL: &str =
    "Check that Grenier is running and that this computer reaches it, then retry.";
pub const KEY_REFUSED: &str = "The key was refused";
pub const SERVER_REFUSED: &str = "The server refused";
pub const UNCONFIGURED: &str = "Grenier is not set up";

// The messages of the application, before and around a read.
pub const NO_CONFIGURATION_FOLDER: &str = "This system has no configuration folder.";

/// The configuration to create, and what it holds.
pub fn create_configuration(path: &str) -> String {
    format!(
        "Create {path} with the address of the server and the file of the key: \
         {{ \"server\": \"http://127.0.0.1:3000\", \"key_file\": \"~/.config/grenier/key\" }}"
    )
}

/// A configuration that does not read.
pub fn unreadable_configuration(path: &str, error: &str) -> String {
    format!("{path} does not read: {error}")
}

/// A key file that does not read.
pub fn unreadable_key(path: &str) -> String {
    format!("The key file {path} does not read.")
}

/// A key file with nothing in it.
pub fn empty_key(path: &str) -> String {
    format!("The key file {path} is empty.")
}

/// An answer of the server that does not read.
pub fn unreadable_answer(error: &str) -> String {
    format!("The answer of the server does not read: {error}")
}

/// An answer of the server that gave no sentence of its own.
pub fn server_answered(status: u16) -> String {
    format!("The server answered {status}.")
}

/// `2026-10-07` (or a timestamp of that day) as `7 October 2026`; any other text as it is.
pub fn date_in_words(date: &str) -> String {
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    let day_part = date.get(..10).unwrap_or(date);
    let parts: Vec<&str> = day_part.split('-').collect();
    match parts.as_slice() {
        [year, month, day] if year.len() == 4 => {
            match (month.parse::<usize>(), day.parse::<u32>()) {
                (Ok(month @ 1..=12), Ok(day)) => format!("{day} {} {year}", MONTHS[month - 1]),
                _ => date.to_string(),
            }
        }
        _ => date.to_string(),
    }
}

/// A date where it stands in a table: `2026-10-07`, the day of a timestamp.
pub fn date_in_table(date: &str) -> String {
    date.get(..10).unwrap_or(date).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_date_reads_in_english_words() {
        assert_eq!(date_in_words("2026-10-07"), "7 October 2026");
        assert_eq!(date_in_words("2026-10-07T08:00:00.000Z"), "7 October 2026");
        assert_eq!(date_in_words("someday"), "someday");
        assert_eq!(date_in_table("2026-10-07T08:00:00.000Z"), "2026-10-07");
    }
}
