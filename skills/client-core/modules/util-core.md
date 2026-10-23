# UtilCore

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

Gives the string, math and collection operations, big integer operations, PCG32 random and general-purpose state machine that core and content code share. This module has no module state and has no lifecycle.

## dependency

none. It does not call `LogCore` either.

## API

| operation | input | output | failure value | caller |
|---|---|---|---|---|
| `sha256_hex` | bytes | SHA-256 as 64 lowercase hexadecimal characters | empty string | all code |
| `is_snake_case` | text | whether it matches `[a-z][a-z0-9_]*` and has no `__` and no trailing `_` | `false` | all code |
| `floor_div` | `a`, `b`: int64 | quotient of `a ÷ b` rounded toward negative infinity | 0 when `b` ≤ 0 | all code |
| `floor_mod` | `a`, `b`: int64 | `a − b × floor_div(a, b)`. At least 0 and less than `b` | 0 when `b` ≤ 0 | all code |
| `clamp_int` | value, min, max: int64 | value clamped to at least min and at most max | min when min > max | all code |
| `apply_permille` | value: int64, permille: int64 | result(success flag, `floor_div(value × permille, 1000)`) | (`false`, 0) when the product is outside int64 | all code |
| `big_is_valid` | text | `true` when it is a big integer | `false` | all code |
| `big_from_int` | value: int64 | big integer of value | none | all code |
| `big_to_int` | text | result(success flag, int64 value) | (`false`, 0) when it is not a big integer or is outside int64 | all code |
| `big_compare` | `a`, `b`: text | result(success flag, −1 when `a` < `b`, 0 when equal, 1 when greater) | (`false`, 0) when an input is not a big integer | all code |
| `big_add` | `a`, `b`: text | `a + b` | empty string when an input is not a big integer | all code |
| `big_sub` | `a`, `b`: text | `a − b` | empty string when an input is not a big integer | all code |
| `big_mul` | `a`, `b`: text | `a × b` | empty string when an input is not a big integer | all code |
| `big_floor_div` | `a`, `b`: text | quotient of `a ÷ b` rounded toward negative infinity | empty string when an input is not a big integer or `b` ≤ 0 | all code |
| `big_apply_permille` | value: text, permille: int64 | `big_floor_div(value × permille, 1000)` | empty string when value is not a big integer | all code |
| `create_random` | seed: int64 | random instance | none | all code |
| `make_purpose_seed` | purpose name: string, base: int64 | seed: int64 | none | all code |
| `next_uint32` | random instance | integer of at least 0 and less than 2^32 | none | all code |
| `range_int` | random instance, min, max: int64 | integer of at least min and at most max | min when min > max or when min or max is outside int32 | all code |
| `next_float` | random instance | real number of at least 0 and less than 1 | none | all code |
| `shuffle_indices` | random instance, count | permutation of 0 to count − 1 | empty list when count < 0 | all code |
| `pick_weighted` | random instance, weights: list of int64 | picked index | −1 for a negative weight, sum 0 or sum > 2^32 | all code |
| `create_state_machine` | list of states, list of transitions, first state, callbacks per state | state machine | none when the state list is empty or has a duplicate, a state of a transition is outside the list, or the first state is outside the list | all code |
| `change_state` | state machine, next state | success flag | `false` | all code |
| `update_state` | state machine, elapsed ms | none | none | all code |
| `current_state` | state machine | current state | none | all code |
| `previous_state` | state machine | previous state. For the first state, the first state | none | all code |
| `state_elapsed_ms` | state machine | sum of the elapsed ms received through `update_state` since entering the current state | none | all code |

## behavior

### inclusion rule

- UtilCore holds only operations that meet one of these: two or more core modules outside `UtilCore` use it, every game uses it
- Operations are added with `update core`

### common

- Every operation gives the same output for the same input. Results are not cached
- Returning a failure value leaves no log. The caller that receives the failure value leaves an error log
- String comparison and number conversion do not depend on the locale

### big integer

- A big integer here is the big integer of the contract (a decimal integer string). There is no digit limit
- The result of a big integer operation is a big integer. It never gives `-0`
- The result equals the value of the same calculation on integers. The server does the same calculation with `bigint`

### random

- A random instance is a sequence generator created from one seed. No operation creates one without a seed
- A failed operation does not advance the sequence
- Core and content code do not use the engine's built-in random functions. The list of those functions is in the engine implementation rules
- A purpose name is a snake_case string constant that names the use of one random instance. e.g. `battle_effect`, `drop_preview`
- Each purpose gets its own random instance. Several purposes do not share one instance
- Code that creates a random instance leaves the purpose name and the seed in a `debug` log of `LogCore`
- Random whose result becomes saved state as it is (rewards, draws) is drawn by the server. The client does not draw it
- The seed of a purpose that needs reproduction is made with `make_purpose_seed` from the match seed or a seed that DEV code received as the base. For a purpose that needs no reproduction, the base is the device time of `TimeCore`
- The random and `make_purpose_seed` of server core `storage` are the same algorithm as these. The same seed and the same operation order give the same result on every engine and on the server. A purpose name for which server core recreates the same sequence is defined by that server core spec. e.g. `match_simulation` in `matchmaker`

### PCG32 algorithm

The state is one unsigned 64-bit integer `state`. 64-bit arithmetic is modulo 2^64, and `>>` is a logical shift. `seed` and `base` are read as unsigned values from their 64-bit two's complement bit strings. The result of `make_purpose_seed` is the 64-bit bit string read as a two's complement int64.

```
MULTIPLIER = 6364136223846793005
INCREMENT = 1
FNV_OFFSET = 14695981039346656037
FNV_PRIME = 1099511628211

step():
  old = state
  state = old * MULTIPLIER + INCREMENT
  x = (((old >> 18) xor old) >> 27) mod 2^32
  r = old >> 59
  return ((x >> r) or (x << ((32 - r) mod 32))) mod 2^32

create_random(seed): state = 0; step(); state = state + seed; step()
next_uint32(): return step()
bounded(b):            # 1 <= b <= 2^32. next_uint32() when b = 2^32
  t = (2^32 - b) mod b
  repeat: v = next_uint32(); if v >= t: return v mod b
range_int(lo, hi): return lo + bounded(hi - lo + 1)
next_float(): return next_uint32() / 2^32     # 64-bit floating point
shuffle_indices(n):
  buf[i] = i (i = 0 .. n-1)
  for i = n-1 down to 1: j = bounded(i + 1); swap(buf[i], buf[j])
pick_weighted(w):
  v = bounded(sum(w)); acc = 0
  for i: acc = acc + w[i]; if v < acc: return i
make_purpose_seed(name, base):
  h = FNV_OFFSET
  for each UTF-8 byte c of name: h = (h xor c) * FNV_PRIME
  return h xor base
```

### state machine

- A state is an integer value. e.g. an enum element of content code
- A transition is a (from state, to state) pair. Only pairs in the list are allowed
- There are three callbacks per state, and each can be omitted: `on_enter(previous state)`, `on_exit(next state)`, `on_update(elapsed ms)`
- Creation does not call `on_enter` of the first state. `state_elapsed_ms` is 0
- `change_state(next)` runs in this order
  1. When there is no transition from the current state to next, returns `false`. A transition to the same state also has to be in the transition list
  2. Calls `on_exit(next)` of the current state
  3. Changes the current state to next and sets `state_elapsed_ms` to 0
  4. Calls `on_enter(previous state)` of next
  5. Returns `true`
- `change_state` called during a transition (steps 2 to 4) returns `false` and changes nothing
- `update_state(ms)` adds ms to `state_elapsed_ms` and calls `on_update(ms)` of the current state. When ms is negative, it does nothing. `update_state` during a transition also does nothing
- When a callback cannot be called because its object was destroyed, that callback is skipped without a log and the next step runs

## hook

none

## event

none

## error

| condition | failure value | log |
|---|---|---|
| a failure value condition of the API table | the failure value in the table | none. The caller leaves an error log |
| a transition that is not allowed, `change_state` during a transition | `false` | none. The caller leaves an error log |

## settings

none

## data

none

## DEV

none

## test

- For each row of the test vector table, the result equals the table. A row with a seed starts from a newly created random instance

| seed | operation | result |
|---|---|---|
| `42` | `next_uint32` 6 times | `565663470`, `3244226384`, `2504567229`, `903561869`, `4026996297`, `2722332799` |
| `-42` | `next_uint32` 6 times | `2135434507`, `1425494533`, `1059454827`, `1281541498`, `243802185`, `3332889050` |
| `42` | `range_int(1, 6)` 10 times | `1`, `3`, `4`, `6`, `4`, `2`, `3`, `3`, `3`, `3` |
| `42` | `range_int(-2147483648, 2147483647)` 3 times | `-1581820178`, `1096742736`, `357083581` |
| `42` | `next_float` once | `565663470 / 4294967296` |
| `42` | `shuffle_indices(10)` | `1`, `6`, `7`, `8`, `4`, `3`, `9`, `5`, `2`, `0` |
| `42` | `pick_weighted([1, 0, 3, 6])` 10 times | `0`, `3`, `3`, `3`, `3`, `3`, `3`, `0`, `3`, `2` |
| `-9223372036854775808` | `next_uint32` 3 times | `1191765185`, `1695953820`, `3015401034` |
| none | `make_purpose_seed("battle_effect", 1700000000000)` | `1464768381546528617` |
| none | `make_purpose_seed("a", 0)` | `-5808556873153909620` |

- `range_int`, `shuffle_indices`, `pick_weighted` return the failure value for each failure condition, and the `next_uint32` drawn after that equals the one drawn when there was no failed call
- `range_int(0, 2147483648)` returns 0 and `range_int(-2147483649, 0)` returns -2147483649, and the `next_uint32` drawn after that equals the one drawn when there was no such call
- `sha256_hex` returns `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` for empty bytes
- `floor_div(-7, 2)` is −4, `floor_mod(-7, 2)` is 1, and both are 0 when `b` = 0
- `apply_permille(1001, 500)` is (`true`, 500), `apply_permille(-1001, 500)` is (`true`, −501), and an int64 product overflow gives (`false`, 0)
- `big_add`(`9223372036854775807`, `1`) is `9223372036854775808`, `big_sub`(`5`, `5`) is `0`, `big_mul`(`-3`, `0`) is `0`, `big_floor_div`(`-7`, `2`) is `-4`, `big_apply_permille`(`1001`, 500) is `500`, `big_compare`(`-10`, `9`) is (`true`, −1), `big_to_int`(`9223372036854775808`) is (`false`, 0)
- `01`, `-0`, `+1`, `1e3`, ` 1` and the empty string are `false` in `big_is_valid`, and a big integer operation with such an input gives the failure value
- `is_snake_case` returns `true` for `abc_1`, and `false` for `Abc`, `1abc`, `a__b`, `a_` and the empty string
- state machine: on an allowed transition, `on_exit` and `on_enter` are called once each in that order, and `state_elapsed_ms` becomes 0. A transition that is not allowed and `change_state` inside `on_enter` give `false` and the state stays the same. After `update_state(16)` twice, `state_elapsed_ms` is 32
- state machine: after the object of a callback is destroyed, `change_state` gives `true` without a log and the state changes
- `create_state_machine` returns none for an empty state list, a duplicate state, a transition state outside the list, a first state outside the list
- The UtilCore module has no module state and no log calls
