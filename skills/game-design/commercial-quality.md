# commercial quality

What commercial games share whatever their genre, platform and art style, and what amateur or AI-made work misses. It is not a style: the look of each game (its forms, materials, palette, type, motion and sound) comes from its own theme (`## art direction` and `## audio direction` of `design.md`) and from its reference game (`records/setup/reference/`). A quality below says what must be true; the theme and the reference say how it looks.

The qualities come from 434 screenshots of 79 commercial games of 8 genre groups (2026-10), frame-by-frame study of the gameplay videos of 4 commercial games of different genres and styles, and the blind ratings of a human who rated our AI-made games against them. The counts are the share of the surveyed screens that do it.

## how a game meets it

- Before making a screen or an asset of a kind (a title, a pause screen, a result, a HUD, an enemy, a floor, an icon, a hit effect, a sound), the content agent looks at the same kind in the reference game: the moments of `records/setup/reference/reference.md`, and other stretches of its videos, with `ogw frames`. It makes that kind the way the reference does it, in the game's own theme
- Judge an asset where it is seen: in a capture of the game at play size, next to the main character and over its real background, not on an asset sheet. An asset that looks fine alone can fail in the game (e.g. a character drawn as a standalone illustration and shrunk into the scene)
- Rendering fidelity is not the bar. Crude but consistent work (The Binding of Isaac, Vampire Survivors) meets these qualities; polished but generic work fails them

## qualities of every resource

1. One hand: every resource (UI, characters, environment, props, effects, icons, logo, title art, app icon) is made in the same hand as the game's world: its line or pixel scale, shading, palette, materials and motifs. Nothing could be pasted into another game unchanged (150 of 150 UI screens, 91 of 91 character frames, 108 of 108 environment frames)
2. Made for how it is seen: an asset is designed for the size and place it is shown at: a few big shapes and a clear silhouette at play size, fine detail only where the screen can show it
3. Attention is directed: what the player must notice stands out by value, hue or a mark nothing else uses; the play surface and the dressing stay quiet; a screen has one focal element; strong signals are kept for rare, important moments
4. Identity from the theme: places, characters, UI and type come from the game's own theme, not from genre defaults (a specific place, a character's own hook, the game's name drawn as a logo)
5. Finished and consistent: no placeholder, debug label or engine default is on screen; every state (empty, locked, unknown, selected, disabled) is drawn; no mark of image generation is left (melted or mushy forms, meaningless glyphs, line weight that changes within one object); the same thing always looks, moves and sounds the same; one meaning per color or mark. Check: is everything on screen finished art with no placeholder, debug label or generation mark?
6. Moments are staged: an event unfolds in beats (cause before effect, then the result, then the record of it), sized to its importance; routine actions get almost nothing, rare ones get time

## UI screens

- The windows, buttons and HUD pieces are made from something of the game's world (a material, an object, a shape, the brand's line), or reduced to plain type over the scene. Check: could these panels and buttons be pasted into another game unchanged?
- Type speaks in the game's voice: the game's name is a drawn logo (24 of 24 screens that show it); titles, big numbers and main buttons get a display treatment apart from the body text. Check: is the name drawn, and do titles and big numbers differ from body text?
- One focal element; groups are separated by space and thin lines, not by boxes nested in boxes; in play the HUD keeps to the edges (40 of 40 HUDs left the middle clear). Check: is there one obvious focal element, without nested same-weight boxes?
- The title, the main menu and the lobby are staged like a poster: one image from the game (usually the hero, else the world's landmark) carries the screen, and the logo and a short menu sit in its calm space (41 of 45). Check: do the logo and menu sit in the free space of one image from the game?
- Results and rewards are moments, not forms: one outcome or choice is shown big, with the game's characters, world or color; the details come second (11 of 11). A game-over screen is an object of the game's world (12 of 12 more games: a diary page in the hero's crayon hand, a merchant's ledger, a decree of excommunication, a cracked crown banner, one brushed character over the hero's body). Check: does the screen lead with one big outcome staged in the game's world?
- A popup or overlay is made in the game's language (an engraved inscription, a constellation line, the card itself, an object of the world) or is plain type over the live game; never a generic dialog box (10 of 12 popups and overlays of 12 games; the other 2 are plain type over the game). Check: does the popup look like it belongs to this game rather than to an app?
- Controls are glyphs of the real buttons or keys next to a verb, or a pointer on the exact thing; never sentences of plain text (44 of 44). Check: are controls glyphs or pointers rather than text?
- Focus and state read at a glance: the focused item and every current setting are visible, and destructive or final actions look different (56 of 65 menus, 13 of 14 settings screens). Check: can you tell what is focused and how each option is set?

## characters

- The player and every enemy separate from the ground at play size by a cue the ground does not use (89 of 91). Check: shrunk to a thumbnail, can you point at the player and every enemy?
- Designed for their size: big shapes, one clean outline, a signature feature (26 of 27 frames with small characters). Check: at in-game size, can you name the head, body and signature feature?
- Grounded and lit by the scene: feet meet the floor, with a shadow where the floor is visible (71 of 71). Check: does each character have a shadow or clear contact, lit like its surroundings?
- Who is who is coded one way: the player singled out, allies and enemies split, bosses set apart, the player's shots unlike the enemies' (29 of 29). Check: without text, can you tell player, enemies, boss and whose shots are whose?
- Each main character has a hook from the game's theme, repeated in every depiction (77 of 77). Check: can you name a feature of the hero and each enemy that comes from this game, not the genre?

## environment

- Surfaces are authored, not stamped: wear, patches and dressing break up floors and walls so nothing visibly repeats, within the floor's own value range (49 of 50). Check: is the floor free of an obviously repeating tile?
- The play surface is the quietest layer: actors, pickups and hazards separate from it in grayscale (84 of 84). Check: in grayscale, does everything the player tracks separate from the floor behind it?
- The space reads as a volume: depth planes or walls and edges with visible height. Check: are there two depth planes, or walls drawn with height?
- A specific place from the theme; on fixed boards the theme lives in the borders while the field stays calm (66 of 108; 14 of 15 boards). Check: can you name the place?
- Play geography is drawn into the world: where to walk or place and what blocks. Check: without UI, can you tell where you can go?
- Light has a source and a job: a key light, pools on the play space, shadows that sit objects down. Check: can you tell where the light comes from?

## props, pickups, effects and icons

- Same hand as the world and the characters (38 of 38). Check: next to the main character, does each prop, effect and icon share its edges, shading, palette and detail?
- Icons of one role form one family: one render, angle, light, outline rule and backing (55 of 55 icon sets). Check: do two icons of the same role look made in one sitting?
- Every icon and pickup reads at its real size: one subject, a bold silhouette, a hue unlike its neighbours (54 of 55). Check: at native resolution, can you tell what each icon is without a label?
- What must be noticed is the highest-contrast thing in its area; dressing stays quiet (12 of 12). Check: can you find every pickup and projectile within a second?
- Effects are designed shapes with a core, an edge and secondary parts, sized by the event's weight (22 of 22). Check: does each effect have a shape, and is the largest effect the most important event?
- Danger and targeting are crisp shapes in a color reserved for that meaning (10 of 10). Check: is every danger area a crisp shape in a color nothing else uses?
- Play spaces are furnished in layers: obstacles, breakables and dressing; each prop's look tells what it does (38 of 38). Check: is the space more than a bare floor or one stamped object?

## motion and feedback

Seen in all four studied games (The Binding of Isaac, Hearthstone, Vampire Survivors, Stack with Royal Match), whose styles have nothing in common:

- Feedback is budgeted by consequence: a routine hit gets a short tint on the target only; kills, damage to the player, rewards and deaths get more; the loudest tools (shake, full-screen flash, long sequences) are kept for rare moments. None of the four shook the screen on a routine hit
- Actions are cut into readable beats: wind-up or contact, result, then cleanup; the cause is seen before the effect; a destruction is a short sequence, not a deletion
- Each motion has a curve that fits its job: fast travel and a held result; entrances that land with a small overshoot and short exits; one shared timing grid rather than one default tween everywhere
- Things come from a place that explains them and go where they belong: a panel grows from what opened it, a reward flies to its counter, and the counter answers
- Simple drawings stay alive through squash, stretch, inertia and secondary motion; idle scenes are calm but not dead, and surfaces meant for reading stay still
- The world keeps a record of play and shows progress (stains, debris, a changing tower or castle), not only a number

## what comes from the game, not from this definition

Whether windows have frames at all; which material or object the UI is made of; frame weight and ornament; corner shapes; opaque or translucent panels; fonts and case; the palette and its accent; where the menu sits; screen density; diegetic or overlay UI; outlines or none; proportions; camera and projection; whether the grid shows; the value key; rendering technique; amount of atmosphere; how pickups are signalled; color meanings; motion timing and curves; how much glow. Each is taken from the game's theme and its reference game.
