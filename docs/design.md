# cockpit — Design

The design system, derived from the prototype in `prototype/` rather than written ahead of
it. Every rule here was arrived at by building the thing, looking at it, and usually
rejecting a first attempt — the rejections are recorded because they are the part most
likely to be repeated.

The prototype is the visual reference implementation. Where visual tokens disagree,
`prototype/assets/css/theme.css` wins.

> Model warning: the static prototypes predate ADR-0009 and still show the removed global
> Plans flow. `CONTEXT.md`, `docs/type-design.md`, and ADR-0009 win for domain terms,
> navigation ownership, and behavior. Do not implement a Plans screen from those files.

---

## 1. Principles

**Paper and ink.** One canvas (`paper`), one raised surface (`sheet`), one foreground
(`ink`) used at varying alpha. There is no grey palette — every neutral is ink at an alpha
step, so the whole greyscale re-derives itself when the theme flips.

**Emphasis through contrast, never colour.** The primary action is solid ink, not a brand
colour. A heading is larger and heavier, not tinted.

**Colour carries meaning only.** Four semantic accents, each bound to a state. Anything not
carrying one of those meanings is ink. The consequence is the point: **a healthy fleet
renders entirely monochrome**, so colour appearing anywhere *is* the alert. Coolify's UX
problem is partly that everything is coloured, so nothing is.

**Right angles everywhere.** Zero border radius, square line caps, miter joins, orthogonal
graph edges. No exceptions — a single rounded corner reads as a mistake in a system this
consistent.

**Mono is a literal, sans is language about it.** Machine-produced values — ids, digests,
domains, durations, env keys, cron expressions, log lines, anything you could paste into a
terminal — are mono. Prose, headings, labels, and buttons are sans. This removes a whole
class of ambiguity in a UI that shows both constantly.

**No explanatory chrome.** No legends, no captions naming what an encoding means, no
keyboard-hint rows. If an encoding needs a key, the encoding is too subtle and should be
fixed; if the interaction is conventional, it needs no caption. Three separate attempts at
this were built and removed during the prototype.

**Count the rules before adding one.** A screen with tabs, a strip border, a section
divider, a table header, and a rule per row has five different kinds of line before any
data. Two of those were removed; the remainder is one rule per *purpose*.

**Never invent data.** Before a value goes on a screen, name the frame, query, or probe
that produces it. See `docs/prototype-reality-check.md` — six invented fields were found in
one audit.

---

## 2. Tokens

Plain custom properties in the prototype, mapping 1:1 onto a Tailwind v4 `@theme` block.

### 2.1 Surfaces and foreground

|  | light | dark |
|---|---|---|
| `--color-paper` | `oklch(0.972 0.003 255)` | `oklch(0.192 0.005 264)` |
| `--color-sheet` | `oklch(0.993 0.0015 255)` | `oklch(0.228 0.006 264)` |
| `--color-ink` | `oklch(0.28 0.014 262)` | `oklch(0.875 0.006 250)` |

Both themes deliberately stop short of the extremes. Near-white ink on a near-black canvas
is the highest contrast available and the most tiring to read — it glares and glyph edges
bloom, and cockpit is a dashboard left open all day. Measured ratios are **13.5:1** light
and **12.6:1** dark, down from ~16:1, still comfortably past AAA (7:1).

### 2.2 Ink alphas

`--ink-04 · 08 · 12 · 20 · 40 · 60 · 80`, all `color-mix` of ink into transparent.

| step | used for |
|---|---|
| 04 | hover fill on rows |
| 08 | selected fill, subtle panel |
| 12 | borders, dividers, gauge tracks |
| 20 | stronger borders, edges on a canvas, disabled marks |
| 40 | secondary text, icons at rest, mono metadata |
| 60 | body text that is not primary |
| 80 | values in a key/value pair |

### 2.3 Semantic colour

| token | means |
|---|---|
| `accent` (green) | healthy, running, applied |
| `info` (blue) | pending, planning, enrolling, draft |
| `warn` (amber) | degraded, nearing a limit, needs attention |
| `danger` (red) | failed, unhealthy, destructive impact, alert firing |
| `ink` at alpha | stopped, unknown, disabled |

**Identity tint** (`--idhue` composed with themed `l`/`c`) gives a stable per-subject hue,
but **never on anything that also carries state**. An early pass tinted server names and
produced red, green, and blue names — the exact hues meaning failing, healthy, and pending
— so a healthy box read as an alert. Reserved for avatars, log-line gutters, graph series.

### 2.4 Type

Schibsted Grotesk (sans) · Geist Mono (mono), via fontsource.

`--t-micro 11 · sm 12 · base 14 · lg 16 · xl 20 · 2xl 28 · 3xl 40`

Headings are 600 with negative tracking (`-0.02` to `-0.035em`). The uppercase mono
micro-label — 11px, `0.08em` tracking, `ink-40` — is the workhorse for field labels, table
headers, and metadata.

### 2.5 Spacing and radius

`--s1 4 · s2 8 · s3 12 · s4 16 · s5 24 · s6 32 · s7 48 · s8 64`. `--radius: 0`.

### 2.6 Motion

`--ease: cubic-bezier(0.22, 1, 0.36, 1)`. `ck-rise` for panels, `ck-fade` for swaps,
`ck-sweep` for indeterminate progress, `ck-spin` for button spinners. All suppressed under
`prefers-reduced-motion`.

---

## 3. Icons

**HugeIcons** (`@hugeicons/core-free-icons`), geometry only. Stroke, width, and caps are set
in CSS so the set's rounded caps become **square**: `stroke-width: 1.25`,
`stroke-linecap: butt`, `stroke-linejoin: miter`. Rounded ends would be the only curves in
a design that has none.

Sizes: `icon-sm 15 · icon 18 · icon-lg 21`. Shipped as an SVG sprite of `<symbol>`s.

Icons mean **a resource kind or a destination**. They are not decoration — an early pass
put an icon beside each of twelve already-labelled key/value fields, where a third of them
had no honest glyph and the labels already said what they were.

---

## 4. The frame

Two fixed regions and one scrolling one. The rail and the bar never move; only the content
does. Every screen is a content region, and nothing may restructure the chrome around it.

```
┌────────────┬──────────────────────────────────────────┐
│  rail      │  bar: breadcrumb · search · bell · action │
│  (216px)   ├──────────────────────────────────────────┤
│            │  tab strip                                │
│            ├──────────────────────────────────────────┤
│            │  content (scrolls)                        │
└────────────┴──────────────────────────────────────────┘
```

### 4.1 Rail

Global destinations only, never contextual. Three groups: the containment spine (Servers
and Activity), account-scoped things (Domains, Sources, Secrets), then Settings.
Deployments stay inside their project.

The active item is **contrast alone** — `ink-40` to full ink plus weight 500. No rule, no
fill, no pill: those are the default moves and they add chrome to a system whose premise is
that emphasis comes from contrast.

**The mark doubles as fleet health** — it banks and turns `danger` when something is wrong,
so the chrome itself tells you before you read a word. It is the one place the logo carries
colour. On mobile the rail becomes a bottom bar. The mark moves into the top bar, since
that is where you glance rather than work.

Collapsed rail: labels vanish, hit targets and icons stay put, counts become a dot — a
number in 52px lies.

### 4.2 Bar

**The breadcrumb is the page title.** No separate `<h1>` — the last crumb is the title at
heading size. A crumb trail plus a heading says the same thing twice, which is what eats
the top 100px of most dashboards.

Search (`⌘K`), the notification bell, and at most one primary action. The primary action is
absent when the content already carries it — an empty state with "Add server" does not need
"Add server" in the bar too.

### 4.3 Tab strip

**Exactly one strip is ever visible, belonging to the deepest object that *has* sub-views.**
Entering a project from a server **replaces** the server's strip rather than stacking a
second one. That is what keeps the shell to one sidebar and one strip at any depth.

**A leaf keeps its parent's strip**, with the tab it lives under still marked. A deployment
has no sub-views of its own, but dropping the strip made the page read as having left the
hierarchy and removed the route back to its siblings.

Active tab interrupts the strip's baseline with a 2px ink underline. Unlike the rail, that
rule is structural — it says which section the content belongs to.

### 4.4 Notifications

Anything needing a human collects behind the **bell**, not injected into whatever page you
are on. A page shows the state of the thing it is about; it does not carry a noticeboard.

The exception: a notice that explains the state of *this page* stays inline — the
disconnected-server notice explains why every row below it is stale and why Deploy is
disabled.

---

## 5. Components

Each is specified in `prototype/assets/css/theme.css` and demonstrated in
`prototype/components.html`.

### 5.1 Button

Four variants, three sizes (`sm 28 · default 36 · lg 44`).

| variant | use |
|---|---|
| `primary` | solid ink. One per screen — if there are two, one is not primary |
| `ghost` | bordered. The default for everything else |
| `quiet` | borderless. Dense contexts — table rows, toolbars — where a border on every item out-weighs the data beside it |
| `danger` | solid. A destructive action should look as committed as it is; outlining it reads as a warning rather than a decision |

`danger` is reserved for actions that destroy something. Using it to mean "important" is
what makes it stop registering where it matters.

### 5.2 Notice

The one message component — sign-in errors, failed deployments, disconnects, disk
pressure.

Shaped as a **printed ledger entry**: the machine's classification and error code in a mono
gutter, the human sentence in sans beside it. That makes the mono/sans rule structural, and
the error code becomes a permanent element rather than an afterthought — which is what you
want when the next move is pasting it to an agent.

Severity tints exactly two things: **the rule and the tag**. Never the body, never a
background. A neutral notice takes no colour.

`notice-stacked` collapses the gutter above the message for narrow containers. In the
implementation this should be a container query, not a modifier — the component should
adapt without the caller knowing.

*Rejected:* a bordered box with a coloured left stripe and a coloured dot — the shape every
UI converges on, which is why it reads as generic, and it spreads colour across three
elements instead of concentrating it. Also built and dropped: **tape** (hairlines top and
bottom, too quiet for a failed deploy) and **hatch** (hazard-tape edge, a strong mannerism
that would tire).

### 5.3 Stamp

A solid classification chip. A stamp labels a *thing*; a notice says a *sentence*. Its home
is deployment change `impact`, where severity is a typed field the UI must not omit.

Only the two impacts that can hurt you take colour — `destructive` and `replace`. `none`
and `reload` are outlined, `restart` is solid ink. A deployment with harmless changes
carries no colour. One destructive change is unmissable.

### 5.4 Terminal

Header with glyph and label, copy icon, highlighted body.

**Copy takes the command only** — prompts, comments, and sample output are tokenised so
they never reach the clipboard. That is the part that usually makes these blocks annoying.

**Highlighting is structural, not chromatic**: weight and ink alpha, not hue. Every other
colour means a state, so a purple keyword and a blue string would be the only colours in
the product meaning nothing — and would spend the exact hues that failing, pending, and
drifted own. The command sits at full ink because it is what you are being asked to run;
flags and values are qualification. A **dashed underline** marks a value you must
substitute, which needs no legend.

A `term-tinted` variant exists behind a modifier so the decision stays visible.

### 5.5 Empty state

Fixed anatomy so they read as the same object everywhere: `art` (optional), `title` stating
what is absent, `body` of one sentence on what to do, `actions` with exactly one primary,
and an `extra` slot for the thing you would otherwise navigate away to find — the enrolment
command, a docs link, a filter to clear.

`empty-inline` covers an empty region inside a populated screen: no illustration, smaller
type. It is a gap in a page, not a page.

**Illustrations follow one rule so they generate rather than get invented: solid hairline
is what exists, dashed is what is absent.** No servers is an empty rack; no deployments
is a pipeline with dashed steps; no activity is a flat trace. Flat elevations, **never
isometric** — blueprint drawing sits closer to paper-and-ink, and soft tinted isometric
spot art is the
house style of every other platform's empty state.

### 5.6 Card, key/value, table

**Card** — padding lives on `card-section`, never the card, so internal dividers reach both
edges.

**Key/value** — `kv-inline` (label left, value right) is the default for a detail head: it
reads as a spec sheet, a form people already know how to scan. Columns are kept narrow
enough that twelve pairs land in three rows; at two columns the head grows taller than the
content it heads. `kv` stacked is kept for wide grids of short uniform values.

**Table** — the table goes flush and cells carry the inset, so every rule reaches both
edges. This is the general pattern for any divided list.

**Dividers run edge to edge, always.** A rule that stops short of its container reads as
decoration; one that reaches the edge reads as structure, which is what it is.

### 5.7 Palette

One component for `⌘K` and for every picker. They are the same interaction — type to
narrow, arrow to choose, enter to commit — so a separate dropdown would mean two keyboard
models to learn and two to keep working.

Items group by what the thing **is**, because that is how you arrive: "I need a database",
not "I need to run a container". Selection is a **fill, not an outline** — an outline inside
a bordered panel reads as a second box. Group headers disappear when filtering empties them.

No keyboard legend.

### 5.8 Canvas

A project drawn as its dependency graph, rendered directly from `Link`.

**Dots, not a ruled grid** — a line grid reads as a table underlay and competes with the
edges; dots register as surface texture and leave the connections as the only lines.

**Edges are orthogonal, never curved.** Right angles are the system's grammar, and an
axis-aligned path is easier to trace by eye in a dense graph. **No edge labels** — a domain
wired to a proxy wired to an app explains itself.

**Dashing means exactly one thing: not applied yet.** It is not a second vocabulary of
relationship types.

**Volumes ride inside the thing that mounts them**, not as separate nodes — a volume is
mounted by exactly one resource, so an edge explaining that carries no information.

Shared resources carry a `SHARED` tag rather than relying on a dashed outline the reader
must have been told about.

Anchors must be **derived from measured node boxes at render time**, not computed from
assumed heights. Hand-placed coordinates broke twice in the prototype; the second time an
off-by-one made a draft edge stop 41px short, which read as unconnected — the one thing a
draft must not do.

### 5.9 Status marks

**Dot** — the atom of the whole dashboard. `healthy · pending · degraded · failed ·
stopped`. `dot-live` breathes for something in flight.

**Sweep** — indeterminate progress as a travelling segment on a hairline. Used where cockpit
waits on something it does not control: an OAuth round trip, a daemon's first contact.

**Gauge / metric** — a hairline meter or an icon-and-value pair. Peripheral vision, not data
you read, so they stay ink until something is actually hot.

### 5.10 Logs and steps

**Steps** are a horizontal strip, not a left column: the logs are what you read and want the
full width; steps are glanceable state, not navigation.

**Scrolling up pins the view** and offers *jump to latest*. This is the single most common
way log UIs get in the way.

**Only two log levels take colour** (error, success). Build output is not a severity feed;
tinting every warning would bury the one that matters.

---

## 6. States

Every screen that can be empty, loading, partial, or broken needs all four drawn. The
prototype carries them: auth has five, servers five, server four, deployment three.

Two rules learned from building them:

**Never show stale data as live.** A disconnected server shows em-dashes and `no data`, not
the last figures received — a stale 38% is visually identical to a live 38%. Its resource
rows keep last-known values but lose their status dots, and the section header says
`last known — 3d ago`.

**Absence is information.** A server that has never reported shows no metrics at all rather
than zeros, and an enrolling server shows no status dot — any dot would imply cockpit knows
something it has not been told.

---

## 7. Deliberately rejected

Kept so they are not re-proposed:

- Bordered box + colour stripe + coloured dot as the notice shape
- Filled pill for the active nav item
- Legends, edge labels, keyboard-hint rows
- Icons beside already-labelled fields
- Isometric, rounded, tinted spot illustration
- Rounded icon caps (HugeIcons' default, overridden)
- Identity tint on anything carrying state
- Big headline figures for reference values a server has no trend for
- `cmdk` — brings its own DOM for behaviour already specified, and the palette doubles as
  every picker
