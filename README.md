# herdr-issue-worktree

Two [Herdr](https://herdr.dev/) mods that tie git worktrees to GitHub issues and pull requests:

- `issue-worktree`: a dialog that makes a worktree from an issue or pull request, opens it as a space and starts an agent there. The issue stays linked to the branch.
- `spaces-issues`: Herdr's Spaces sidebar, where hovering a space shows its linked issue and pull request.

## Requirements

- `git`
- [`gh`](https://cli.github.com/), logged in, for the lists of issues and pull requests

## Install

```sh
git clone https://github.com/meltin/herdr-issue-worktree ~/dev/oss/herdr-issue-worktree
ln -s ~/dev/oss/herdr-issue-worktree/mods/issue-worktree ~/.config/herdr-app/mods/issue-worktree
ln -s ~/dev/oss/herdr-issue-worktree/mods/spaces-issues ~/.config/herdr-app/mods/spaces-issues
herdr-app check ~/.config/herdr-app/mods/issue-worktree
herdr-app check ~/.config/herdr-app/mods/spaces-issues
```

Either mod works without the other.

### The dialog

Open it with `herdr-app do mod.open '{"name":"issue-worktree"}'`, or bind a key in `~/.config/herdr-app/keys.json`:

```json
{ "global": { "cmd-shift-n": "mod.open:issue-worktree" } }
```

### The sidebar

Herdr's layouts are read-only. To use `spaces-issues`, clone your layout and point its Spaces block at it:

```sh
herdr-app do layout.clone '{"name":"main","as":"main-issues"}'
# in ~/.config/herdr-app/layouts/main-issues.json, change the Spaces block's "mod": "spaces" to "spaces-issues"
```

## Use

The dialog lists the open issues and pull requests of the repository the focused pane is in.

- Pick an issue, edit the suggested branch name, press Enter. The branch starts from the remote's default branch (fetched first), and `git config branch.<name>.issue` records the issue number.
- Pick a pull request. Its branch is fetched and checked out.
- Type a name that matches nothing and press Enter to make a plain branch.

Tab chooses the agent to start, or a shell. For an issue the agent's first message is `Work on <issue url>`.

Worktrees go to `~/.herdr/worktrees/<repo>/<branch>`, where Herdr's own New worktree puts them, so Herdr's Open worktree and Remove worktree work on them.

In the sidebar, rest the pointer on a space that is a worktree, or whose branch has an issue. A card shows the issue from `branch.<name>.issue` and the pull request whose head is that branch; click either to open it in the browser. To link a branch made elsewhere: `git config branch.<name>.issue <number>`.

## License

Apache License 2.0. `mods/spaces-issues/main.js` is a modified copy of the `spaces` mod shipped with Herdr.app, and parts of `mods/issue-worktree/main.js` are adapted from its `worktree` mod; see [NOTICE](NOTICE).
