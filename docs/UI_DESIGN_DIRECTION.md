# YuppyCode · Aurora Deck — UI direction (v2)

One deck, one language. The app is an operations console for a team of real
CLI agents; the design has to make the team legible at a glance and get out of
the way of terminal text.

## Identity

**Aurora Deck** — deep ink glass, one signal-teal accent, an indigo structural
accent, and warm amber reserved for "needs a human". Light comes from above
and from the edges: hairline frames, a top-lit glass edge, and a single moving
beam only where work is genuinely running.

Not allowed: glow soup, gradient text on body copy, purple-on-purple, six
accent colours on one screen, neon shadows around every card. If everything
glows, nothing is important.

## Surfaces

Three levels only:

| Token | Use |
|---|---|
| `--bg-0` | app background (behind the aurora) |
| `--surface-1` / `.deck-surface` | panel body: translucent ink + 2px blur |
| `--surface-2` / `.deck-rail` | panel header, tool strips |

Rules
- Panel radius `10px`, inner controls `6px`, chips `4px`. No pills except
  status dots and the composer.
- Exactly **one** border per panel (`border-line`). Live panels add
  `border-accent/25` + `.deck-surface-live`.
- `.deck-live-beam` is a 1px animated gradient line on the panel's top edge.
  Only for panels with running work.
- No drop shadows heavier than `0 12px 32px -18px rgba(0,0,0,0.8)`.

## Layout

- The shell is a **bento deck**: 8px gutters, panels inset from the window by
  8px, header 44px, status rail 24px. Every pane keeps its own scroll.
- Module navigation reads as a horizontal dock (icon + label, active item gets
  a lit underline and a 1px top edge), not a strip of plain text buttons.
- The left column is the "agent floor" (office map + team roster), the centre
  is the console, the right is the live matrix. The user may re-split them;
  never hard-code fixed pixel widths.
- Density: 2.5% more whitespace than v1 around headings, same dense body text.
  Terminal cells keep their current geometry.

## Type

- UI labels: mono, 8–9px, uppercase, `tracking-[0.14em]`–`[0.18em]`,
  `text-text-lo` / `text-text-mid`.
- Values: mono, `tabular-nums`, 9–11px, `text-text-hi`.
- Headlines (module titles only): sans, 13–15px, `font-medium`, `text-text-hi`.
- Never letter-space sentence copy; never uppercase a Turkish sentence that
  contains lowercase-specific letters unless it is a label.

## Motion

- Motion explains state change or it does not ship. One beam, one ticker, one
  spring per surface.
- Respect `prefers-reduced-motion`: the aurora grid, beams and spotlight stop;
  layout never depends on animation.
- Hover: 120–160ms. Panel entrance: 180ms fade + 4px rise, once.

## Components (fancy-ui-react) and where they belong

| Surface | Components |
|---|---|
| Shell | `DeckBackground` (ours), `FlickeringGrid` inside it |
| Module dock / header | `Dock`, `Tooltip`, `CommandMenu`, `NumberTicker`, `StatusMorph` |
| Panels | `DeckPanel` (ours), `CardSpotlight` on pointer-capable panel bodies, `PulseBeam` for at most one "hot" panel |
| Live agent cards | `BorderBeam` (running only), `StatusMorph`, `ThinkingIndicator` |
| Team / tasks | `SubagentList`, `AgentPlan`, `ToolTimeline`, `ToolCall`, `ApprovalCard` |
| Console feed | `ChatMessage`, `StreamingText`, `TypingIndicator`, `ScrollAnchor` |
| Settings / forms | `Switch`, `Slider`, `Select`, `FormField`, `SearchInput` |
| Feedback | `Toaster` + `toast()` driven only by real bridge log lines |

## Truth rules (non-negotiable)

- Every number, avatar, progress bar and status is read from `useHudStore`
  (bridge). Never synthesise activity, never animate a fake percentage.
- Loading states use `Skeleton` only while data is genuinely absent.
- Empty states say what is missing and what to do, in Turkish, without filler.

## Turkish microcopy

Short, imperative, factual. `canlı`, `sırada`, `bitmedi`, `onay bekliyor`,
`köprü bağlı değil`, `koltuk yok`. No exclamation marks, no emoji in chrome
(the office scene and pixel avatars carry personality instead).
