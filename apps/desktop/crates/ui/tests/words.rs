//! The viewer's own words live in `ui::text`: a screen that writes a sentence of its own fails here.

use std::fs;
use std::path::Path;

/// Files that are not screens: the words themselves, and names that are not words (fonts, themes).
const NOT_SCREENS: [&str; 3] = ["text.rs", "theme.rs", "assets.rs"];

/// The string literals of a line, without their quotes, escapes left as they are.
fn literals(line: &str) -> Vec<(usize, String)> {
    let mut found = Vec::new();
    let mut chars = line.char_indices().peekable();
    while let Some((start, c)) = chars.next() {
        if c != '"' {
            continue;
        }
        let mut text = String::new();
        while let Some((_, inner)) = chars.next() {
            match inner {
                '\\' => {
                    chars.next();
                }
                '"' => break,
                other => text.push(other),
            }
        }
        found.push((start, text));
    }
    found
}

/// Whether a text holds two words in a row: a sentence, a label of several words.
fn several_words(text: &str) -> bool {
    let words: Vec<&str> = text.split(' ').collect();
    words.windows(2).any(|pair| {
        let word = |part: &str| part.chars().filter(|c| c.is_alphabetic()).count() >= 2;
        word(pair[0]) && word(pair[1])
    })
}

#[test]
fn no_screen_writes_a_sentence_outside_the_words_of_the_viewer() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut found = Vec::new();
    for folder in ["ui/src", "app/src"] {
        for file in fs::read_dir(root.join(folder)).expect("the sources are read") {
            let path = file.expect("a source").path();
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if !name.ends_with(".rs") || NOT_SCREENS.contains(&name) {
                continue;
            }
            let source = fs::read_to_string(&path).expect("a source is read");
            for (number, line) in source.lines().enumerate() {
                // Tests, and what follows them, are not the viewer's words.
                if line.contains("#[cfg(test)]") {
                    break;
                }
                let code = line.trim_start();
                if code.starts_with("//") {
                    continue;
                }
                for (at, text) in literals(line) {
                    // A message for a developer, never shown.
                    let before = &line[..at];
                    if before.ends_with("expect(") || before.ends_with("panic!(") {
                        continue;
                    }
                    if several_words(&text) {
                        found.push(format!("{folder}/{name}:{}: \"{text}\"", number + 1));
                    }
                }
            }
        }
    }
    assert!(
        found.is_empty(),
        "words outside ui::text:\n{}",
        found.join("\n")
    );
}
