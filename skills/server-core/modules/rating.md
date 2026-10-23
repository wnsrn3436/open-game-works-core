# rating

- purpose
- dependency
- API
- behavior
- hook
- event
- error
- settings
- data
- DEV
- test

## purpose

Stores a user's rating per rating rule defined in data, updates it with an Elo calculation from judged match results, and decides the tier from the rating. When the season of a `ranking` board changes, does a soft reset and sends the tier reward of the past season by `mailbox`.

## dependency

- `storage`
- `ranking`
- `mailbox`
- `validation`
- `logging`
- `matchmaker`

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `RefreshRating` (core rpc, `silent`, `retry`). changes: `MailUserState`, `RatingUserState` | none | empty response | none | `routing`. Client content code sends it |
| `get_rating` | ctx, rule ID value | `RatingView` | Throws when the rule ID value is not in `rating_rule` | content handler, hook, `matchmaker` |
| `apply_match_outcome` | ctx, match record from `matchmaker`, participant index, placement list (integers in participant index order) | `result` (`RatingResult.OK`), `change` (`RatingChange`) | failure element of `RatingResult` | content handler, hook |

- rule ID value: an ID value of the `rating_rule` table
- `RatingView`: `rating`, `tier_id` (tier ID value. 0 when there is no tier), `season`, `season_games`, `placement` (`true` when `season_games` < `placement_matches`)
- `RatingChange`: `before`, `after` (the rating before and after applying), `tier_before`, `tier_after`
- placement: the participant's rank. Smaller is ahead, and equal is a draw. e.g. for a 1v1 win and loss, the winning participant is 0 and the losing participant is 1
- match record: the match record input that the `matchmaker` hooks `apply_match_result` and `apply_match_mismatch` received. `rating` reads its `mode_id`, `user_ids`, `ratings` and `teams`. The number of participants is the number of `user_ids`

`RatingResult`

| element | meaning |
|---|---|
| `OK` | Applied |
| `NO_RATING` | The `rating_rule` of the `match_mode` row that is the `mode_id` of the match record is `null` |
| `INVALID_INPUT` | The participant index is outside the number of participants, or the ctx user is not the user of that index, or the number of placements differs from the number of participants, or there is a negative placement |

## behavior

- `once_key` prefix: `rating:`

### state

- The rating is stored in the core UserState kind `RatingUserState` (list kind) of the base proto. Only this module writes it, with `storage.put_core_state`. field: `int64 id` (rule ID value), `int64 rating`, `int32 tier_id`, `int64 season` (the season number when last written), `int32 season_games` (the number of matches applied in that season), `int32 total_games`
- When there is no row, `rating` is the rule's `initial_rating`, `season` is the current season, and both match counts are 0
- current season: when the rule has `season_board`, the season number that `ranking.get_season`(ctx, `season_board`) returned; otherwise 0
- tier: among that rule's `rating_tier` rows with `min_rating` ≤ rating, the row with the largest `min_rating`. When there is no such row, the tier ID value is 0
- Client content code finds the tier name in `rating_tier` by the `tier_id` of `RatingUserState`

### season settle

When a row is read and its `season` differs from the current season, it is read as the value with the following applied. The past season is the `season` of the row before settle.

1. The past season tier is the tier of the rating before settle
2. rating = `soft_reset_target` + the value of `validation.apply_permille`(rating − `soft_reset_target`, `soft_reset_permille`). When it is less than `min_rating`, it is `min_rating`
3. Sets `season` to the current season, `season_games` to 0, and `tier_id` to the tier of the new rating

- Even when the season changed several times, settle happens once, and the reward is the one for the single past season
- `get_rating` returns the value with settle applied and writes nothing, because `matchmaker` calls it inside `storage.run_rollback_transaction`
- `RefreshRating` and `apply_match_outcome` write the row with settle applied. At this time, when the `season_reward` of the past season tier row is not an empty array and the `season_games` before settle is the rule's `reward_min_games` or more, sends it with `mailbox.send_mail`. The template is the rule's `reward_mail`, and `args` is one `season` whose kind is `MailArgKind` `Int` and whose value is the past season number. `attachments` is `season_reward`, and `once_key` is `rating:<rule ID value>:<past season number>`. `ALREADY_SENT` counts as success
- `RefreshRating` applies settle to each `RatingUserState` row of that user. A row whose rule is not in `rating_rule` is skipped. Client content code sends it when entering a screen that shows the rating. So the season reward goes the first time that user's row is written after the season changes

### match outcome

`apply_match_outcome` processing order. On `INVALID_INPUT` or `NO_RATING`, changes nothing.

1. `INVALID_INPUT` when the input meets an `INVALID_INPUT` condition. The rule is the `rating_rule` of the `match_mode` row of the match record's `mode_id`; when it is `null`, `NO_RATING`
2. Reads the ctx user's row with settle applied
3. opponents: when `team_size` of `match_mode` is 0, all participants except that participant; otherwise, the participants whose team in the match record's `teams` differs from that participant's. Let m be the number of opponents. When m is 0, does not change the rating and skips 4 and 5
4. For each opponent j, S is 1000 when that participant's placement is less than j's, 500 when equal, and 0 when greater. E is 1000 ÷ (1 + 10^((R_j − R_i) ÷ `scale`)) calculated as a 64-bit float and rounded to the nearest integer. 0.5 rounds up. R is the value at that index of the match record's `ratings`. Floating-point calculation is used only for E
5. K is `placement_k_factor` when `season_games` < `placement_matches`, and `k_factor` otherwise. Σ is the sum of S − E over the opponents. Δ = `validation.floor_div`(2 × K × Σ + 1000 × m, 2000 × m). The new rating is the current rating + Δ; when it is less than `min_rating`, it is `min_rating`
6. Adds 1 each to `season_games` and `total_games`, sets `tier_id` to the tier of the new rating and writes the row

- Δ is calculated from the match record's `ratings` (the ratings when the match was made), so it is the same regardless of the order in which the participants are applied. `matchmaker` guarantees that apply happens once per participant
- Content code calls it inside `matchmaker.apply_match_result` and `apply_match_mismatch`. Content code decides the placement from `MatchResult` and the match record's `participants`

## hook

none

## event

none

## error

| condition | failure value | error code | log |
|---|---|---|---|
| `get_rating` with a rule ID value not in `rating_rule` | throw | `INTERNAL` | `error` log by `routing` |
| input error in `apply_match_outcome` | `INVALID_INPUT` | set by content | `error` log |
| `apply_match_outcome` for a match mode whose `rating_rule` is `null` | `NO_RATING` | set by content | `error` log |
| `INVALID_INPUT` from season reward `send_mail` | throw | `INTERNAL` | error rule of `mailbox` |
| failure of `validation.apply_permille` in step 2 of season settle | throw | `INTERNAL` | `error` log by `routing` |

Added `CoreError`: none

## settings

| key | type | source | owner | meaning |
|---|---|---|---|---|
| `mailbox.maxAttachments` | integer | core | content | limit on the number of `season_reward` elements of `rating_tier` |

## data

used table: `match_mode`

- Reads `id`, `team_size` and `rating_rule` of the `match_mode` table. `matchmaker` decides the header and the row rules

`data/tables/rating_rule.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `name` | `tstring<id>` | `Client` |
| `initial_rating` | `long` | `All` |
| `min_rating` | `long` | `All` |
| `scale` | `long` | `Server` |
| `k_factor` | `int` | `Server` |
| `placement_k_factor` | `int` | `Server` |
| `placement_matches` | `int` | `All` |
| `season_board` | `ref<ranking_board.id>?` | `All` |
| `soft_reset_target` | `long` | `Server` |
| `soft_reset_permille` | `int` | `Server` |
| `reward_mail` | `ref<mail_template.id>?` | `Server` |
| `reward_min_games` | `int` | `Server` |

- `scale` ≥ 1, `k_factor` ≥ 0, `placement_k_factor` ≥ 0, `placement_matches` ≥ 0, `min_rating` ≤ `initial_rating`, `min_rating` ≤ `soft_reset_target`, 0 ≤ `soft_reset_permille` ≤ 1000. When `soft_reset_permille` is 1000, settle does not change the rating
- The season of the board that `season_board` points to is the season of the rating. When it is `null`, there is a single season 0 and no settle
- `reward_min_games` is the minimum number of matches in that season needed to receive the season reward. It is 0 or more, and 1 or more when that rule's `rating_tier` has a row whose `season_reward` is not an empty array

format argument

| text | arguments |
|---|---|
| `rating_rule.reward_mail` | `{season}`(`integer`) |

`data/tables/rating_tier.csv`

| column | type | build target |
|---|---|---|
| `id` | `id(key)` | `All` |
| `rule` | `ref<rating_rule.id>` | `All` |
| `name` | `tstring<id>` | `Client` |
| `min_rating` | `long` | `All` |
| `season_reward` | `array<{item_id: ref<item.id>, amount: long}>` | `Server` |

- Rows of the same `rule` have different `min_rating` values
- For a row whose `season_reward` is not an empty array, `season_board` and `reward_mail` of its rule are not `null`
- The number of `season_reward` elements is at most `mailbox.maxAttachments`. Server start checks this rule, not the data check
- When a row violates the rules of `rating_rule` or `rating_tier`, the server does not start

reserved ID, reserved string, reserved sound: none

## DEV

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `set_rating` | ctx, rule ID value, rating | none | Throws when the rule ID value is not in `rating_rule` | content cheat handler, `testing` |

- `set_rating` writes the rating of the row with settle applied as that value, and `tier_id` as the tier of that rating. The season reward goes by the settle rules
- STG·PROD builds do not have `set_rating`

## test

- `get_rating` of a user without a row gives `initial_rating`, its tier and `season_games` 0, and `placement` is `true` when `placement_matches` is 1 or more
- In a 1v1 match of two participants with the same rating, the winning participant's Δ is `validation.floor_div`(2 × K × 500 + 1000, 2000) and the losing participant's Δ is `floor_div`(−2 × K × 500 + 1000, 2000); on a draw both are 0
- When R_j − R_i is `scale`, E is 91
- Swapping the apply order of the two participants does not change each one's Δ
- In a 4-player match with `team_size` 2, participants of the same team are not opponents
- `placement_k_factor` is used while `season_games` < `placement_matches`, and `k_factor` after that
- When the new rating is less than `min_rating`, it is `min_rating`
- After the season of `season_board` is advanced with `ranking.close_season_now`, `RefreshRating` writes settle once, and the `season_reward` of the past season tier goes by mail once. The mail's `args` is one `season` of kind `Int` whose value is the past season number. A second `RefreshRating` changes nothing. `RefreshRating` after the season is advanced twice also does settle and mail once, and the `season` of the mail and the season number in the `once_key` are the `season` of the row before settle
- After the season changes, `get_rating` returns the settled value, and the row and mail stay the same
- For a row whose `season_games` before settle is less than `reward_min_games`, `RefreshRating` writes settle and does not send the season reward mail. When it equals `reward_min_games`, it sends it. The next season's settle of a row made with `set_rating` without matches (`season_games` 0) does not send the reward
- A rule whose `season_board` is `null` has no settle
- `INVALID_INPUT` and `NO_RATING` do not change the row
- When a row violates the data rules, the server does not start
- The change made by `apply_match_outcome` called inside `matchmaker.apply_match_result` goes as a pending delta to participants other than the reporter
- After `set_rating`, the rating and `tier_id` of `RatingUserState` are that value and that tier
- After `Withdraw`, that user has no `RatingUserState`
