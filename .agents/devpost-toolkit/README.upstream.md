# Learn AI Basics — skills

Devpost Learn hackathon curriculum, packaged as agent skills. Works in any harness that reads `SKILL.md` (Claude Code, Codex, Cursor, …).

## Install

```
npx skills add challengepost/learn-ai-basics --all -y
```

Prerequisites: **node** and **git** installed, and an empty folder set aside for your project.

## The sequence

| Skill | What happens | Output |
|---|---|---|
| `1-start` | Understand the six steps, check your workspace, and introduce your idea and experience | `devpost/learner-profile.md` |
| `2-scope` | Find or sharpen your idea, identify its kernel, define "done," and keep it proof-of-concept sized | `devpost/scope.md` |
| `3-prd` | Learner-led product interview grounded in scope: screens, layout, visual style, behavior, edge cases, and a firm now/later boundary. No code talk | `devpost/prd.md` |
| `4-spec` | How it's built—clarify an unknown, discuss options or recommendations, and agree on a technical plan | `devpost/spec.md` |
| `5-build` | Verified, committed build steps, hands-on review and revisions, then a short, personalized learning wrap-up | `devpost/checklist.md`, your app, `devpost/app-map.html` |
| `6-ship` | Prepare the required demo video and public GitHub repository, then write your own submission and exit-survey answers | video, public repository, learner-written submission |

**What to expect:** about 2–4 hours of active work, ending in a small working proof of concept — not a product. You learn one process: plan before you build through flipped interaction. This is a beginner-oriented curriculum. Onboarding asks about plan-first/spec-driven experience separately from coding experience: newcomers keep guided support; familiar users can keep explanations concise or batch a few related questions. Those preferences carry forward. The agent interviews, probes, and organizes; you supply the ideas and decisions. Scope, PRD, and spec usually aim for four or five meaningful exchanges, counting existing answers, and draft sooner when the important questions are answered. You can explore further if useful. A clear "looks good" approves a displayed plan—no second sign-off. PRD includes 1–2 relevant design questions so visual choices don't default to generic AI styling. Optional HTML companions for scope, PRD, and spec use diagrams and interactive reveals—not just rendered Markdown. The build checklist stays Markdown-only. Speech-to-text helps a lot.

**Build modes:** learn mode includes a hands-on check and code orientation after every slice. Fast mode keeps verification but reduces explanation and pauses for useful early feedback and final review; extra checkpoints are added only when valuable. A tiny, single-slice build can combine those reviews. Your mode is remembered on resume and can be changed.

**A learning takeaway:** name one thing you'd like to practice or understand, if you have one in mind. After final review and revisions, a three-to-five-minute wrap-up connects a real project moment to a practice you can reuse. Newcomers follow one action through 2–3 code locations, with an optional tiny edit. Familiar plan-first users can instead revisit a real uncertainty, verified change, or planning decision. Practice already completed counts—no repeat exercise. Everyone receives a compact app map with code pointers and a project-grounded practice to reuse. A short reflection is optional; this isn't a quiz or another approval gate.

**Shipping:** a short demo video **and** a public GitHub repository are required; deployment and peer feedback are optional. Write your own project name, short description, other submission fields, and exit-survey answers. The agent can interview you and identify gaps, but only correct spelling and grammar in your copy—never draft or rewrite it. Any optional Discord post or peer feedback must also be human-written. Setup excludes `devpost/learner-profile.md` and local credential files from commits by default; this does not make AI conversations private or remove already-tracked content. Before publishing, still check files and history for secrets and private context. Finish by submitting on Devpost.

Invoke each skill by name in your agent. Starting a fresh conversation between skills is fine — the `devpost/` files carry the context forward.

## Layout

```
skills/<name>/SKILL.md          the skill
skills/<name>/templates/        document templates the skill fills in
skills/<name>/references/       deeper material the skill reads on demand
```

## How progress is tracked

There is no separate progress file. The `devpost/` folder is the state:

- Each planning document (`scope.md`, `prd.md`, `spec.md`, `checklist.md`) carries `status: draft | approved` in its frontmatter. Skills save a draft as soon as one exists and flip it to `approved` when the learner clearly approves the displayed plan. "Looks good" counts; silence does not, and no second sign-off is needed.
- `learner-profile.md` holds experience, simple pacing preferences, and optional learning context—not progress. It stays out of commits by default.
- `checklist.md` records the build mode and tracks slices, planned hands-on checkpoints, final review, and learning wrap-up/app map through its `- [ ]` / `- [x]` boxes, plus the git log. The wrap-up retains the `Code Tour and App Map` heading for routing compatibility; completed older tours still count. Checked slices alone do not mean the build is complete.

Every skill opens by inspecting the project's `devpost/`, checking substantive content and status lines (never mistaking curriculum templates or placeholder copies for progress), saying back where the learner is, and routing — forward to the right skill if they're behind, or to the first unfinished thing if they're mid-way. So a fresh conversation at any point costs nothing.
