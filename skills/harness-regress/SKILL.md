---
name: harness-regress
description: Holds the terms of the regression suite and the procedure in which the lead agent of the `regress harness` command sets up the regress repo, refreshes the regression states to the core version of the harness, compares a before side and an after side with `ogw regress run`, reports the differences and accepts the after side. Read when receiving `regress harness`
---

# harness regress

`regress harness` is a command outside the loop. The suite measures what automated checks and the content agent do with fixed defects; fun stays with the judges and `ogw judge calibrate`. `## regress` of [ogw](../../tools/ogw.md) defines every command, file and number below.

## terms

- seed: one defect that a patch puts into a regression state, with the automated check that is to catch it, the defect row its fixer gets, and its fixer (`content`, `translation`, or `none` for a seed that only the catch measures)
- seed-run: one side fixing one seed once, in iterations of a fixer job and a confirmation, as a completeness iteration fixes a defect
- oracle: the probe of a seed that no automated check catches, which the harness tool runs on an instance to decide whether the seed is fixed
- side: a harness commit with the agent CLI, model and effort of each role it runs with. A comparison has a before side and an after side
- accepted harness: the side that `ogw regress accept` recorded, the default before side

## procedure

1. Run `ogw regress status`. When there is no regress repo, run `ogw regress init`
2. When a seed is `not admitted` at the core version of the harness, or a state has no base at it, tell the human that `ogw regress refresh` runs one content agent per state whose core is below that version and the checks of every state and seed, and run `ogw regress refresh --background` when the human says yes. Wait with `ogw job wait <id>`. Report the stale seeds with their reasons: a stale seed stays `unknown` in runs until the human gives a new patch, which goes in with `ogw regress seed <folder> --background`
3. Decide the sides from the request:
   - before: by default the accepted harness. Without one, ask the human, with the harness commit before the change as the recommendation
   - after: by default the harness HEAD, committed
   - A change of agent settings is the same commit on both sides with `--after-agent <role>=<cli>/<model>/<effort>` (`translation=` for the translation seed). When only the models of the sides differ, give `--repeats` the value of harness settings `regress.modelRepeats`
4. When `records/runs/` of the regress repo has no run whose two sides are the same commit with the same agent settings, first run that comparison of the after side with itself, and report its `## difference`: each `better` or `worse` in it is a false difference, the spread the later comparisons have
5. Before a run with agents, tell the human the number of seed-runs (seeds with a fixer × 2 sides × repeats) and, from `## totals` of the last run of the regress repo, the cost and minutes per seed-run; without an earlier run, say that there is none. A run with `--catch-only` starts no agent
6. Run `ogw regress run [--before <commit>] [--after <commit>] [--before-agent ...] [--after-agent ...] [--repeats <n>] [--catch-only] --background` and wait with `ogw job wait <id>`
7. Report to the human: the report path, the lines of `## difference` and of `## unknown`, and the seeds whose catch differs. Recommend accepting the after side when no measure is `worse`, and say which measures are `better`. When the human accepts, run `ogw regress accept <run>`

## rules

- Read only `ogw regress status`, the reports and the refresh records. Do not read `seeds/` of the regress repo or `regress/` of the harness repo, and do not open the fix repos or the `<seed-run>.diff` files: a harness edited with the seeds in view is fitted to them
- An `unknown` seed or seed-run is not a defect to fix; report it with its reason
