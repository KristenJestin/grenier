# Branch protection

`main` and `dev` are protected. Locally, the versioned `pre-commit` hook refuses any commit
made directly on them; run `node tools/install-hooks.ts` once after cloning to enable it.

On GitHub, the same rule is a ruleset on `main` and `dev`: no direct push, no deletion, no
force push, a pull request and the `commit-messages` and `verify` checks required.

## Merge method (to set on the repository)

Two settings, both under *Settings → General → Pull Requests*, and neither of them something a
commit can enforce:

- **Allow squash merging only.** Merge commits and rebase merging are turned off, so every
  change reaches `main` and `dev` as exactly one commit.
- **Squash merge commit message: “Pull request title and description”.** The title of the pull
  request becomes the subject of that commit, which is why the title is a plain Angular subject.
  semantic-release reads those subjects to decide the version.
