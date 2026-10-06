# Branch protection

`main` and `dev` are protected. Locally, the versioned `pre-commit` hook refuses any commit made
directly on them; run `bun tools/install-hooks.ts` once after cloning to enable it.

On GitHub, the rules are rulesets kept in this repository, in `.github/rulesets/`:

- `dev.json`: pull requests only, **squash** only, no deletion, no force push, and the checks
  `commit-messages`, `verify`, `generated` and `image` required.
- `main.json`: the same, but **merge commits** only: a release merges `dev` into `main` as it is,
  so the two branches never diverge.

`bun tools/apply-rulesets.ts` creates or updates them on GitHub by name (it needs `gh`, logged in
with the rights to administer the repository). Change the files, then apply them; never edit the
rules in GitHub's settings alone.

## Merge settings (to set on the repository)

Under *Settings → General → Pull Requests*: allow squash merging and merge commits, not rebase
merging; squash merge commit message: “Pull request title and description”.
