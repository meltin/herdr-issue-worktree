# herdr-issue-worktree

A [Herdr](https://herdr.dev/) mod: a dialog that makes a git worktree from a GitHub issue or pull request, opens it as a space and starts an agent there. The issue stays linked to the branch.

## Requirements

- `git`
- [`gh`](https://cli.github.com/), logged in, for the lists of issues and pull requests

## Install

```sh
git clone https://github.com/meltin/herdr-issue-worktree ~/dev/oss/herdr-issue-worktree
ln -s ~/dev/oss/herdr-issue-worktree/mods/issue-worktree ~/.config/herdr-app/mods/issue-worktree
herdr-app check ~/.config/herdr-app/mods/issue-worktree
```

Open it with `herdr-app do mod.open '{"name":"issue-worktree"}'`, or bind a key in `~/.config/herdr-app/keys.json`:

```json
{ "global": { "cmd-shift-n": "mod.open:issue-worktree" } }
```

## Use

The dialog lists the open issues and pull requests of the repository the focused pane is in.

- Pick an issue, edit the suggested branch name, press Enter. The branch starts from the remote's default branch (fetched first), and `git config branch.<name>.issue` records the issue number.
- Pick a pull request. Its branch is fetched and checked out.
- Type a name that matches nothing and press Enter to make a plain branch.

Tab chooses the agent to start, or a shell. For an issue the agent's first message is `Work on <issue url>`.

Worktrees go to `~/.herdr/worktrees/<repo>/<branch>`, where Herdr's own New worktree puts them, so Herdr's Open worktree and Remove worktree work on them.

## License

Apache License 2.0. Parts of `mods/issue-worktree/main.js` are adapted from the `worktree` mod shipped with Herdr.app; see [NOTICE](NOTICE).
