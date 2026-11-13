// New worktree from a GitHub issue or pull request: pick one, name the branch, start an agent there.
// The git helpers and the dialog's shape follow Herdr's shipped `worktree` mod. See NOTICE.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { run, props, closeOverlay, theme, focused, exec, home, knownAgents } from "herdr";

// Checkouts go to <ROOT>/<repo>/<branch, slashes as dashes>, where the shipped `worktree` mod puts them.
const ROOT = () => `${home()}/.herdr/worktrees`;
// The agent's first message when the worktree is for an issue.
const TASK = (issue) => `Work on ${issue.url}`;
// The git config key that links a branch to its issue: branch.<name>.issue
const KEY = "issue";

const slug = (s) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

// A branch name to start from: fix/ for a bug, else feat/, the number, and the title's ASCII words.
export function suggest(issue) {
  const words = slug(issue.title.replace(/^\s*\[[^\]]*\]\s*/, "").toLowerCase()).slice(0, 40).replace(/-+$/, "");
  return `${issue.bug ? "fix" : "feat"}/${issue.number}${words ? `-${words}` : ""}`;
}

async function sh(command, args, cwd, timeout) {
  try {
    const r = await exec(command, args, { cwd, ...(timeout === undefined ? {} : { timeout }) });
    return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
  } catch (error) {
    return { ok: false, out: "", err: String(error) };
  }
}
const git = (cwd, args, timeout) => sh("git", args, cwd, timeout);

// The repo a folder belongs to: its top, its main checkout and name. null outside git.
async function repoOf(folder) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop().replace(/\.git$/, "") };
}

// Open issues and pull requests, issues first. Pull requests from forks are left out:
// shortcut: their branch is not on origin, fetch refs/pull/<n>/head if they matter.
async function github(cwd) {
  const [issues, prs] = await Promise.all([
    sh("gh", ["issue", "list", "--limit", "200", "--json", "number,title,url,labels"], cwd),
    sh("gh", ["pr", "list", "--limit", "200", "--json", "number,title,url,headRefName,isDraft,isCrossRepository"], cwd),
  ]);
  if (!issues.ok || !prs.ok) return { items: [], error: (issues.ok ? prs : issues).err || "gh failed." };
  return {
    error: "",
    items: [
      ...JSON.parse(issues.out).map((i) => ({
        kind: "issue", number: i.number, title: i.title, url: i.url,
        bug: /^\s*\[bug\]/i.test(i.title) || i.labels.some((l) => l.name.toLowerCase() === "bug"),
      })),
      ...JSON.parse(prs.out).filter((p) => !p.isCrossRepository).map((p) => ({
        kind: "pr", number: p.number, title: p.title, url: p.url, branch: p.headRefName, draft: p.isDraft,
      })),
    ],
  };
}

export default class IssueWorktree extends View {
  init(_props, cx) {
    this.stage = "pick"; // pick: choose from the list; branch: name the issue's branch
    this.items = undefined; // undefined: loading
    this.at = 0;
    this.picked = null;
    this.agents = [];
    this.agent = 0; // index into agents; agents.length: no agent, a shell
    this.repo = undefined; // undefined: looking, null: not in git
    this.start = null; // the default branch on the remote, e.g. "origin/main"
    this.busy = false;
    this.error = "";
    this.input = InputState.new({ placeholder: "filter issues and pull requests, or type a branch name" });
    this.input.on("change", (_e, cx) => { this.error = ""; this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.enter(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.input.focus();
    this.folder = props()?.folder || focused()?.cwd || home();
    cx.spawn(async (cx) => {
      const repo = await repoOf(this.folder);
      if (repo) {
        const [gh, head, agents] = await Promise.all([
          github(repo.top),
          git(repo.main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
          knownAgents().catch(() => []),
        ]);
        this.items = gh.items;
        this.error = gh.error;
        this.start = head.ok ? head.out : null;
        this.agents = agents.filter((a) => a.installed);
      }
      this.repo = repo;
      cx.notify();
      // The input only mounts once the repo is known: a focus made while loading lands on nothing.
      this.handle.focus();
      cx.timer.after(100, () => this.input.focus());
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  shown() {
    const f = this.input.value().trim().toLowerCase();
    return (this.items ?? []).filter((it) => !f || `#${it.number} ${it.title} ${it.branch ?? ""}`.toLowerCase().includes(f));
  }

  pick(it, cx) {
    if (this.busy || !it) return;
    this.picked = it;
    if (it.kind === "pr") return this.go(cx);
    this.stage = "branch";
    this.input.set_value(suggest(it));
    this.input.focus();
    cx.notify();
  }

  enter(cx) {
    if (this.busy || !this.repo) return;
    if (this.stage === "branch") return this.go(cx);
    const it = this.shown()[this.at];
    if (it) return this.pick(it, cx);
    // Nothing matches: the text is a branch name, linked to nothing.
    this.picked = null;
    this.go(cx);
  }

  go(cx) {
    cx.spawn(async (cx) => {
      this.busy = true;
      this.error = "";
      cx.notify();
      try { this.error = await this.create(); }
      catch (error) { this.error = String(error); }
      this.busy = false;
      if (!this.error) this.close();
      cx.notify();
    });
  }

  async create() {
    const it = this.picked;
    const pr = it?.kind === "pr";
    const branch = pr ? it.branch : this.input.value().trim();
    if (!branch) return "Type a branch name.";
    const { main, name } = this.repo;
    const path = `${ROOT()}/${name}/${slug(branch)}`;
    const exists = (await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
    let add = ["worktree", "add", path, branch];
    if (!exists && pr) {
      // shortcut: the remote is taken to be `origin`, read the PR's remote if a repo names it otherwise.
      const fetched = await git(main, ["fetch", "origin", branch], 600_000);
      if (!fetched.ok) return fetched.err || "git fetch failed.";
      add = ["worktree", "add", "-b", branch, path, `origin/${branch}`];
    } else if (!exists) {
      // From the remote's default branch as it is now; offline, from the last one fetched.
      // --no-track: the new branch must not push to the default branch.
      const at = this.start?.indexOf("/") ?? -1;
      if (at > 0) await git(main, ["fetch", this.start.slice(0, at), this.start.slice(at + 1)], 600_000);
      add = ["worktree", "add", "--no-track", "-b", branch, path, this.start ?? "HEAD"];
    }
    const made = await git(main, add, 600_000);
    if (!made.ok) return made.err || "git worktree add failed.";
    if (it?.kind === "issue") await git(main, ["config", `branch.${branch}.${KEY}`, String(it.number)]);
    const agent = this.agents[this.agent];
    // Unnamed, so the space follows the checkout folder and nests under its repo.
    run("space.new", { folder: path, ...(agent ? { argv: agent.run } : {}), ...(agent && it?.kind === "issue" ? { task: TASK(it) } : {}) });
    return "";
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.stage !== "branch" || this.busy) return this.close();
      this.stage = "pick";
      this.picked = null;
      this.input.set_value("");
    } else if (e.key === "tab") {
      this.agent = (this.agent + 1) % (this.agents.length + 1);
    } else if (this.stage === "pick" && (e.key === "down" || e.key === "up")) {
      const n = this.shown().length;
      if (!n) return;
      this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  row(t, it, i) {
    const on = i === this.at;
    return h_flex()
      .id(`it-${it.kind}-${it.number}`)
      .flex_none()
      .h(32)
      .px(10)
      .gap(8)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.pick(it, cx))
      .child(div().flex_none().w(48).text_color(t.dim).child(`#${it.number}`))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(it.title))
      .child(div().flex_none().text_size(11).text_color(it.kind === "pr" ? t.accent : t.dim).child(it.kind === "pr" ? (it.draft ? "draft PR" : "PR") : "issue"));
  }

  agentRow(t) {
    const chip = (label, i) => div()
      .id(`agent-${i}`)
      .flex_none()
      .px(7)
      .h(22)
      .flex()
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .text_color(i === this.agent ? t.foreground : t.dim)
      .when(i === this.agent, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.agent = i; cx.notify(); })
      .child(label);
    return h_flex().id("agents").gap(4).items_center().text_size(11.5)
      .child(div().flex_none().text_color(t.dim).mr(2).child("Start"))
      .children([...this.agents.map((a, i) => chip(a.name, i)), chip("Shell", this.agents.length)]);
  }

  render(cx) {
    const t = theme();
    const r = this.repo;
    const it = this.picked;
    const naming = this.stage === "branch";
    const rows = naming ? [] : this.shown();
    const typed = this.input.value().trim();
    const hint = this.busy ? "working…" : !r ? "esc close" : naming ? "↵ create · ⇥ agent · esc back" : rows.length ? "↑↓ choose · ↵ pick · ⇥ agent · esc close" : typed ? "↵ create this branch · ⇥ agent · esc close" : "esc close";
    return v_flex()
      .id("issue-worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex()
        .child(div().flex_1().font_semibold().text_color(t.foreground).child(`New worktree${r ? ` of ${r.name}` : ""}`))
        .child(div().text_size(11).text_color(t.dim).child(r && this.start ? `from ${this.start}` : "")))
      .when(r === undefined, (el) => el.child(div().text_color(t.muted).child("…")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder} is not in a git repository.`)))
      .when(Boolean(r), (el) => el
        .when(naming, (el) => el.child(div().truncate().text_color(t.muted).child(`#${it.number} ${it.title}`)))
        .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
        .when(naming, (el) => el
          .child(div().text_color(t.dim).text_size(11.5).child(`Checked out in ${ROOT().replace(home(), "~")}/${r.name}/${slug(typed)}. A branch that exists is checked out as it is.`))
          .child(div().flex_1()))
        .when(!naming, (el) => el.child(
          div().relative().flex_1().min_h(0)
            .child(v_flex().id("it-list").size_full().overflow_y_scroll()
              .children(rows.map((it, i) => this.row(t, it, i)))
              .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child(typed ? `No issue or pull request matches. Enter creates the branch ${typed}.` : "No open issues or pull requests."))))
            .child(Scrollbar.vertical("it-list").absolute().inset_0()),
        )))
      .when(!r, (el) => el.child(div().flex_1()))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(h_flex().items_center().gap(8)
        .when(Boolean(r), (el) => el.child(this.agentRow(t)))
        .child(div().flex_1())
        .when(this.busy, (el) => el.child(div().text_size(11).text_color(t.dim).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(hint)));
  }
}
