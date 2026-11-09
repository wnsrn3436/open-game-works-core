---
name: host-env
description: Holds the procedure in which the lead agent of the `update env` command checks this host, gets the local models and programs of harness settings and actually runs them, and, when they do not match, proposes a harness settings revision to the human. Read when receiving `update env`
---

# host env

`update env` is a command outside the loop. Harness settings are edited only with the revisions that a human accepted.

## procedure

1. Check the host with `ogw env check`
   - When a program among `buildTools` whose `hosts` has this host and that has no `downloads` is not on this host or has a different version, tell the human the program and version to install
2. agent settings: propose the agent CLI, model and effort of the 10 settings that hold them (`agents.<role>` of each role, `loop.judgePanel`) for the base CLI
   - Ask the human to confirm the base CLI that step 1 gave: the agent CLI that this lead agent runs in. When it is `unknown`, ask which of `claude-code` and `codex` it is
   - When step 1 gave the base CLI or the other agent CLI as behind its latest published version, its model list may lack the newest models: tell the human the update command that step 1 gave, and after the human has updated that CLI, run step 1 again before the mapping
   - Map each tier of `## agent tier` to a model of the base CLI in the model list of step 1 and an effort of that model, and propose, with `cli` in every value:
     - `agents.<role>`: the model and effort of the tier of that role
     - `loop.judgePanel`: `[]`, so that every judge runs with `agents.judge`. When the human wants judges that mix models and efforts (e.g. for a recommendation of `ogw judge calibrate`), items of the base CLI that mix the models and efforts of the top tier, at most half of harness settings `loop.judgeVotes` items, so that every item judges
   - Write each model as the model id of the model list, not an alias, so that a model changes only when a setting changes
   - Show the human the current value (`ogw settings get harness <path>`) and the proposed value of each of the 10 settings, and write the accepted values with `ogw settings set harness <path> <JSON value>`. These paths are local scope: they go to `settings.local.json`, and `settings.json` keeps its defaults. When a value changed, run `ogw env check` again, so that its prompt runs and step 7 check the written values
3. With `ogw env install-engines --background`, get the engines and the programs among `buildTools` of `engine.json` whose `hosts` has this host and that have `downloads`. Start it together with step 4
4. With `ogw generation install --background`, get harness settings `tools` and the `pins` of `resourceGeneration`. A method that it could not fetch is left as failed. An `external-service` method without `provider` has nothing to get; check that its `secret` is in the host secret store, and when it is not, tell the human to put in a non-empty value with `ogw secret set --harness <secret name>`. To fetch only one method again, use `ogw generation install <method> --background`
5. When the job of step 4 ends, run the standard test task of each method stage by stage with `ogw generation measure [--allow <method,...>] --background`. `--allow` is the `external-service` methods whose calls the human allowed. To measure only a few methods again, use `ogw generation measure <method>... [--allow <method,...>] --background`
   - For an `external-service` method, first tell the human the cost of one test call, and pass only the allowed methods with `--allow`
   - For a method with `provider`, tell the human the billing of its calls from step 1 before asking: `subscription` uses the usage of that subscription, `per-call` bills each call to that key, and for `unknown` the human has to check the login. Call only the allowed methods
6. When the jobs of steps 3 and 5 end, measure the benchmark index of this host with `ogw env benchmark` (it needs `tools.chromium` of step 4), then the number of instances that can be started concurrently with `ogw instance measure --background`
   - Before it starts, tell the human the accesses that the sandbox blocked in step 5 and the files that differ from the pinned information in step 4
   - Before it starts, show the human the current harness settings `instanceMeasureLimit` of this host (`ogw settings get harness instanceMeasureLimit`) and its meaning, and ask whether to change it, and write an accepted value with `ogw settings set harness instanceMeasureLimit <value>`. A host with more CPU cores and memory can be given a larger value; the measurement may start that many instances that render the screen together, so a value well above what the host can run makes the measurement long and the host slow while it runs
7. With `ogw env propose`, get the revisions and notices that compare the results of steps 1 to 6 with harness settings. The tool gives, per revision, an id, the harness settings path, the current value, the new value and the reason, and the notices below. It gives no revision or notice for a step without a result.
   - notice `no-benchmark`: there is no target measured in step 6. `update env` has to run again after `create client core`
   - notice `no-loop`: the smallest of the target values measured in step 6 is less than 2. This host cannot run the loop
   - notice `no-method`: the list of resource types that the methods of harness settings `resourceGeneration` cannot make
   - notice `docker`: Docker or `docker buildx` is missing, or the GitHub CLI login has no `write:packages` scope. It has to be installed, or logged in with `gh auth refresh --scopes write:packages`
   - notice `udp`: the list of android devices that UDP does not reach. The check `device performance` of a realtime game becomes `unknown`, so the devices have to be on the same LAN as the host
   - notice `agent-cli`: the agent CLIs that did not finish in an empty folder, the settings that use each (the roles of harness settings `agents`, the items of `loop.judgePanel`), and their error output
   - notice `agent-cli-version`: the agent CLIs whose installed version is behind the latest published one, with both versions, the install source and the update command, as step 2 handles them
   - notice `agent-login-token`: the agent CLI of play, of judge or of an item of `loop.judgePanel` is Claude Code, and the harness secret `claude-code-oauth-token` is not in the host secret store (`missing`), or the value cannot be an HTTP `Authorization: Bearer` header value or Claude Code failed authentication in the check of step 1 (`invalid`), or the check failed for another reason (`unverified`; the error is given with it). For `missing` and `invalid`, a human has to make a long-lived token with `claude setup-token` and put it in as one line with `ogw secret set --harness claude-code-oauth-token`. For `unverified`, a human has to check that error. Without this secret, `ogw loop start` and `ogw judge calibrate` do not start
   - notice `pin-secret`: the hf pin `secret` values that are not in the host secret store, and the repository of each pin. A human has to accept the license on the page of that repository on Hugging Face and put in the access token of that account with `ogw secret set --harness <secret name>`. When `update env` runs again after that, step 4 fetches that method, and step 7 gives the `sha256:<method>` revision
   - notice `provider-cli`: the provider CLIs that are not installed or not logged in, or whose billing in step 1 is `per-call`, or `unknown` while logged in, and the methods that use them. For a CLI that is not installed or not logged in, a human has to install it and log in. For `per-call`, it names the login that makes the calls use the subscription instead (`codex login` with ChatGPT, `grok login`). For `unknown`, a human has to check how that login bills the calls
8. Decide the revisions that the tool does not give
   - a failed method: a revision that removes it, or a revision that fixes `pins`
   - when `tools.chromium` is missing or could not be fetched: a revision that adds the pinned information of Chrome for Testing `chrome-headless-shell` for the OS of this host
   - a method outside `catalog` whose `license` is missing or `unknown`: a revision that fills `license` by `## resource rights` of [`resource`](../resource/SKILL.md) and the license references that `ogw settings describe harness resourceGeneration.0.license` prints. For a method with pins and without `provider`, it holds the model card license of its pins. For a method with `provider`, it is the license reference of the output terms of that provider, not the license of the code that its pins fetch
   - each setting that notice `agent-cli` names: a revision that changes that setting to another model or effort of the same CLI when the error output says that CLI rejects the model or effort, and otherwise to another CLI
9. Ask the human which method makes the images of the games that have no image yet (harness settings `imageMethod`). The choices are `flux2-klein` and the methods with `provider` whose `resourceTypes` has `image`, among those that have an `ok` stage in the results of step 5. Give a recommendation and these points:
   - a method with `provider` draws better images and in the same style as the sprite animations that the same provider makes, and uses the usage of that subscription. When the usage limit is reached, `flux2-klein` makes a temporary image when it has an `ok` stage, and the next `update game` makes it again; without `flux2-klein`, the work waits until it can call again
   - `flux2-klein` is free, has no usage limit and runs offline, and draws lower quality images
   - the method of a game is fixed by its first image, so a change applies only to games without images
   Write the answer with `ogw settings set harness imageMethod <method name>`
10. preference settings: show the human, per path below, the current value (`ogw settings get harness <path>`) and its meaning (the description of `ogw settings describe harness <path>`), ask which to change, and write the accepted values with `ogw settings set harness <path> <JSON value>`
   - `humanLanguage`
   - `loop.funIterations`, `loop.variants`, `loop.playTimeLimitMs`, `loop.judgeTimeLimitMs`
11. Show the human the measurement results, the revisions and notices of step 7, and the revisions of step 8. Apply the revisions of step 7 that the human accepted with `ogw env propose --apply <id,...>` and those of step 8 with `ogw settings set harness`, then commit `settings.json` when it changed. `--apply` writes, per revision, only the parts where the current value and the new value differ, so revisions with the same path are also applied together. When revisions whose differing parts overlap are given together, it writes nothing and fails. In that case apply them one at a time, and run `ogw env propose` again after each one
12. After the human has seen them, delete the folders that `ogw generation measure` printed as `output` per stage. Keep the file it printed as `result`, which later measure runs and `ogw env propose` read

## agent tier

| tier | roles | model | effort |
|---|---|---|---|
| top | content, resource, judge, server-hardening, client-hardening, core, review | the most capable model of the CLI | `high` |
| middle | translation, play | a model of the CLI that is faster and uses less of the subscription usage than the model of the top tier, and is not the smallest model of the CLI | `medium` |

A larger model and a higher effort give higher quality, and take longer and use more of the subscription usage. A model that has no effort of that name in the model list gets the nearest effort it has.
