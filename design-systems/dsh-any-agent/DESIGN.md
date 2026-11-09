---
version: alpha
name: dsh-any-agent-site
description: The dsh-any-agent website's own look, extracted from website/src/style.css. A dark-first developer page in deep navy with a soft periwinkle-blue accent, bold tight-tracked sans headlines, mono kicker labels, and a live product demo framed as an app window. A light theme mirrors it on near-white with a stronger cobalt accent. Calm, technical, precise; the brand art is a blue-haired chibi whale-girl and a single-ink whale mark.

# Dark is the default theme (declared on :root). Effective values, including the
# readability override near the end of style.css (--faint).
colors:
  bg: "#0a101c"
  panel: "#101928"
  panel-raised: "#152032"
  surface: "#0d1523"
  ink: "#edf3ff"
  muted: "#96a4ba"
  faint: "#8190a6"
  line: "#263247"
  soft-line: "#1c293c"
  accent: "#86b4ff"
  accent-strong: "#528ef0"
  accent-tint: "#172b49"
  green: "#84d5b0"
  amber: "#e2bd7b"
  button-ink: "#0a1425"
  logo-cut: "#0a101c"

# Light theme: <html data-theme="light">. Effective values, including the
# override near the end of style.css (--faint, --muted).
colors-light:
  bg: "#fafbfd"
  panel: "#ffffff"
  panel-raised: "#f5f7fb"
  surface: "#f0f4fa"
  ink: "#152137"
  muted: "#55657d"
  faint: "#4b5b73"
  line: "#dbe2ed"
  soft-line: "#e6ebf2"
  accent: "#2b5fc4"
  accent-strong: "#2b5fc4"
  accent-tint: "#e9f0fe"
  green: "#26795c"
  amber: "#7a5a1f"
  button-ink: "#ffffff"
  logo-cut: "#fafbfd"

# Fixed in both themes.
colors-fixed:
  closing-band: "#07142a"
  closing-ink: "#edf3ff"
  closing-label: "#92a8c9"
  closing-body: "#aab9d0"
  closing-primary: "#86b4ff"
  closing-primary-ink: "#0a1425"
  closing-secondary: "#101d33"
  closing-secondary-line: "#34435a"
  window-dot-red: "#d7747b"
  window-dot-amber: "#c7a76c"
  window-dot-green: "#73b29b"
  hero-glow: "#376de916"
  favicon-tile: "#0a1425"
  favicon-mark: "#86b4ff"

typography:
  display:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: clamp(40px, 5.1vw, 68px)
    fontWeight: 750
    lineHeight: 1.21
    letterSpacing: -2.5px
  section:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: clamp(27px, 3.4vw, 41px)
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: -1px
  section-faq:
    fontSize: clamp(28px, 3.6vw, 40px)
    fontWeight: 750
    letterSpacing: -0.8px
  closing-title:
    fontSize: 36px
    fontWeight: 700
  title-lg:
    fontSize: 17px
    fontWeight: 650
  title-md:
    fontSize: 16px
    fontWeight: 650
  title-sm:
    fontSize: 15px
    fontWeight: 650
    lineHeight: 1.6
    letterSpacing: -0.2px
  lead:
    fontSize: 17px
    lineHeight: 1.9
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.7
  body-sm:
    fontSize: 13px
    lineHeight: 1.85
  nav-link:
    fontSize: 13px
  button:
    fontSize: 13px
    fontWeight: 650
  caption:
    fontSize: 11px
  kicker:
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace"
    fontSize: 10px
    fontWeight: 600
    letterSpacing: 1.7px
  code:
    fontFamily: "SFMono-Regular, Consolas, Microsoft YaHei, monospace"
    fontSize: 13px
  brand:
    fontSize: 17px
    fontWeight: 750
    letterSpacing: -0.5px

rounded:
  xs: 4px
  chip: 5px
  sm: 6px
  tab: 7px
  md: 8px
  card-install: 11px
  lg: 12px
  shell: 13px
  xl: 14px
  video: 18px
  pill-sm: 20px
  pill: 30px
  full: 50%

spacing:
  container: min(1140px, 100% - 64px)
  container-wide: 1160px
  nav-height: 76px
  button-height: 44px
  icon-button: 34px
  section-hero: 73px 0 44px
  section-capabilities: 91px 0 83px
  section-install: 79px 0
  section-faq: 88px 0 86px
  section-clients: 73px 0 74px

shadow:
  window: 0 24px 90px #00000035
  window-light: 0 24px 90px #263d6712
  card-install: 0 9px 25px #00000008
  card-faq: 0 12px 36px #0000000a
  tab-selected: 0 2px 6px #00000012
  button-primary: 0 3px 10px #326cd515

components:
  header:
    backgroundColor: "color-mix(in srgb, {colors.bg} 88%, transparent)"
    backdropFilter: blur(18px)
    borderBottom: 1px solid {colors.soft-line}
    height: 76px
    position: sticky
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.button-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 10px 19px
    height: 44px
    shadow: "{shadow.button-primary}"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    border: 1px solid {colors.line}
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 10px 19px
    height: 44px
  icon-button:
    border: 1px solid {colors.line}
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    size: 34px
  github-nav:
    backgroundColor: "{colors.panel}"
    border: 1px solid {colors.line}
    rounded: "{rounded.pill-sm}"
    padding: 4px 9px 4px 10px
  star-badge:
    backgroundColor: "{colors.accent-tint}"
    textColor: "{colors.accent}"
    rounded: "{rounded.lg}"
    padding: 2px 7px
  release-pill:
    border: 1px solid {colors.line}
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: 5px 13px
  scenario-tabs:
    backgroundColor: "{colors.surface}"
    border: 1px solid {colors.line}
    rounded: "{rounded.lg}"
    padding: 5px
  scenario-tab-selected:
    backgroundColor: "{colors.panel-raised}"
    border: 1px solid {colors.line}
    textColor: "{colors.ink}"
    rounded: "{rounded.tab}"
    shadow: "{shadow.tab-selected}"
  demo-shell:
    backgroundColor: "{colors.panel}"
    border: 1px solid {colors.line}
    rounded: "{rounded.shell}"
    shadow: "{shadow.window}"
  window-bar:
    backgroundColor: "{colors.panel-raised}"
    height: 44px
    padding: 0 21px
  status-badge:
    backgroundColor: "{colors.accent-tint}"
    textColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    padding: 3px 8px
  tool-card:
    backgroundColor: "{colors.surface}"
    border: 1px solid {colors.line}
    rounded: "{rounded.md}"
  feature-grid:
    border: 1px solid {colors.line}
    rounded: "{rounded.lg}"
  feature-card:
    backgroundColor: "{colors.panel}"
    padding: 24px 25px 26px
    divider: 1px solid {colors.line}
  install-section:
    backgroundColor: "{colors.surface}"
    borderBlock: 1px solid {colors.line}
    padding: 79px 0
  install-card:
    backgroundColor: "{colors.panel}"
    border: 1px solid {colors.line}
    rounded: "{rounded.card-install}"
    shadow: "{shadow.card-install}"
  command-row:
    backgroundColor: "{colors.surface}"
    border: 1px solid {colors.line}
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
    padding: 7px 9px 7px 12px
  faq-card:
    backgroundColor: "{colors.panel}"
    border: 1px solid {colors.line}
    rounded: "{rounded.lg}"
    shadow: "{shadow.card-faq}"
  faq-row:
    padding: 26px 32px
    columns: 290px 1fr
  closing-section:
    backgroundColor: "{colors-fixed.closing-band}"
    textColor: "{colors-fixed.closing-ink}"
    border: 1px solid {colors.line}
    rounded: "{rounded.xl}"
    minHeight: 349px
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg}"
    rounded: "{rounded.md}"
    padding: 10px 20px
  footer:
    textColor: "{colors.faint}"
    padding: 35px 0 31px
---

## Overview

The dsh-any-agent website is a **dark-first developer page**. The floor is a deep navy (`{colors.bg}` — #0a101c) layered with slightly lifted navy panels; the one accent is a soft periwinkle blue (`{colors.accent}` — #86b4ff) that marks the brand mark, the second line of the hero headline, primary buttons, commands, active states and links. A light theme mirrors every role on near-white (`#fafbfd`) with a stronger cobalt accent (`#2b5fc4`) so the same accent keeps its contrast.

Headlines are **bold, tightly tracked sans** (Inter at 700–750 with negative letter-spacing). Small **monospace uppercase kickers** (`THE WORKFLOW, ALIVE`) introduce every section, giving the page a terminal-adjacent, engineered voice. The centrepiece is an interactive product demo framed as an **app window** (window bar with traffic-light dots, a client panel, a task panel, an event log, a timeline) — the page explains the product by running it.

Surfaces are defined by **1px lines first, shadows second**: panels sit on the floor with `{colors.line}` borders; only the demo window, the install card and the FAQ card carry soft long shadows. The closing call to action is the one fixed-colour block: a deep navy band (`#07142a`) that stays dark in both themes, with the brand illustration masked in from the right.

**Key characteristics**
- Dark navy by default; the theme follows the visitor's system preference and a toggle, remembered in `localStorage` (`dsh-theme`) and applied before paint.
- One blue accent, two strengths: periwinkle on dark, cobalt on light. Green and amber are status colours only.
- Bold sans headlines (700–750, −1 to −2.5px tracking); the hero's second line is in the accent colour.
- Mono for kickers, indexes, labels, commands and code.
- Bordered panels with 7–14px radii; pills (20–30px) for badges and the release chip.
- Brand art: the chibi whale-girl header image and a single-ink whale mark.

## Colors

All colours are CSS custom properties on `:root` (dark) and `:root[data-theme=light]`. Build against the variable names; both themes then follow.

| Role | Dark | Light | Use |
|---|---|---|---|
| `bg` | #0a101c | #fafbfd | Page floor; header at 88% with blur |
| `panel` | #101928 | #ffffff | Cards, demo window, secondary buttons |
| `panel-raised` | #152032 | #f5f7fb | Window bar, selected tab, hover fills, notes |
| `surface` | #0d1523 | #f0f4fa | Inset areas: tab track, client panel, tool card, install band, command rows |
| `ink` | #edf3ff | #152137 | Headlines and primary text |
| `muted` | #96a4ba | #55657d | Body copy, descriptions, nav links |
| `faint` | #8190a6 | #4b5b73 | Kickers, meta, indexes, captions, footer |
| `line` | #263247 | #dbe2ed | All 1px borders and dividers |
| `soft-line` | #1c293c | #e6ebf2 | Header border, inner dividers, progress track |
| `accent` | #86b4ff | #2b5fc4 | Brand mark, hero second line, primary fill, commands, links, active state |
| `accent-strong` | #528ef0 | #2b5fc4 | Passed timeline steps, selected job, disk chip border |
| `accent-tint` | #172b49 | #e9f0fe | Badge and selection backgrounds behind accent text |
| `green` | #84d5b0 | #26795c | Done / received / connected; code strings |
| `amber` | #e2bd7b | #7a5a1f | Interrupted / detached; code values; the star glyph |
| `button-ink` | #0a1425 | #ffffff | Text on accent fills (dark ink on dark theme, white on light) |
| `logo-cut` | #0a101c | #fafbfd | Cut-outs inside the whale mark (equals `bg`) |

**Contrast** (WCAG, measured): every text role passes AA in both themes. Dark: `ink`/`bg` 17.1:1, `muted`/`bg` 7.5:1, `faint`/`panel` 5.4:1, `accent`/`bg` 9.1:1, `button-ink` on `accent` 8.8:1, `accent` on `accent-tint` 6.8:1. Light: `ink`/`bg` 15.6:1, `muted`/`bg` 5.7:1, `faint`/`bg` 6.7:1, `accent`/`bg` 5.7:1, white on `accent` 5.9:1, `green`/`surface` 4.8:1. The `--faint` and `--muted` overrides at the end of style.css exist for this: keep them.

**Tints by mixing.** Hover and status fills are `color-mix(in srgb, <role> N%, transparent)` rather than new tokens: status badges 8–9% fill with a 15–20% border; the primary hover is `accent` mixed 85% with white; selected client buttons use a 65% accent border.

**Fixed colours.** The closing band (`#07142a`, text `#edf3ff`, label `#92a8c9`, body `#aab9d0`, primary `#86b4ff` on `#0a1425`, secondary `#101d33` with `#34435a` border) does not change with the theme. Window dots are `#d7747b`, `#c7a76c`, `#73b29b`. Client glyphs in the demo use their own colours (Claude `#cf8d73`, Cursor `#a6acbf`, Codex `ink`). The hero has a faint radial glow (`#376de916`). `theme-color` is `#0a101c`.

## Typography

- **Sans** for everything readable: `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`. Inter is not bundled; the stack falls back to the system UI face, and Chinese uses PingFang SC / Microsoft YaHei. `font-synthesis: none`.
- **Mono** for kickers, indexes, labels and code: `"SFMono-Regular", Consolas, "Liberation Mono", monospace`; inline code and the event log add `"Microsoft YaHei"` so Chinese in code stays legible.
- Body is 15px / 1.7.

| Style | Size | Weight | Line height | Tracking | Use |
|---|---|---|---|---|---|
| display (h1) | clamp(40px, 5.1vw, 68px) | 750 | 1.21 | −2.5px | Hero headline; second line in `accent` |
| section (h2) | clamp(27px, 3.4vw, 41px) | 700 | 1.35 | −1px | Section headings, often two lines |
| section-faq | clamp(28px, 3.6vw, 40px) | 750 | — | −0.8px | FAQ heading |
| closing-title | 36px | 700 | — | — | Closing band heading |
| title-lg | 17px | 650 | — | — | Scenario explanation heading |
| title-md | 16px | 650 | — | — | Demo task title |
| title-sm | 15px | 650 | 1.6 | −0.2px | FAQ questions; feature card titles use the same size and tracking at the h3 default weight (700) |
| lead | 17px | 400 | 1.9 | — | Hero description, `muted` |
| body | 15px | 400 | 1.7 | — | Default |
| body-sm | 13px | 400 | 1.85–1.95 | — | Section intros, FAQ answers, feature text, install copy |
| nav-link | 13px | 400 | — | — | Header links, `muted` |
| button | 13px | 650 | — | — | Buttons |
| caption | 11px | 400 | — | — | Hero meta, small labels |
| kicker | 10px mono | 600 | — | 1.7px | Uppercase section kickers, `faint` (accent on the FAQ) |
| code | 11–13px mono | 400 | — | — | Commands (`accent`), config, logs |
| brand | 17px | 750 | — | −0.5px | Wordmark beside the whale |

Rules: headlines are heavy (700–750) with negative tracking; body never goes bolder than 650. Kickers are uppercase mono with wide tracking. Code syntax: keys `accent` 600, strings `green`, values `amber`, comments `faint` italic, arrows `accent` 700.

## Layout

- **Container** `.wrap`: `min(1140px, calc(100% - 64px))`, centred; 1160px from 1600px wide; `100% - 36px` below 760px; `100% - 32px` below 540px.
- **Header**: sticky, 76px tall (65px below 760px), `bg` at 88% with an 18px backdrop blur and a `soft-line` bottom border. `scroll-padding-top` is 105px so anchors clear it.
- **Section rhythm** (top / bottom): hero 73 / 44px (90px top from 1600px), clients 73 / 74px, capabilities 91 / 83px, install band 79px, FAQ 88 / 86px. Sections are introduced by a kicker row (`section-kicker`, 18px below) and a heading row that puts the h2 left and a short `muted` paragraph right (`section-heading`, 50px gap, 37px below).
- **Grids**: features 3-up joined into one bordered block; principles 3-up with 40px gaps; install 0.85fr / 1.15fr with 85px column gap; FAQ rows 290px question column + answer, 36px gap; demo window 265px client panel + task panel.
- Spacing values are hand-tuned per component (5, 7, 9, 11, 13, 15, 23px…) rather than taken from a scale; copy the component's own values when extending it.

## Elevation & depth

| Level | Treatment | Use |
|---|---|---|
| Floor | `bg` | Page |
| Inset | `surface` fill + 1px `line` | Tab track, client panel, tool cards, command rows, install band |
| Panel | `panel` fill + 1px `line` | Cards, feature block, secondary buttons |
| Raised | `panel-raised` | Window bar, selected tab (+ `0 2px 6px #00000012`), hover |
| Floating | `0 24px 90px #00000035` (light `#263d6712`) | Demo window, toast |
| Soft card | `0 9px 25px #00000008` / `0 12px 36px #0000000a` | Install card / FAQ card |
| Glass | `bg` 88% + `blur(18px)` | Sticky header |

Borders carry the structure; shadows are long, soft and low-alpha. The runtime node has a 3px accent ring at 4%.

## Shapes

| Radius | Use |
|---|---|
| 4px | Copy button, inline code, inline actions, job rows |
| 5px | Chips, focus outline |
| 6px | Command rows, config tabs, mini output |
| 7px | Scenario tab buttons, client buttons, step numbers, manual note |
| 8px | Buttons, icon buttons, runtime node, tool card, toast |
| 11px | Install card |
| 12px | Scenario tab track, feature block, FAQ card, star badge |
| 13px | Demo window |
| 14px | Closing band |
| 18px | Video frame (12px below 720px) |
| 20px | GitHub nav pill, runtime status |
| 30px | Release pill, status badges |
| 50% | Dots |

## Imagery & iconography

- **Brand header image** (`docs/brand/header.jpg`): a blue-haired chibi whale-girl eating rice beside a coding laptop. It is the hero visual of the README, the Open Graph image, and the art masked into the closing band.
- **Whale mark**: a single-ink SVG symbol (`#whale`) filled with `currentColor` (set to `accent`), with cut-outs in `--logo-cut` so it reads on either theme. The favicon is the same whale in `#86b4ff` on a `#0a1425` rounded tile (rx 13 of 48).
- **Icons**: 20px inline SVGs by default (17px in buttons, 16px in the window bar), stroked or filled in `currentColor`.
- **Glyphs** instead of emoji: ✓ (checks, principles), ★ (stars), ✦ ✧ ✳ (client marks), → (arrows). No colour emoji on the site.
- **Promo video**: a 16:9 encode with poster in an 18px-radius bordered `panel` frame, inside the "See it in 54 seconds" section.

## Motion

- Buttons lift `translateY(-2px)` on hover (0.18s); primary lightens to `accent` 85% + white.
- Colour, border and background transitions run 0.18–0.2s.
- Demo: the connection line's dot travels down in 1.8s loops (3.2s at 60% opacity when idle; paused and recoloured amber or green on interrupt or done); the progress bar eases over 0.65s `cubic-bezier(.2,.65,.2,1)`; a landed sentinel pulses green for 0.8s.
- Text links nudge their arrow 4px right on hover.
- `prefers-reduced-motion: reduce` turns off smooth scrolling.

## Components

- **Header / nav**: whale mark + wordmark (`brand`), `muted` 13px links with `ink` hover, a 34px bordered icon button for the theme toggle, and a GitHub pill (`panel`, 20px radius) with an accent star badge.
- **Release pill**: bordered 30px pill with a green pulse dot, uppercase 10px tracked label, a 1px divider and the runtime-fetched version.
- **Hero**: centred; h1 with the second line in `accent`; `lead` description in `muted`; primary + secondary buttons; a `faint` meta row with 3px dot separators; a flow row (client → dsh-any-agent → DeepSeek Harness) with `line`-coloured arrows that turn accent on hover.
- **Buttons**: primary (accent fill, `button-ink`, soft blue shadow) and secondary (`panel`, `line` border); 44px tall, 8px radius, 13px / 650, icon gap 11px.
- **Scenario tabs**: a 4-up segmented control on a `surface` track; the selected tab rises to `panel-raised` with a border and a small shadow; mono step numbers turn accent when selected.
- **Demo window**: `panel` shell with 13px radius and the floating shadow; window bar with three dots, a breadcrumb and a mono `LOCAL RUNTIME` label; client panel (`surface`) with selectable client buttons (accent-tint when pressed), a connection line and a runtime node; task panel with status badge, goal row, step story, tool card, progress track and receipt row; event log; timeline and playback controls.
- **Status badge**: pill, accent on `accent-tint` by default; green when done; amber when interrupted or detached.
- **Feature block**: three `panel` cards joined into one bordered 12px block with vertical dividers; each has a mono index, a 15px title, `muted` text and a mono footer line above a `soft-line` rule.
- **Install band**: full-width `surface` band; copy left (h2, `muted` text, accent text links with arrows), install card right (numbered steps, command rows in accent mono with copy buttons, a `panel-raised` note), and a collapsible manual-config block with tabbed config code.
- **FAQ card**: one `panel` card, rows split 290px question / answer, `line` dividers, rows tint on hover; answers use underlined accent links and inline code on `surface`.
- **Closing band**: fixed navy, two columns, copy left (kicker, h2, short text, primary + secondary buttons), brand art masked in from the right.
- **Footer**: whale + wordmark, a 10px line, and right-aligned links in `faint`.
- **Toast**: inverted (`ink` fill, `bg` text), 8px radius, floating shadow, slides up from the bottom.

## Do's and don'ts

### Do
- Keep dark navy as the default and let the light theme mirror every role through the same variables.
- Use the single blue accent for the one thing that matters in each block; keep green and amber for status.
- Introduce sections with an uppercase mono kicker, then a bold sans h2.
- Show the product working (the demo window, real commands) rather than describing it.
- Use 1px `line` borders for structure and long soft shadows only on floating pieces.
- Keep every text pair at AA in both themes, as the current values do.

### Don't
- Don't add a second accent hue or tint surfaces with colour; navy, white and the one blue carry the page.
- Don't thin the headlines: the hero and section heads are 700–750 with negative tracking.
- Don't use colour emoji; use the existing glyphs (✓ ★ ✦ →).
- Don't recolour the closing band per theme; it is fixed navy on purpose.
- Don't replace the whale mark or the header art: they are the brand.

## Responsive behavior

| Breakpoint | Changes |
|---|---|
| ≥ 1600px | Container 1160px; hero top padding 90px |
| ≤ 1000px | Tighter nav gaps; GitHub label hidden; feature cards 20px side padding; closing title 32px |
| ≤ 760px | Container `100% - 36px`; nav 65px, first nav link and GitHub pill hidden; h1 49px / −1.7px / 1.3; sections stack (install, FAQ rows, scenario explanation); feature cards become rows with the illustration on the right; closing band single column, secondary button hidden |
| ≤ 540px | Container `100% - 32px`; h1 clamp(31px, 8.7vw, 43px) / −1px / 1.4; buttons 41px tall, 11px text; scenario tabs lose their numbers; feature cards single column; footer stacks |

## Known gaps

- Spacing is hand-tuned per component, not a named scale; reuse a component's own values when extending it.
- Inter is referenced but not bundled; the actual face depends on the visitor's system.
- Small demo text (8–10px) is legible by contrast but small by size; it is decorative chrome around the explained step.
