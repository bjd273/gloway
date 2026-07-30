---
name: Gloway
description: A dark room with one light in it — glass instrument chrome floating over a live map, and one glowing route.
colors:
  beam-cyan: "#3ee7ed"
  signal-teal: "#02a4aa"
  deep-harbor: "#05767a"
  harbor-lit: "#067f84"
  harbor-deep: "#04565a"
  highlighter-lime: "#c0ff71"
  paper: "#f7f7f5"
  ink: "#1c1e26"
  ink-muted: "#5c6270"
  surface-light: "rgba(255, 255, 255, 0.72)"
  surface-light-solid: "#ffffff"
  border-light: "rgba(28, 30, 38, 0.08)"
  slate: "#0e1118"
  bone: "#eef0f6"
  bone-muted: "#9aa3b5"
  surface-dark: "rgba(22, 26, 36, 0.72)"
  surface-dark-solid: "#161a24"
  border-dark: "rgba(255, 255, 255, 0.08)"
  amber-stop: "#f5a623"
  alert-red: "#ff6b6b"
  alt-route-light: "#9aa3b2"
  alt-route-dark: "#8b93a7"
typography:
  display:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "11.5px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.06em"
  caption:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
rounded:
  sm: "8px"
  md: "10px"
  card: "12px"
  lg: "14px"
  pill: "999px"
  circle: "50%"
spacing:
  xs: "4px"
  sm: "7px"
  md: "10px"
  lg: "12px"
  xl: "16px"
components:
  button-primary:
    backgroundColor: "linear-gradient(135deg, #067f84, #04565a)"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "11px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "6px 13px"
  button-ghost-hover:
    textColor: "{colors.ink}"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "6px 13px"
  chip-active:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "6px 13px"
  route-card:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "9px 12px"
    height: "56px"
  input-search:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "10px 2px"
    height: "44px"
  surface-glass:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xl}"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.pill}"
    width: "44px"
    height: "44px"
---

# Design System: Gloway

## Overview

**Creative North Star: "The Lit Path"**

Gloway is a dark room with one light in it. The route glows; nothing else competes. Every other
decision in this system exists to protect that one statement — the chrome is translucent glass so the
map reads through it, the palette is a single teal family so the glow has no rivals, and the type is
one neutral grotesque at five sizes so nothing shouts for attention that the road hasn't earned.

The system is built for a phone in a car mount. That is not a styling preference; it is the operating
constraint that decides ties. Controls are thumb-sized before they are pretty. Information is sized
for a glance, not a read. State changes are the smallest sufficient change, because motion in
peripheral vision is a cost paid by someone who is driving. Where a conventional map app would add a
badge, a card, or a second accent, Gloway subtracts — legibility at speed is the product.

The atmosphere is dusk-instrument: near-black or near-white ground, frosted panels floating over live
terrain, and one emissive teal-to-cyan ribbon threading through it. Light and dark are peers, not a
default and a variant — both are declared in full through `prefers-color-scheme`, and any new surface
must be designed in both before it ships.

**Key Characteristics:**
- One glowing gradient, reserved for the route and the single primary action per screen
- Frosted glass chrome (16px backdrop blur) that never becomes opaque enough to hide the map
- A single accent family — three teals and one lime — with no competing brand hue
- Inter at five sizes; no display face, no second family
- Pill geometry as the default form language; 44px minimum touch targets everywhere
- Full light/dark parity, driven by system preference alone

## Colors

A single cool accent family — cyan through deep teal — set against warm-neutral paper or near-black
slate, with one high-voltage lime held in reserve.

### Primary

- **Beam Cyan** (`#3ee7ed`): the bright end of the glow. Opens the signature gradient, marks the
  origin pin and the live navigation puck, and colors anything currently *live* — an active mic, the
  assistant's spoken reply, the current turn's list marker. Reads as "this is happening now."
- **Deep Harbor** (`#05767a`): the dark end of the glow. Closes the gradient and fills the destination
  pin. Never used for text — it is a terminus color.
- **Signal Teal** (`#02a4aa`): the accent for marks, strokes and borders against both the paper and
  slate grounds — loading spinner, step markers, the destination pin's outer glow, selected borders,
  the active speaker icon. **Never a background for white text** (3.05:1).
- **Harbor Lit** (`#067f84`) and **Harbor Deep** (`#04565a`): the two ends of the primary button's
  gradient. They exist for one reason — they are the brightest teals that still carry white text at
  WCAG AA (4.8:1 and 8.45:1). Use them only as a fill behind white; never as a text or line colour.

### Secondary

- **Highlighter Lime** (`#c0ff71`): the one warm note, and the rarest color in the system. It appears
  on the logo tile, as the ring around the live puck, and as a 22% wash behind the active search
  suggestion. Its scarcity is the entire point — lime means "you are here" or "this one."

### Tertiary

- **Amber Stop** (`#f5a623`): added waypoints only — the via chips and their map pins. A deliberately
  non-teal hue so a stop can never be mistaken for the route itself.
- **Alert Red** (`#ff6b6b`): errors and failure states only.

### Neutral

- **Paper** (`#f7f7f5`) / **Slate** (`#0e1118`): the app ground in light and dark. Both are slightly
  off-true — paper is warm, slate is blue-shifted — so the map never sits on flat white or flat black.
- **Ink** (`#1c1e26`) / **Bone** (`#eef0f6`): primary text.
- **Ink Muted** (`#5c6270`) / **Bone Muted** (`#9aa3b5`): secondary text, labels, placeholders, and
  every icon at rest.
- **Surface** (`rgba(255,255,255,0.72)` / `rgba(22,26,36,0.72)`): the glass fill. The 72% is load-
  bearing — at full opacity the panels stop being windows.
- **Surface Solid** (`#ffffff` / `#161a24`): the opaque variant, used only where translucency would
  break a control (segmented-control thumb, toggle knob, map controls).
- **Border** (`rgba(28,30,38,0.08)` / `rgba(255,255,255,0.08)`): a hairline at 8% — present enough to
  define an edge against a busy map, quiet enough to disappear against a calm one.
- **Alt Route** (`#9aa3b2` / `#8b93a7`): unselected route lines. Neutral by mandate — an alternate that
  carried any accent would compete with the selected route.

### Named Rules

**The One Light Rule.** The glow gradient (`linear-gradient(135deg, #3ee7ed, #05767a)`) appears at most
twice on any screen: once as the route on the map, once as the single primary action. Everything else
that wants emphasis takes a solid Signal Teal, a border, or nothing. *Audit test:* screenshot any
screen, count the gradient fills. Two or fewer passes.

**The Lime Rationing Rule.** Highlighter Lime is never a surface, never a button, never text. It marks
exactly one thing at a time — the current position, the current selection, the mark. If two limes are
visible, one is wrong.

**The Neutral Alternates Rule.** Anything the user has not chosen renders grey. Selection is the only
thing that earns color.

## Typography

**Body Font:** Inter (with `system-ui`, `-apple-system`, `sans-serif`)
**Display Font:** none — Inter carries every tier
**Label/Mono Font:** none

**Character:** One neutral grotesque doing all the work, loaded at exactly three weights (400/500/600).
The personality comes from the size jumps and the tight tracking on large numerals, not from a second
face. This is a deliberate refusal: a display face would put a voice in the chrome, and the chrome is
supposed to be silent.

### Hierarchy

- **Display** (600, 26px, -0.02em): trip duration, and nothing else. The single largest number on
  screen is always the answer to "how long."
- **Title** (600, 15px, -0.01em): the wordmark and the set destination — the two things that name where
  you are and where you're going.
- **Body** (400–500, 13.5–14px, 1.45): step instructions, conversation text, panel content. 500 for
  interactive rows, 400 for prose.
- **Caption** (400, 12.5px): secondary detail beneath a primary line — the address under a place name,
  distance under a duration. Always Ink Muted.
- **Label** (600, 11.5px, 0.06em, uppercase): section headers inside panels ("ALTERNATIVES", "STEPS",
  "PREFERENCES"). The only uppercase in the system.

### Named Rules

**The 16px Input Rule.** Text inputs are never smaller than 16px. Below that, iOS Safari zooms the
viewport on focus, which throws the map off-screen mid-trip. This is a hard floor, not a preference.

**The One Uppercase Tier Rule.** Uppercase belongs to the 11.5px label tier alone. Uppercase at any
other size reads as shouting on a screen someone is glancing at.

## Layout

The map is the page. Every piece of UI is an absolutely-positioned element floating over a
full-viewport `.map-container`, and the map is never resized, never inset, never given a sidebar. The
chrome budget is the constraint: on a phone, the trip panel is capped at `42dvh` and the preferences
sheet at `70dvh`, so at least 58% of the screen is always map.

**Viewport units are `dvh`, never `vh`.** Mobile browser chrome slides in and out while driving; `vh`
freezes at the largest viewport and clips the panel exactly when the address bar returns. `100dvh` on
`html/body/#root`, `42dvh`/`70dvh`/`60dvh` on panels.

**Safe areas are mandatory.** Every edge-anchored element uses `max(<base>, env(safe-area-inset-*))` —
`14px` for the top row (wordmark, prompt shell, prefs button), `12px` for bottom sheets. `index.html`
carries `viewport-fit=cover`, without which those insets resolve to zero. The bottom inset is the one
that matters most: at a flat `12px` the "Start drive" button lands under the home indicator and cannot
be tapped, in precisely the situation the app exists for.

**One breakpoint: 768px.** Below it, panels are full-width bottom sheets (`left: 12px; right: 12px`)
anchored to the thumb. At and above it, they become corner-anchored columns — the trip panel a 330px
rail bottom-left, the preferences panel a 260px popover top-right. There is no tablet tier and no
desktop-specific layout beyond that switch.

**Stacking order** is a fixed four-step ladder: map (0) → wordmark (20) → trip panel (25) → prompt
shell and preferences (30). Interactive chrome always outranks the passive.

**Spacing** is a hand-tuned 4–16px range clustered on 7 / 8 / 10 / 12 / 16, not an enforced scale. The
frontmatter records the five load-bearing steps; the implementation also uses 6, 9, and 14 as one-off
optical corrections. New work should reach for the five named steps first and treat a one-off as
something to justify.

**Scroll containment.** Any scrollable region over the map (`.trip-steps`, `.prefs-panel`,
`.convo-messages`) sets `overscroll-behavior: contain`, and the body sets `overscroll-behavior: none`.
Rubber-banding the whole page over a moving map is disorienting at speed.

### Named Rules

**The Map Majority Rule.** No chrome configuration may occupy more than half the viewport on a phone.
If a new panel would push past that, it collapses, scrolls, or becomes a snap point — it does not grow.

## Elevation & Depth

Depth is a three-step ladder, and each step answers a different question about what the element is
sitting on. This is a tonal-and-shadow hybrid: blur and translucency separate chrome from the moving
map, while a small shadow vocabulary separates elements from each other. Nothing in the system uses
elevation decoratively.

### Shadow Vocabulary

- **Inset lift** (`box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12)`): small controls that rise *within* an
  already-floating panel — the segmented-control thumb, the toggle knob (`0 1px 3px rgba(0,0,0,0.25)`).
  Tight and dark; the element is millimeters off its parent.
- **Floating glass** (`box-shadow: 0 4px 24px rgba(28, 30, 38, 0.12)` light / `0 4px 24px rgba(0, 0, 0,
  0.45)` dark, plus `backdrop-filter: blur(16px)` and a 1px 8% border): every panel, bar, bubble, and
  sheet that sits over the map. This is the system's signature surface and the only tier that blurs.
  The dark-theme value is nearly four times the opacity of the light one — a soft shadow disappears
  against slate.
- **Map object** (`box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35)` with a 3px white border): pins and the
  navigation puck, which sit *on* the terrain rather than over it. The hard white ring is what keeps
  them legible over an arbitrary basemap; the shadow is the same in both themes because the basemap
  underneath is not.

### Emissive Depth

Separate from shadow, two elements carry an outward glow that reads as light rather than lift: the
destination pin (`0 0 14px` Signal Teal at 70%) and the live puck (`0 0 0 6px` Highlighter Lime at
45%). The push-to-talk mic animates an expanding Beam Cyan ring while listening. Emissive treatment is
reserved for the three things that are *live* — where you're going, where you are, and whether the app
is hearing you.

### Named Rules

**The Windows-Not-Walls Rule.** Glass surfaces stay at 72% fill with a 16px blur. A panel that reaches
full opacity has stopped being a window onto the map and become a page covering it — at which point
the map-first premise is gone.

**The One Blur Tier Rule.** There is exactly one blur value (16px). Varying blur to imply depth reads
as inconsistency, not hierarchy; use the shadow ladder instead.

## Shapes

The form language is pills and soft rectangles, with no sharp corners anywhere in the system.

**Pill (`999px`) is the default for anything interactive** — buttons, chips, inputs, shortcuts, icon
buttons, toggles, progress bars, and the search bar. If it can be tapped, it is a pill.

**Soft rectangle (`14px`) is the container radius** — every glass surface (panel, sheet, bar,
conversation bubble) uses it. The sheet takes it on its top corners only, since its bottom edge runs
off the viewport. Three smaller radii exist for nested boxes: `12px` for cards and boxes that sit
*inside* a glass surface (route cards, the mode track, a place being edited), `10px` for inputs,
error blocks and map controls, `8px` for the smallest hit areas.

**Circle (`50%`) is reserved for map objects and status dots** — pins, the puck, the destination dot,
the loading spinner.

**Borders are hairlines or nothing.** A single 1px border at 8% opacity defines glass edges. There are
no heavy rules, no dividers except one 1px border-top separating a panel footer, and no decorative
strokes.

**Conversation bubbles break their own corner** — the tail corner drops from 14px to 4px (bottom-left
for the assistant, bottom-right for the user). This is the only asymmetric shape in the system.

### Named Rules

**The No-Corners Rule.** Nothing in Gloway has a 0px radius. The softest thing on screen is a moving
map; hard corners on top of it read as a foreign element pasted over the app.

## Components

### Buttons

**Character:** thumb-sized and quiet. Muted at rest, generous to hit, and state shown by the smallest
sufficient change.

- **Shape:** fully rounded pill (`999px`)
- **Primary** (`.gw-primary`): `--glow-gradient-legible` at 135° with a bright-cyan inner rim along
  the top edge, white text, 600 weight. **There is one per screen.** Three selectors carry the class —
  `.trip-start`, `.trip-nav-arrive`, and the wrap-up's Send/Done — but they live in mutually exclusive
  branches of the action block, so only ever one is mounted. The legible ramp exists because white on
  the full-range gradient's bright end is 1.5:1; the rim keeps the button lit without putting cyan
  behind the label.
- **Ghost / secondary** (`.trip-done`, `.place-action`): transparent fill, 1px hairline border, Ink
  Muted text. Hover raises the text to full Ink; the border does not change.
- **Icon button** (`.prefs-button`, `.convo-mic`, `.convo-speaker`): transparent, 44×44px minimum, glyph
  in Ink Muted. Hover and `aria-expanded="true"` both raise the glyph to Ink.
- **Disabled:** `opacity: 0.6` (0.5 for icon buttons) and `cursor: default`. No color change — the
  dimming is the whole signal.

### Chips

- **Style:** pill, transparent fill, 1px hairline border, Ink text at 13px/500, `6px 13px` padding.
- **Selected:** accent border, a 10% accent wash, and the label at 600 weight in `--text`. The label
  stays Ink deliberately — accent-on-panel is 2.8:1 in light theme, under AA. The border and wash
  carry "selected"; the text only has to stay readable.
- **Variants:** route alternates, travel-mode selection, and drive-mode selection all reuse the same
  chip; drive-mode chips take `flex: 1` so the row reads as one segmented control.
- **Via chips** (`.trip-via`) are the exception: Amber Stop at 12% fill with a 45% border, and they
  carry a 32×32px minimum remove button — the original ~19×15px target was untappable in a moving car.

### Cards / Containers

The glass primitive is shared by seven selectors and is the single most important component in the
system.

- **Corner style:** 14px
- **Background:** Surface at 72% with `backdrop-filter: blur(16px)` (and the `-webkit-` prefix — Safari
  is the primary target)
- **Border:** 1px hairline at 8%
- **Shadow:** Floating glass (see Elevation)
- **Internal padding:** 16px for the trip panel, `14px 16px` for the preferences sheet, `11px 16px` for
  list rows

### Inputs / Fields

- **Style:** the search bar is a pill with a transparent field inside a glass shell; settings inputs are
  10px-radius boxes with a hairline border and transparent fill.
- **Size:** 16px font, minimum (see The 16px Input Rule).
- **Focus:** the glass shell gains a 2px ring in a 55/45 mix of Beam Cyan and Deep Harbor
  (`.prompt-bar:focus-within`); bordered inputs shift their border to the same mix. Focus is a color
  shift, never a size or position change.
- **Placeholder:** Ink Muted.
- **Disabled:** `opacity: 0.6`.

### Navigation

There is no nav bar. Wayfinding is the map plus three fixed anchors: the wordmark (top-left, 92%
opacity, `pointer-events: none` — it is a mark, not a control), the search/prompt shell (top-center,
`min(440px, 100vw - 24px)`), and the preferences gear (top-right, 44×44px). Everything else appears in
response to state.

### Toggles

A 36×21px pill with a 16px knob on Surface Solid. Off is the border color; on is the glow gradient.
The knob slides `15px` over `0.15s ease`. The label wraps the whole row and enforces `min-height: 44px`
— the switch's own 21px is not a legal touch target.

### The Sheet

One bottom sheet holds everything: search before a destination is set, then the trip. It replaced a
top search shell plus a bottom trip panel, which together squeezed the map into a sliver — and, on a
375px phone, the search shell overlapped the preferences gear and made it unclickable.

- **Snaps:** `peek` (26dvh), `half` (50dvh), `full` (88dvh), as fixed `dvh` values on
  `.sheet[data-snap]`. Fixed rather than `auto` because `auto` doesn't animate in Safari without
  `interpolate-size`, and this transition runs on every snap.
- **Always visible at every snap:** the destination header, the summary, and the action row. A
  reachable primary action is the entire point of `peek`.
- **Never unmounted between snaps.** The scroll region stays mounted and clips; only CSS changes. This
  is a hard constraint, not a preference — NavVoice holds a WebSocket for the whole drive, and
  remounting its parent would tear the socket down mid-trip.
- **Grabber:** a real `<button>`, not a decorative bar. Tapping cycles peek → half → full, which beats
  dragging when the phone is in a car mount, and Arrow keys work.
- **Desktop (≥768px):** the snapping is switched off entirely and it becomes a 360px rail in the
  bottom-left corner.

### Route Cards

The component that turns the candidate generator into a visible feature. Six routes used to render as
six unlabelled minute-chips — more choice than ever, and no basis to choose.

- **Shape:** 12px radius, 56px minimum height, hairline border; accent border plus an 8% wash when
  selected.
- **Line swatch:** a 18×3px rounded stroke in the colour that route's polyline is actually drawn in —
  a map legend key, deliberately not a `border-left` accent rail.
- **Content:** `label · time · delta` over `distance · reason`. The delta is the decision-relevant
  number and is always measured against the *recommended* route, never the selected one.
- **Preview:** pointer-enter or keyboard focus brightens and thickens that route's line on the map
  without committing the selection.

### Signature Component: The Glowing Route

The route is a four-layer MapLibre stack, rendered under the basemap's label layers and over its roads,
and it is the reason the whole system is built the way it is:

1. **Alternates** — flat grey, 3.5–5px, 55–60% opacity
2. **Halo** — the gradient at 12–26px with `line-blur: 12` and 28% opacity: the glow itself
3. **Casing** — solid white at 7.5–11px, 90% opacity: what makes the gradient core read as a solid
   ribbon rather than a stripe of edge-light
4. **Core** — the gradient at 4.5–8px, full opacity

The gradient runs along `line-progress`, not across the screen — Beam Cyan at the origin fading to Deep
Harbor at the destination, so the line itself encodes direction of travel. All widths interpolate with
zoom (z12 → z16). Every runtime-added map object uses the `gw-` id prefix; that prefix is the contract
the theme-swap logic depends on to preserve sources across `setStyle`.

## Do's and Don'ts

### Do:

- **Do** design every new surface in both light and dark before shipping it. Both themes are declared in
  full via `prefers-color-scheme`; neither is the fallback.
- **Do** give every tappable thing a 44×44px minimum hit area, growing the target rather than the glyph.
  The existing code does this explicitly for mic, speaker, preference rows, and via-remove, each with a
  comment naming the in-car reason.
- **Do** use `dvh` and `max(<base>, env(safe-area-inset-*))` on anything anchored to a viewport edge.
- **Do** reach for Signal Teal when an accent must stand alone — it is the only member of the family
  legible against both grounds.
- **Do** set `overscroll-behavior: contain` on any scrollable region layered over the map.
- **Do** keep the `gw-` prefix on every runtime-added map source and layer.

### Don't:

- **Don't** put a second gradient on a screen that already has one. Exactly one CSS selector may carry
  a gradient fill — `.gw-primary` — plus the route ribbon, which is painted by MapLibre. The audit is
  `grep -c 'background: var(--glow-gradient' frontend/src/index.css`, which must stay at **1**.
  Everything else that wants emphasis takes a solid accent, a border, or nothing.
- **Don't** build toward the Google/Waze chrome model: stacked cards, dense pin clutter, badge-on-badge
  density, or several accents competing at equal weight. That is this system's named anti-reference. If
  a screen needs another element to earn attention, take attention away from something else.
- **Don't** let a glass surface go opaque, or vary the 16px blur to suggest depth.
- **Don't** use the gradient for information. Duration is a fact, not an action, and facts render in
  Ink. (`.trip-time` used to gradient-clip its text; it doesn't any more.)
- **Don't** put white text on `--accent` or `--glow-a`. They are 3.05:1 and 1.5:1 against white, both
  under AA. A surface carrying white text takes `--glow-b` or `--glow-gradient-legible`; `--accent` is
  for marks, strokes and borders, not for text backgrounds.
- **Don't** set input text below 16px (viewport zoom on iOS), or ship a touch target under 44px.
- **Don't** introduce a second type family or a display face. Inter at five sizes is the whole system.
- **Don't** color an unselected alternate route. Grey is what makes selection mean something.
- **Don't** use Highlighter Lime as a surface, a button, or text — and never show two at once.
