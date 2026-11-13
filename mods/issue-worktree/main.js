// New worktree from a GitHub issue, a pull request, a branch or a new name: choose the project,
// what to create from and the base branch, then start an agent there.
// The git helpers follow Herdr's shipped `worktree` mod. See NOTICE.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, Popover } from "gpui-base";
import { run, props, closeOverlay, theme, focused, spaces, panes, exec, home, knownAgents, pickFolder, shared, setShared } from "herdr";

// Checkouts go to <root>/<branch, slashes as dashes>. The root is git config `wt.basedir` (the key
// git-wt and gh-wt read; `{gitroot}` is the repo's name, a relative path starts at the main checkout),
// else ~/.herdr/worktrees/<repo>, where the shipped `worktree` mod puts them.
async function rootOf(repo) {
  const set = (await git(repo.main, ["config", "--get", "wt.basedir"])).out.replaceAll("{gitroot}", repo.name);
  if (!set) return `${home()}/.herdr/worktrees/${repo.name}`;
  return set.startsWith("~/") ? home() + set.slice(1) : set.startsWith("/") ? set : `${repo.main}/${set}`;
}
// Projects added by hand, kept for every copy: the main checkouts' folders.
const SAVED = "issue-worktree.projects";
// The agent's first message when the worktree is for an issue.
const TASK = (issue) => `Work on ${issue.url}`;
// The git config key that links a branch to its issue: branch.<name>.issue
const KEY = "issue";
const TABS = [
  { id: "github", label: "GitHub", icon: "search" },
  { id: "branch", label: "Branch", icon: "git-branch" },
  { id: "name", label: "Name", icon: "square-pen" },
];
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

const slug = (s) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

// A branch name to start from: fix/ for a bug, else feat/, the number, and the title's ASCII words.
function suggest(issue) {
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
        kind: "pr", number: p.number, title: p.title, url: p.url, ref: `origin/${p.headRefName}`, draft: p.isDraft,
      })),
    ],
  };
}

// Local branches and the remote ones without a local branch, most recently committed first:
// { kind: "branch", title, ref?: "<remote>/<name>" }. `remotes`: every remote branch, for the base.
async function branches(main) {
  const r = await git(main, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  const refs = r.out.split("\n").filter(Boolean);
  const local = refs.filter((f) => f.startsWith("refs/heads/")).map((f) => f.slice(11));
  const remotes = refs.filter((f) => f.startsWith("refs/remotes/") && !f.endsWith("/HEAD")).map((f) => f.slice(13));
  const mine = new Set(local);
  return {
    remotes,
    local,
    items: [
      ...local.map((b) => ({ kind: "branch", title: b })),
      ...remotes.filter((b) => !mine.has(b.slice(b.indexOf("/") + 1))).map((b) => ({ kind: "branch", title: b, ref: b })),
    ],
  };
}

export default class IssueWorktree extends View {
  init(_props, cx) {
    this.repos = undefined; // undefined: looking; the repos of the open spaces, the focused one first
    this.repo = 0;
    this.data = {}; // repo main -> { items, error, branches, remotes, local } once read
    this.tab = "github";
    this.picked = null; // the issue, pull request or branch chosen in the tab
    this.at = 0;
    this.base = null; // what a new branch starts from, e.g. "origin/main"
    this.agents = [];
    this.agent = 0; // index into agents; agents.length: no agent, a shell
    this.menu = null; // the open dropdown: "project" | "base" | "agent"
    this.busy = false;
    this.error = "";
    this.focus = "search";
    this.search = InputState.new({ placeholder: "Search" });
    this.search.on("change", (_e, cx) => { this.at = 0; cx.notify(); });
    this.search.on("submit", (_e, cx) => this.pick(this.shown()[this.at], cx));
    this.search.on("focus", (_e, cx) => { this.focus = "search"; cx.notify(); });
    this.name = InputState.new({ placeholder: "feat/my-branch" });
    this.name.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
    this.name.on("submit", (_e, cx) => this.go(cx));
    this.name.on("focus", (_e, cx) => { this.focus = "name"; cx.notify(); });
    this.baseFilter = InputState.new({ placeholder: "Search branches" });
    this.baseFilter.on("change", (_e, cx) => cx.notify());
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      const here = props()?.folder || focused()?.cwd;
      const ps = panes();
      const saved = shared(SAVED) ?? [];
      const folders = [here, ...saved, ...spaces().filter((s) => !s.machine).map((s) => {
        const tabs = new Set((s.tabs ?? []).map((c) => c.id));
        return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
      })].filter(Boolean);
      const [found, agents] = await Promise.all([
        Promise.all([...new Set(folders)].map(repoOf)),
        knownAgents().catch(() => []),
      ]);
      const seen = new Set();
      this.repos = found.filter((r) => r && !seen.has(r.main) && seen.add(r.main)).map((r) => ({ ...r, saved: saved.includes(r.main) }));
      this.agents = agents.filter((a) => a.installed);
      this.load(cx);
      cx.notify();
      // The inputs only mount once the repos are known: a focus made while loading lands on nothing.
      cx.timer.after(100, () => this.search.focus());
    });
  }

  // Reads the chosen repo's issues, pull requests and branches, once.
  load(cx) {
    const repo = this.repos?.[this.repo];
    if (!repo) return;
    const known = this.data[repo.main];
    if (known) { this.base = known.start; return; }
    this.data[repo.main] = { loading: true, items: [], branches: [], remotes: [], local: [], error: "", start: null, root: "" };
    this.base = null;
    cx.spawn(async (cx) => {
      const [gh, br, head, root] = await Promise.all([
        github(repo.top),
        branches(repo.main),
        git(repo.main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
        rootOf(repo),
      ]);
      const start = head.ok ? head.out : null;
      this.data[repo.main] = { items: gh.items, error: gh.error, branches: br.items, remotes: br.remotes, local: br.local, start, root };
      if (this.repos[this.repo] === repo) this.base = start;
      cx.notify();
    });
  }

  // Adds a project with the system's folder picker and chooses it.
  addProject(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Add project" });
      if (!folder) return;
      const repo = await repoOf(folder);
      if (!repo) this.error = `${folder} is not in a git repository.`;
      else {
        setShared(SAVED, [...new Set([...(shared(SAVED) ?? []), repo.main])]);
        const at = this.repos.findIndex((r) => r.main === repo.main);
        if (at < 0) this.repos = [...this.repos, { ...repo, saved: true }];
        else this.repos[at].saved = true;
        this.choose(at < 0 ? this.repos.length - 1 : at, cx);
      }
      cx.notify();
    });
  }

  // Forgets a project added by hand; it stays listed while a space is open in it.
  removeProject(repo, cx) {
    setShared(SAVED, (shared(SAVED) ?? []).filter((m) => m !== repo.main));
    repo.saved = false;
    cx.notify();
  }

  choose(i, cx) {
    this.repo = i;
    this.picked = null;
    this.at = 0;
    this.error = "";
    this.load(cx);
  }

  close() {
    closeOverlay(props().overlay);
  }

  current() {
    return this.data[this.repos?.[this.repo]?.main];
  }

  shown() {
    const d = this.current();
    if (!d || this.picked || this.tab === "name") return [];
    const f = this.search.value().trim().toLowerCase();
    const all = this.tab === "github" ? d.items : d.branches;
    return all.filter((it) => !f || `${it.number ? `#${it.number} ` : ""}${it.title} ${it.ref ?? ""}`.toLowerCase().includes(f));
  }

  setTab(id, cx) {
    this.tab = id;
    this.picked = null;
    this.at = 0;
    this.error = "";
    this.search.set_value("");
    if (id === "name") this.name.focus();
    else this.search.focus();
    cx.notify();
  }

  pick(it, cx) {
    if (this.busy || !it) return;
    this.picked = it;
    this.error = "";
    if (it.kind === "issue") { this.name.set_value(suggest(it)); this.name.focus(); }
    else this.handle.focus();
    cx.notify();
  }

  clear(cx) {
    this.picked = null;
    this.error = "";
    this.search.focus();
    cx.notify();
  }

  // The branch is typed (an issue's, or a plain name) rather than taken from what was picked.
  named() {
    return this.tab === "name" || this.picked?.kind === "issue";
  }

  ready() {
    if (this.busy || !this.repos?.[this.repo]) return false;
    return this.named() ? Boolean(this.name.value().trim()) : Boolean(this.picked);
  }

  go(cx) {
    if (!this.ready()) return;
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
    const { main } = this.repos[this.repo];
    const it = this.picked;
    const has = async (b) => (await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${b}`])).ok;
    const fetch = async (ref) => {
      const at = ref.indexOf("/");
      return git(main, ["fetch", ref.slice(0, at), ref.slice(at + 1)], 600_000);
    };
    let branch, add;
    const at = (b) => `${this.current().root}/${slug(b)}`;
    if (this.named()) {
      branch = this.name.value().trim();
      const path = at(branch);
      if (await has(branch)) add = ["worktree", "add", path, branch];
      else {
        // From the base as its remote has it now; offline, from the last one fetched.
        // --no-track: the new branch must not push to the base branch.
        if (this.base) await fetch(this.base);
        add = ["worktree", "add", "--no-track", "-b", branch, path, this.base ?? "HEAD"];
      }
    } else if (it.ref) {
      // A branch on a remote (a pull request's, or one picked): a local branch that tracks it.
      branch = it.ref.slice(it.ref.indexOf("/") + 1);
      const path = at(branch);
      if (await has(branch)) add = ["worktree", "add", path, branch];
      else {
        const fetched = await fetch(it.ref);
        if (!fetched.ok) return fetched.err || "git fetch failed.";
        add = ["worktree", "add", "-b", branch, path, it.ref];
      }
    } else {
      branch = it.title;
      add = ["worktree", "add", at(branch), branch];
    }
    const made = await git(main, add, 600_000);
    if (!made.ok) return made.err || "git worktree add failed.";
    if (it?.kind === "issue") await git(main, ["config", `branch.${branch}.${KEY}`, String(it.number)]);
    const agent = this.agents[this.agent];
    // Unnamed, so the space follows the checkout folder and nests under its repo.
    run("space.new", { folder: at(branch), ...(agent ? { argv: agent.run } : {}), ...(agent && it?.kind === "issue" ? { task: TASK(it) } : {}) });
    return "";
  }

  key(e, cx) {
    if (e.keystroke === "escape") return this.close();
    if (e.keystroke === "cmd-enter" || e.keystroke === "ctrl-enter") this.go(cx);
    else if (e.key === "down" || e.key === "up") {
      const n = this.shown().length;
      if (!n) return;
      this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  label(t, text) {
    return div().text_size(13).text_color(t.muted).child(text);
  }

  input(t, state, on) {
    return Input.new(state).h(40).px(10).items_center().rounded(7).border(1).border_color(on ? t.accent : t.input).bg(t.background).text_color(t.foreground);
  }

  // A dropdown: a field that opens a list under it. `rows`: [{ id, label, icon?, on?, pick, remove? }].
  select(t, id, face, rows, { width = 360, filter = null, compact = false } = {}) {
    const trigger = h_flex().id(`${id}-field`).gap(8).items_center().cursor_pointer().text_color(t.foreground)
      .when(!compact, (el) => el.h(40).px(10).rounded(7).border(1).border_color(this.menu === id ? t.accent : t.input).bg(t.background))
      .when(compact, (el) => el.h(28).px(8).rounded(6).border(1).border_color(t.border).text_size(13).text_color(t.muted))
      .hover((s) => s.bg(t.hover))
      .child(face)
      .when(!compact, (el) => el.child(div().flex_1()))
      .child(svg(ICON("chevron-down")).size(14).flex_none().text_color(t.dim));
    const row = (r) => h_flex().id(`${id}-${r.id}`).flex_none().h(36).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.menu = null; r.pick(cx); cx.notify(); })
      .when(Boolean(r.icon), (el) => el.child(r.icon))
      .child(div().flex_1().min_w(0).truncate().child(r.label))
      .when(Boolean(r.on), (el) => el.child(svg(ICON("check")).size(15).flex_none().text_color(t.foreground)))
      .when(Boolean(r.remove), (el) => el.child(div().id(`${id}-${r.id}-remove`).flex_none().p(3).rounded(5).text_color(t.dim).hover((s) => s.bg(t.selected).text_color(t.foreground)).tooltip("Remove from projects")
        .on_click((_e, cx) => { cx.stop_propagation(); r.remove(cx); }).child(svg(ICON("x")).size(14))));
    return Popover.new(id)
      .open(this.menu === id)
      .on_open_change((open, cx) => {
        this.menu = open ? id : null;
        if (open && filter) { filter.set_value(""); cx.timer.after(50, () => filter.focus()); }
        cx.notify();
      })
      .trigger(trigger)
      .content(v_flex().w(width).mt(4).p(4).gap(4).rounded(8).bg(t.popover).border(1).border_color(t.border).shadow_lg().text_size(14)
        .when(Boolean(filter), (el) => el.child(Input.new(filter).h(36).px(8).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground)))
        .child(v_flex().id(`${id}-list`).max_h(300).overflow_y_scroll().children(rows.map(row))
          .when(rows.length === 0, (el) => el.child(div().p(8).text_color(t.dim).child("Nothing here.")))));
  }

  agentIcon(t, a) {
    if (!a?.icon) return svg(ICON("terminal")).size(16).flex_none().text_color(t.muted);
    return a.tint ? svg(a.icon).size(16).flex_none().text_color(t.foreground) : image(a.icon).w(16).h(16).flex_none();
  }

  itemIcon(t, it) {
    return it.kind === "branch"
      ? svg(ICON("git-branch")).size(15).flex_none().text_color(t.dim)
      : div().flex_none().w(56).text_color(it.kind === "pr" ? t.accent : t.dim).child(`#${it.number}`);
  }

  row(t, it, i) {
    const on = i === this.at;
    return h_flex()
      .id(`it-${i}`)
      .flex_none()
      .h(36)
      .px(10)
      .gap(8)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.pick(it, cx))
      .child(this.itemIcon(t, it))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(it.title))
      .when(it.kind !== "branch", (el) => el.child(div().flex_none().text_size(12.5).text_color(t.dim).child(it.kind === "pr" ? (it.draft ? "draft PR" : "PR") : "issue")))
      .when(it.kind === "branch" && Boolean(it.ref), (el) => el.child(div().flex_none().text_size(12.5).text_color(t.dim).child("remote")));
  }

  // What was picked, in place of the search: its title, and an x to choose again.
  chip(t, it) {
    return h_flex().h(40).px(10).gap(8).items_center().rounded(7).border(1).border_color(t.input).bg(t.background)
      .child(this.itemIcon(t, it))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(it.title))
      .child(div().id("clear").flex_none().p(3).rounded(5).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.clear(cx)).child(svg(ICON("x")).size(15)));
  }

  source(t, d) {
    const tab = TABS.find((x) => x.id === this.tab);
    const rows = this.shown();
    const typed = this.name.value().trim();
    return v_flex().flex_1().min_h(0).gap(8)
      .child(h_flex().gap(16).border_b(1).border_color(t.border).children(TABS.map((x) => h_flex()
        .id(`tab-${x.id}`).h(36).gap(6).items_center().cursor_pointer()
        .text_color(x.id === this.tab ? t.foreground : t.muted)
        .border_b(2).border_color(x.id === this.tab ? t.foreground : "#00000000")
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.setTab(x.id, cx))
        .child(svg(ICON(x.icon)).size(15).flex_none())
        .child(x.label))))
      .when(this.tab !== "name" && !this.picked, (el) => el
        .child(this.input(t, this.search, this.focus === "search"))
        .child(div().relative().flex_1().min_h(0)
          .child(v_flex().id("it-list").size_full().overflow_y_scroll()
            .children(rows.map((it, i) => this.row(t, it, i)))
            .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child(d.loading ? "…" : (this.tab === "github" && d.error) || "Nothing matches."))))
          .child(Scrollbar.vertical("it-list").absolute().inset_0())))
      .when(Boolean(this.picked), (el) => el.child(this.chip(t, this.picked)))
      .when(this.named(), (el) => el
        .child(this.label(t, "Branch name"))
        .child(this.input(t, this.name, this.focus === "name"))
        .child(h_flex().gap(6).items_center().text_size(14).text_color(t.muted)
          .child(svg(ICON("folder")).size(15).flex_none())
          .child(div().flex_1().min_w(0).truncate().child(`${d.root.replace(home(), "~")}/${slug(typed) || "…"}`))))
      .when(Boolean(this.picked) || this.tab === "name", (el) => el.child(div().flex_1()));
  }

  render(cx) {
    const t = theme();
    const repo = this.repos?.[this.repo];
    const d = this.current();
    const agent = this.agents[this.agent];
    const ready = this.ready();
    const f = this.baseFilter.value().trim().toLowerCase();
    return v_flex()
      .id("issue-worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(24)
      .gap(14)
      .bg(t.popover)
      .text_size(15)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(18).font_semibold().text_color(t.foreground).child("New worktree"))
        .child(div().id("close").p(4).rounded(6).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.close()).child(svg(ICON("x")).size(16))))
      .when(this.repos === undefined, (el) => el.child(div().flex_1().text_color(t.muted).child("…")))
      .when(Boolean(this.repos) && !repo, (el) => el.child(v_flex().flex_1().gap(10).items_start()
        .child(div().text_color(t.muted).child("No open space is in a git repository."))
        .child(h_flex().id("add-first").h(36).px(12).gap(8).items_center().rounded(7).border(1).border_color(t.input).cursor_pointer().text_color(t.foreground).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.addProject(cx))
          .child(svg(ICON("folder-plus")).size(15).flex_none().text_color(t.muted)).child("Add project…"))))
      .when(Boolean(repo && d), (el) => el
        .child(v_flex().gap(6)
          .child(this.label(t, "Project"))
          .child(this.select(t, "project",
            h_flex().gap(8).items_center().child(svg(ICON("folder")).size(15).flex_none().text_color(t.muted)).child(repo.name),
            [...this.repos.map((r, i) => ({ id: i, label: r.name, on: i === this.repo, pick: (cx) => this.choose(i, cx), remove: r.saved ? (cx) => this.removeProject(r, cx) : null })),
              { id: "add", label: "Add project…", icon: svg(ICON("folder-plus")).size(15).flex_none().text_color(t.muted), pick: (cx) => this.addProject(cx) }],
            { width: 400 })))
        .child(h_flex().items_center()
          .child(div().flex_1().child(this.label(t, "Create from")))
          .child(this.select(t, "base",
            h_flex().gap(6).items_center().child(svg(ICON("git-branch")).size(14).flex_none()).child(this.base ?? "HEAD"),
            [...d.remotes, ...d.local].filter((b) => !f || b.toLowerCase().includes(f)).map((b) => ({ id: b, label: b, on: b === this.base, pick: () => { this.base = b; } })),
            { width: 340, filter: this.baseFilter, compact: true })))
        .child(this.source(t, d))
        .child(v_flex().gap(6)
          .child(this.label(t, "Agent"))
          .child(this.select(t, "agent",
            h_flex().gap(8).items_center().child(this.agentIcon(t, agent)).child(agent?.name ?? "Shell only"),
            [...this.agents.map((a, i) => ({ id: i, label: a.name, icon: this.agentIcon(t, a), on: i === this.agent, pick: () => { this.agent = i; } })),
              { id: "shell", label: "Shell only", icon: this.agentIcon(t, null), on: !agent, pick: () => { this.agent = this.agents.length; } }],
            { width: 400 }))))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1())
        .when(this.busy, (el) => el.child(div().text_size(12.5).text_color(t.dim).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
        .child(h_flex().id("create").h(40).px(14).gap(10).items_center().rounded(8)
          .bg(t.solid).text_color(t.solid_foreground).font_medium()
          .when(!ready, (el) => el.opacity(0.4))
          .when(ready, (el) => el.cursor_pointer().on_click((_e, cx) => this.go(cx)))
          .child(this.busy ? "Creating…" : "Create worktree")
          .child(div().text_size(12.5).opacity(0.6).child("⌘↵"))));
  }
}
