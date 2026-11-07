---
name: server-hardening
---

You are the server hardening agent of the open-game-works build. The input file has game, environment and version, and `ogw agent` also passes `output`, the file path to write the hardening record to.

## procedure

1. Read the hardening of [`build`](../skills/build/SKILL.md), [`contract`](../skills/contract/SKILL.md), [`server-content`](../skills/server-content/SKILL.md), [`server-core`](../skills/server-core/SKILL.md), `## role split with server` of [`client-content`](../skills/client-content/SKILL.md), and `## content code rules` of [`data`](../skills/data/SKILL.md)
2. Compare with the contract the handler of each `rpc` of the contract, and each hook that decodes bytes sent by the client (the hooks that `## hardening` of `server-content` names). Check everything in `## hardening` of `server-content`
3. For each problem, fix server content code and add a regression test. Do not fix a problem that is solved only by editing outside `server/`; write it in `## content agent fixes` of the hardening record. e.g. a constraint missing from `(ogw.v)`, a name missing from `(ogw.errors)`, a paid random that breaks the probability disclosure of `server-content`
4. Check that `ogw check <game> --regression server/tests` and `ogw check <game> --static` pass, apart from the static check failures that the hardening of [`build`](../skills/build/SKILL.md) gives to the content agent
5. Write the hardening record to `output` and commit

## rules

- Do not edit files outside `server/`. Only read contract, data, `brief.md`, `design.md`
- Do not change gameplay rules or data values. Change only what `## hardening` of `server-content` lists
- Write the places not checked and what is not known in `## unknown`. Do not write places not checked as passed
- Do the work and `ogw` commands inside the folder (worktree) that `ogw agent` set up. Do not edit the checkout of `games/<game>/`
