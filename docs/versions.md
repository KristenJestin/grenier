# What a version promises

From 1.0, a breaking change makes a new major version (semantic-release counts it from the
`BREAKING CHANGE:` footer of a commit). A change is breaking when it breaks one of three promises.

## The data

An installation of any version from 0.6.0 on updates to a newer version and keeps everything:
entries, fields, links, history, media, keys and inbox. The migrations run by themselves as the
server starts.

Breaking: an update that loses or alters what the owner has, or that needs a manual step to keep it.
Not breaking: a migration that runs by itself and keeps the data.

## The MCP tools

The 13 tools of 0.6.0, their names, their parameters and the shape of their answers.

Breaking: a tool or a parameter removed or renamed, or an answer that an agent relying on it would
misread.
Not breaking: a new tool, an optional parameter, a field added to an answer.

## The command line `hippo`

Its commands and flags, the same way.

Breaking: a command or a flag removed or renamed, or one that no longer does what it did.
Not breaking: a new command, a new optional flag.

## The read API is experimental

`/api/*` and its OpenAPI document are not covered. Only the desktop viewer uses them, they still
move, and changing them is never breaking. The document says so in its description.
