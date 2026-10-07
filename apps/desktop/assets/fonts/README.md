# The fonts of the viewer

Embedded in the viewer at compile time (`crates/ui/src/theme.rs`), so it reads the same on every
machine, whatever is installed.

| Font | Files | Licence | Source |
|---|---|---|---|
| Open Sauce Sans, the text | `OpenSauceSans-{Regular,Italic,Medium,SemiBold,Bold}.ttf` | SIL Open Font License 1.1, `OFL-OpenSauceSans.txt` | the Open Sauce Fonts project by Alfredo Marco Pradil, https://github.com/marcologous/Open-Sauce-Fonts, `fonts/ttf/`, commit `1747e4467caf9ecce17690ae6880d86a03e17c41` (2026-05-11) |

Peace Sans, by Jovanny Lemonad, is chosen for the headings and is not here yet: its file and its
`OFL.txt` come from the designer's distribution. Once they are added, `theme::font::HEADING`
names it and `theme::FONTS` loads it.
