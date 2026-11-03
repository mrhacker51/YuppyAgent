# Office art — third-party notice

The room backgrounds, desks, characters, plants, appliances and effect sprites
under this directory come from **W17ant/Claude-Office**
(https://github.com/W17ant/Claude-Office), released under the MIT licence.

Copyright (c) 2026 W17ANT and contributors.

They are redistributed here unmodified except for a downscale to the display
sizes this app renders at, and are used under the terms of the MIT licence
included at `LICENSE-claude-office.txt`.

## What is NOT included

`Claude-Office` also ships a fan-made *The Office* (Dunder Mifflin) skin. That
skin — its character sprites, its prop art and the quoted lines from the show —
is explicitly **excluded from that project's MIT grant** and is therefore not
copied into this repository. Only the original office art and the generic
worker/agent sprites are used.

## Upstream layout mapping

| This app | Upstream |
|---|---|
| `rooms/office-day.png`, `rooms/office-night.png` | `public/rooms/` |
| `characters/<body>-<facing>.png` | `public/sprites/characters/` |
| `furniture/standing-desk-*.png`, `furniture/filling-*.png` | `public/sprites/furniture/` |
| `decoration/*.png` | `public/sprites/decoration/` |
| `appliances/coffee-*.png` | `public/sprites/appliances/` |
| `effects/*.png` | `public/sprites/effects/` |

The 800×600 room coordinate system in `src/lib/officeScene.ts` matches the
display size those assets were authored against.
