# Contributing to Monky

*[Português](CONTRIBUTING.md) · **English***

Thanks for your interest! This document explains how to propose ideas, vote on
what comes first and — if you want to write code — how to open a PR that lands
without friction.

Monky is MIT and development happens entirely in public, in the
[Issues](https://github.com/MonkyOrg/Monky/issues).

---

## 🗳️ The easiest way to help: say what you want

You **do not need to know how to code** to influence where the project goes.
What goes into each cycle is decided by community votes.

### Proposing an idea

Open a discussion under
**[Discussions › Ideas](https://github.com/MonkyOrg/Monky/discussions/categories/ideas)**.

Two rules that make voting work:

1. **Search before posting.** If the idea already exists, vote on it instead of
   opening another — two identical proposals split the votes and both lose.
2. **One idea per discussion.** In a list of five requests, nobody can say they
   agree with the third and disagree with the fifth.

### Voting

Use the discussion's **upvote button** (⬆️). That is what counts — 👍 reactions
on comments do not enter the ranking.

Vote honestly: votes inflated by fresh accounts or brigading are discarded. The
point is to measure what people actually want, not who can mobilise the most
people.

### The cycle: how a vote becomes code

Every idea carries a label saying where it stands:

| Label | Meaning |
|---|---|
| `ideia` | Open for votes and discussion |
| `planejado` | Selected — already an issue |
| `em-andamento` | Someone is implementing it |
| `entregue` | Shipped in a published release |
| `fora-de-escopo` | We will not do it — always with the reason explained |

**In the first week of every month**, the ideas up for voting are reviewed. The
**three most-voted** with **at least 5 votes** are selected: they become issues
with scope and acceptance criteria and get the `planejado` label. From there
they follow the normal flow: implementation → PR → release → validation →
delivery.

The floor of 5 votes exists so the cycle does not promote noise in quiet months
— if no idea reaches the floor, none is selected and they all keep accumulating
votes for the following month. Votes do not reset between cycles.

An idea that is not selected **is not rejected** — it stays up for voting. It
only gets `fora-de-escopo` when there is an explicit decision not to do it,
always with the reason written in the discussion.

Two things we commit to:

- **A high vote count is not an automatic promise.** A heavily voted idea can
  still be turned down if it conflicts with what Monky is — P2P, self-hosted, no
  central server and no data collection. When that happens, the reason is
  written in the discussion; we do not let it die in silence.
- **The status goes back to the discussion.** If labels never change, voting
  becomes theatre and people stop voting. Closing that loop is the
  maintainers' obligation.

### Reporting a bug

Bugs start in **[Discussions › Bug Reports](https://github.com/MonkyOrg/Monky/discussions/categories/bug-reports)**, not in Issues.

The path is: you report it → someone from the project confirms it reproduces →
it becomes an issue labelled `bug` and enters the fix queue.

That confirmation step exists to separate real defects from network
misconfiguration, outdated versions or misunderstandings — things that eat the
queue without being bugs. Report anyway when you are unsure: finding out it was
not a bug is a result too.

**There is no voting on bugs.** The category exists for triage, not for a
popularity contest: a confirmed problem gets fixed regardless of how many people
voted for it. Votes are for ideas, where the question is *what to do first* — for
a bug the question is only *is this broken?*.

---

## 💻 Contributing code

### Running the project

Requirements: **Node.js 22+** and your platform's native build tools (the
screen-audio capture module is C++: MSVC on Windows, Xcode Command Line Tools on
macOS).

```bash
git clone https://github.com/MonkyOrg/Monky.git
cd Monky
npm install
npm run build
npm start
```

While developing, in two terminals:

```bash
npm run dev:server   # WebSocket + SQLite server
npm run dev:client   # Electron app with rebuild
```

Tests:

```bash
npm run test --workspace=apps/server   # server tests
npm test                               # everything, including the versioning tests
```

The Monky CLI lives in `apps/server/src/cli/` and is packaged separately:

```bash
npm run pack:cli     # builds the tarball that ships with the release
```

To try the CLI out without touching your real servers, point the `MONKY_HOME`
variable at a throwaway folder — that is where the machine's server registry
lives.

### Before you start coding

**Work from an issue.** If what you want to do is not an issue yet, open the
discussion first — it saves you from investing time in something that would be
turned down in review for being out of scope.

**If the issue is not clear, ask first.** Ambiguous requirements, vague
acceptance criteria or open design decisions are guaranteed rework. Never
assume — comment on the issue and wait for the answer.

**Do not pick up issues marked as blocked.** If you think one of them should
move, comment explaining why before starting.

### Opening the PR

`main` is protected — every merge goes through a squashed PR.

**Always branch from an up-to-date `main`**, never from whichever branch you
happened to be on:

```bash
git checkout main && git pull        # before creating the branch
git checkout -b feat/my-change
# ... commits ...
git push -u origin feat/my-change
```

Branching off a branch that has an open PR makes your PR drag its commits into
the diff, and the two then depend on each other to merge. If your change really
does depend on another open PR, agree on the stacking before you branch.

Branch and commit prefixes follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `ci:`. Reference the issue in
the title when there is one: `fix(voice): restore microphone on undeafen (#89)`.

**The commit type decides the published version** — it is not just a naming
convention. The release workflow reads the messages since the last tag and works
out the SemVer on its own:

| Commit message | Version effect |
|---|---|
| `feat:`, `feature:`, `minor:` | **minor** — `1.X.0` |
| any type with `!` (`feat!:`, `fix!:`, …), `major:`, or `BREAKING CHANGE:` in the body | **major** — `X.0.0` |
| anything else (`fix:`, `docs:`, `chore:`, `refactor:`…) | **patch** — `1.0.X` |

Note that **patch is the default**: every merge into `main` publishes some
version, even if it is a documentation commit.

**Every commit moves the number, one step each.** The count does not just take
the highest type in the range: a PR with three `fix:` takes `1.0.0` to `1.0.3`,
and one with two `feat:` followed by three `fix:` takes it to `1.2.3`. Since the
steps are applied in the order the commits were made, order matters — a `feat:`
after a `fix:` resets the patch it had just added.

This holds under **squash** too, which is how `main` receives every PR. The merge
collapses the PR into a single commit, but GitHub keeps the list of the original
commits in the message body, and that list is what gets read. If you rewrite that
body by hand and drop the list, the whole PR is worth a single step again — the
one in its title.

The count starts from the **latest published release, betas included**. So a
`feat:` merged right after the `1.1.0-beta` beta ships as `1.2.0-beta`, not as a
second beta of that same `1.1.0`.

Betas are published as `vX.Y.Z-beta`, with no counter: since the base version
changes on every release, there is no second beta of the same version to number.

If your change breaks compatibility between client and server, it **must** ship
as a major. Labelling a breaking change as `feat:` publishes a minor, and anyone
who updates only one of the two sides can no longer connect.

### Release notes: two audiences, two texts

The **technical GitHub changelog** still comes from commits: keep the details,
`#123:` references in the body and compatibility information.
The **in-app recap** comes from separate files written for people who use
Monky, not for developers.

For a user-visible change, add a new file in `release-notes/`, such as
`release-notes/617-copy-version.json`:

```json
{
  "group": "novidades",
  "pt-BR": "Quer compartilhar sua versão do Monky? Clique nela para copiar. Sem decorar os números!",
  "en": "Need to share your Monky version? Click it to copy. No need to memorize the numbers!"
}
```

- Use `novidades`, `correcoes` or `outros`; empty groups are omitted.
- Write in **both languages**, using at most 280 characters per text. Explain
  what someone can do or which annoyance has gone away. Keep it short, natural
  and lightly playful, without inventing benefits.
- Do not include issue numbers, links, code or implementation instructions.
  Internal-only changes can stay in the technical changelog.
- Keep published files: **do not rename or reuse them** for a new change.
  The generator reads files added between the previous tag and `HEAD`;
  promoting a beta uses the previous stable tag and includes notes from the betas.
  Uncommitted files are not included when generating a release.

`node scripts/test-changelog.js` validates the format and note files.
`scripts/generate-changelog.js` publishes the translations in a hidden data
block in the release description, separate from the technical `Changelog`.
The client still fetches the installed tag through the GitHub API, with no
translation service. Older releases display a change count clearly labelled
as a summary and a button for GitHub details; we do not automatically translate commits.

### What CI checks

Every PR runs the **CI** workflow. Beyond the build, it has checks that block the
merge and tend to catch people off guard:

- **Build check (win/mac)** — build and packaging with `electron-builder --dir`,
  without publishing. Catches native build regressions before the merge.
- **Docs traduzidos em sincronia** — every page in `docs-site/` needs its PT/EN
  counterpart. Adding only one of the languages fails the PR.
- **Mudanca de protocolo exige release major** — touching `PROTOCOL_VERSION`
  without marking the change as major fails. Client and server require an exact
  match, so bumping the protocol is always a breaking change.
- **Discussion template slugs** — checks that the templates still point at
  categories that exist.

One known limitation: **macOS signing configuration cannot be validated by CI**,
because `Build check (mac)` runs `--dir`, which skips signing entirely. Only the
release exercises that path.

### Describe how to test it

In the PR (or the issue), include two sections:

- **How it was implemented** — a technical summary: files and areas changed,
  relevant decisions.
- **How to test** — step by step for validation: scenarios, expected results and
  edge cases.

This is not bureaucracy: whoever validates the change tests from the **published
build**, not from your environment. Without the steps, validation stalls.

> The project's working language is Portuguese, so these sections are written in
> PT-BR in the repository. If you are more comfortable in English, write them in
> English — being clear matters more than the language.

### After the merge

Pushing to `main` triggers the **Release** workflow automatically, which builds
and publishes the new version with the Windows and macOS artifacts. Validation
only starts **after the release is published** — never merely after the merge.

> 🤖 If you are an AI agent working in this repository, the complete and
> mandatory flow is in [`AGENTS.md`](AGENTS.md).

---

## 🧭 What Monky is (and is not)

Useful for calibrating proposals before writing them:

- It **is** a **P2P** voice, video, screen and chat app with a **self-hosted**
  server, for small groups of friends.
- It **is** private by construction: no central server, no mandatory account, no
  telemetry, no data collection.
- It **is not** a Discord alternative at scale — the WebRTC mesh is great for a
  handful of participants and bad for dozens.
- It **is not** a SaaS. There will be no infrastructure hosted by us that people
  are expected to use.

Proposals requiring a central server, sign-up or data collection go against the
project's reason to exist and will be turned down — even when they are good
ideas in the abstract.

---

## 📜 License

By contributing, you agree that your contribution will be licensed under the
project's [MIT license](LICENSE).
