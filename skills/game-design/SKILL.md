---
name: game-design
description: Holds the format of the documents the content agent writes (brief.md, design.md, play-guide.md, core proposal, assumption in the loop) and the criteria for deciding without asking the human. Read when designing the game or editing documents in the loop of `create game` and `update game`, and when the lead agent of `update core` looks at the core proposal format
---

# game design

## brief

`brief.md` has the headings below in this order. In `create game`, `ogw loop start` writes a draft that has every heading and fills the name and path in `## reference game` and the original request text in `## request`. The content agent fills the rest.

| heading | contents |
|---|---|
| `## player fantasy` | One sentence. When one existing game title sums it up, rewrite it |
| `## emotion` | One core emotion and the emotional curve over one round |
| `## memorable moment` | One moment the player is to remember |
| `## genre conventions` | Per genre convention, one of `accept`, `twist`, `reject` and the reason. When all are `accept`, rewrite it |
| `## prohibitions` | Two or more prohibitions. One of them removes a standard feature of the genre |
| `## failure penalty` | The share of progress lost per mistake, the duration limit (ms) of the loss state, and the delay limit (ms) from the end of the loss until control is possible again. A game without a failure state writes `no failure state` on the first line and does not write the three values |
| `## prediction` | A sentence in the form "if it works, the player will do something". Written so that play can check it |
| `## reference game` | The reference game name in `records/setup/reference/reference.md` and its file path (in the draft). What this game does differently from the reference game |
| `## request` | The original text of the human's request (in the draft), and the items that the content agent decided because the request did not have them |

- When the failure penalty rejects (`reject`) or twists (`twist`) a failure pressure convention (death, timer, game over, penalty), write the replacement pressure and its multiplier as numbers under the same heading

## design doc

`design.md` holds the whole current design state of the game. It is not completed in advance; write only what is made and what is to be made.

It has the headings below in this order. Under a heading not decided yet, write `none`.

| heading | contents |
|---|---|
| `## overview` | Genre, one-line introduction, target platforms, screen orientation, base resolution |
| `## core loop` | The repeated play flow and the target duration (ms) of one cycle |
| `## controls` | The action per input. Differences per platform |
| `## screens` | The scene list and the moves between scenes. Per scene, the behavior of screen elements on failure, rejection, duplicate input and input during presentation |
| `## systems` | The rules and formulas per system. Per formula coefficient, the corresponding data table column. The shared formula name of each formula that client and server calculate together |
| `## progression` | Growth curve, unlock order, tutorial steps |
| `## economy` | Per item, its sources and sinks. Purchase limits, product kinds |
| `## new user` | The initial state of a new user and the server request that makes it |
| `## feel targets` | The target table of presentation and response |
| `## tuning targets` | The target table of balance and pacing |
| `## art direction` | Style, hex palette with a role per color (background, panel, accent, danger, reward, text), outline, proportions, light direction, camera view, screen density, representative resource keys, and the style block: one English paragraph that every image prompt starts with. Style, palette, mood and character models follow `records/setup/art-direction.md` |
| `## audio direction` | Mood of BGM and sound effects, BGM per scene, list of events that make sound |
| `## terms` | The core nouns the game uses and the words it does not use. Terms to put in the glossary |
| `## core usage` | Registered hooks. The core modules used are kept in game settings `coreModules` |

- `## feel targets` and `## tuning targets` are tables with the columns `metric`, `min`, `max`, `data`. `metric` is one metric name below, `min` and `max` are integers, and `data` is the data table and column that change that value, or an empty cell when there is none. e.g. `reward_interval_ms` | 30000 | 60000 | `stage.reward_every`
- A goal that cannot be measured by a metric is not written as a target. When editing, bring the value of `ogw measure` into the range
- Metrics are calculated from the telemetry and `QAState` of the play instances that `ogw measure` started without a save fixture. When there is no value, the metric is `unknown`. When the number of values is even, the median is the smaller of the two middle values

| metric | value |
|---|---|
| `input_latency_ms` | The median of the input `latency_ms` values that are not `null` |
| `no_response_permille` | The number of inputs whose `latency_ms` is `null` × 1000 ÷ the number of inputs. The remainder is dropped |
| `feedback_per_input` | The median of the per-input sums of the number of `feedback` |
| `first_reward_ms` | Per instance, the `play_at` of the first `rewards` (ms elapsed since the telemetry start). The median of those values |
| `reward_interval_ms` | Per instance, the `play_at` difference of each two consecutive `rewards`. The median of all those values |
| `goal_interval_ms` | The median of `duration_ms` of `goal_intervals` |
| `goal_input_count` | The median of `input_count` of `goal_intervals` |
| `fail_count` | Per instance, the number of `Fail` marks. The median of those values |
| `restart_delay_ms` | The median of the `play_at` difference from a `Fail` mark to the first `Restart` mark after it |
| `idle_span_ms` | The median of `duration_ms` of the `idle_spans` that have `end_at` and whose `start_at` is at least the `at` of the first `inputs` of that instance. 0 when there are no such `idle_spans` |
| `scene_load_ms` | The maximum of `duration_ms` of `scene_loads` |
| `content.<field>` | Per instance, the `<field>` integer of `QAState` `content` when play ends. The median of those values |

- Numeric values are kept in data; the design doc holds the target range and the data table name
- A formula that client and server calculate together is written in integer arithmetic. Multipliers are permille integers
- For play whose result client simulation decides, write in `## systems` the data table column that holds the upper limit per result value, whether `verify_play_session` recalculates the result to verify it, and, among the ranking boards that take a result value as score, the boards that have a row in `ranking_reward`. When such a board exists, `verify_play_session` recalculates the result to verify it. When there are pre-round choices (e.g. booster) or continue, write the effect and cost of each choice of `PlaySessionStartOptions` and `PlaySessionContinueOptions`, and `max_continue_count`
- For the table used as `level_id` of `StartPlaySession`, write the difficulty curve across its rows in `## systems`. The per-row difficulty target is kept in the row simulation target column of that table, not in `## tuning targets`. The format is `## row simulation` of [`client-content`](../client-content/SKILL.md)
- A realtime game writes `result_rule`, `allow_queue`, `allow_room` in `## systems` per `match_mode` row. A mode whose match result changes rating, ranking score or items has `result_rule` `ServerReplay`, keeps the match simulation as a shared formula, and has `allow_room` `false`. `Consensus` and `Majority` are used only for modes whose match result does not change saved state
- The queue and room of `matchmaker` group only users whose data version and app version in `HELLO` are the same. While a new app version spreads through the store, the user pool is split per app version and match waits grow long. A realtime game writes in `## systems`, per mode, the handling of match waits during that period (e.g. a `min_players` match after `match_wait` passes, a bot opponent)
- `apply_match_result` of a `ServerReplay` mode with 3 or more participants treats a participant in `participants` whose `input_log` is not empty bytes and differs from `replayed_input_log` of the match record as having sent a tampered report. It gives that participant a penalty and counts the penalties per user in content state. That penalty, the handling when the count reaches a number (e.g. matching restriction) and that number are written in `## systems`
- A rating season is one period of the `cycle` of the `ranking_board` that is the `season_board` of `rating_rule`. The longest period in `ResetCycle` is `Monthly`, so a rating season does not exceed one month. The season length is decided within this
- The genre's standard reward and product structures are made with core modules. The daily login reward is `attendance`; a 30-day monthly subscription is a `Consumable` `iap_product` with `pass_days` and `daily_reward`; a limited-time product opened only to users who came to meet a condition is `offer`; the interstitial ad exposure interval is the pacing column of `ad_placement`. A season pass is the combination of `mission` bound to the same `live_event` (progress counter and step rewards), the `requirement` of the premium step `mission` (a `RequirementType` that content registered to judge with the `iap` operation `get_purchase_count`), and an `iap_product` for the premium purchase. The premium product is `NonConsumable` when the `live_event` has no `repeat`, and when it has `repeat`, a `Consumable` with `limit_count` 1 bound to the same `live_event`. Then progress, claims and the premium purchase count return to the start each round
- The genre's standard progression and currency structures are also made with core modules. A count with a limit per reset cycle (daily entries, gifts, stamina purchase steps) is `reset-counter`; a premium currency split into paid and free is a group item whose `members` order is the consumption order; a timed effect such as N minutes of unlimited lives is a timed item; an amount that can exceed 2^53−1 (balances, and costs, rewards and production amounts in data) is a big item amount; and large numbers are displayed with the `compact` formatter
- The paid member item of a group item is granted only through `reward` and `daily_reward` of `iap_product`
- When an amount that can exceed 2^53−1 (a big item balance and its accumulation) is used as a ranking score, mission progress or unlock criterion, convert it to a big order value. The big order value is v when v < 10^12, otherwise (number of decimal digits of v) × 10^12 + (first 12 digits of v). It does not decrease as v grows, and when v has 9006 digits or less it is 2^53−1 or less. Ranking submits the big order value with `submit_score`. A mission passes the big order value to a `Max` counter and sets `target` to the big order value of the criterion amount. An unlock is judged by a content `RequirementType` that receives the big order value of the criterion amount as `value`
- The web has no ads, store payment or push notification. When the target platforms include web, design so that the core loop and progression continue on web without ad rewards, paid products or push notifications, and write the web's sources in `## economy` as a platform difference

## play guide

`play-guide.md` is a document of facts, written so that the play agent can play the game right after seeing it for the first time. When the game changes, it is edited in the same commit.

It has all the headings below in this order. Under a heading with no content, write `none`.

| heading | contents |
|---|---|
| `## goal` | What the player is to achieve |
| `## controls` | Inputs and their results |
| `## game flow` | The scene order from the first screen to the end, and per scene the input that moves on to the next |
| `## failure` | The states in which the player fails, and the input that restarts after a failure. `none` when `## failure penalty` of `brief.md` is `no failure state` |
| `## input lock window` | The spans in which input is locked on purpose (title, cutscene, turn wait, presentation) and their length (ms) |
| `## fastest start path` | The shortest input order from the first screen to actual play |
| `## play mode` | Per scene, the mode (`free`, `step`, `script`) and, for `step`, the step ms to advance at a time |

- Do not write evaluative sentences (fun, quality, difficulty assessment, whether it can be cleared)
- A fact that was not checked gets `unconfirmed`
- `## play mode`: a scene where input needs a response within a set time (real-time action, realtime match) is `step`, a scene where the time gaps between inputs decide the result (rhythm, combo input) is `script`, and any other scene is `free`

## records

The content agent writes the records below to `records/` of the game repo.

| record | path | contents |
|---|---|---|
| assumption | `records/loops/<run>/assumptions.md` | assumption format |
| core proposal | `records/core-proposals/<unix ms>-<slug>.md` | core proposal format |

`<run>` is the `run` that `ogw agent` passed.

### assumption

- One item is one `## <question>` heading and the two lines under it, `- decision: <what was decided>` and `- evidence: <evidence>`. `<question>` is what was not known, written on one line
- An item that a human has to check gets ` (needs human)` at the end of the heading line

### core proposal

- heading: `## target` (core module), `## kind` (`bug`, `feature`, `schema`), `## problem` (what is missing or wrong in core, and why this game needs it), `## proposal` (the spec content to change), `## workaround` (the workaround done now in content code)
- When `kind` is `feature` or `schema`, write a core proposal only when the target feature is a feature that AGENTS.md `## purpose` puts in core. Write any other feature as content code without a core proposal
- The first line is `status: proposed`. When a human accepts it and `update core` releases it, `ogw core proposal released` changes the first line to `status: released` and adds `version: <major>.<minor>.<patch>` (the core version of that release) as the second line
- The loop does not stop after a core proposal is written. Write the workaround in content code and go on

## deciding without asking

Inside the loop, the human is not asked. When a decision is needed, follow the first line in the order below that matches.

1. There is an answer that a tool can count: check with the tool and decide. When the same check comes up a second time, write in a core proposal or the report that it is to be made an automated check
2. A genre convention or a platform document has the answer, and the decision can be reverted: decide and write it in an assumption
3. It is a number whose correctness is known only by measuring: decide with the genre's conventional value. When there is a metric that the value changes, write a target in `## tuning targets` and fix the value with the value of `ogw measure`; otherwise write it in an assumption and fix it with the play result
4. Money, brand, law, real names, resource rights, or art identity not in `records/setup/art-direction.md` is involved: decide with a temporary value and write it in an assumption with `needs human`

- When a name cannot be decided, use a generic noun of the genre temporarily and write it in an assumption
