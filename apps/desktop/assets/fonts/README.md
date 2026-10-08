# The fonts of the viewer

Embedded in the viewer at compile time (`crates/ui/src/theme.rs`), so it reads the same on every
machine, whatever is installed.

| Font | Files | Licence | Source |
|---|---|---|---|
| Open Sauce Sans, the text | `OpenSauceSans-{Regular,Italic,Medium,SemiBold,Bold}.ttf` | SIL Open Font License 1.1, `OFL-OpenSauceSans.txt` | the Open Sauce Fonts project by Alfredo Marco Pradil, https://github.com/marcologous/Open-Sauce-Fonts, `fonts/ttf/`, commit `1747e4467caf9ecce17690ae6880d86a03e17c41` (2026-05-11) |
| Peace Sans, the headings | `PeaceSans-Regular.ttf` (its one weight, version 1.000) | SIL Open Font License 1.1, `OFL-PeaceSans.txt` | by Sergey Ryadovoy and Jovanny Lemonad (2016), from Fontsource: `@fontsource/peace-sans` 5.3.0, https://cdn.jsdelivr.net/fontsource/fonts/peace-sans@5.3.0/latin-400-normal.ttf, sha256 `f1c66310c155b35583eccb0b91e47e9f2b8cb2a6a4a53e0154fca4851387a6f5` |

Peace Sans covers every letter of French, capitals included, with `« » ’ €`. Its licence is the
text of the Fontsource package, under the copyright line of the font's own name table.
