# Brand assets

Drawn by the user and delivered on 2026-09-06. **These SVGs are the source of record**; anything
else here is derived from them and can be regenerated.

| File | What it is | Where it is used |
| --- | --- | --- |
| `roost-icon.svg` | The app icon: the mark on its squircle, 512×512 | The window and desktop icon, via the PNGs below |
| `roost-logo.svg` | Mark and wordmark, wordmark in `#2B1A12` — **for a light ground** | `README.md` in a light theme |
| `roost-logo-dark.svg` | The same with the wordmark in `#FFF7F0` — **for a dark ground** | The library picker (`UI_SPEC.md` §3), `README.md` in a dark theme |
| `roost-mark.svg` | The bird alone, in the gradient, no background | Nothing yet |
| `roost-mark-mono.svg` | The bird as one path, `fill="currentColor"` | Nothing yet — this is the one to inline where a token should colour it |
| `icon-*.png` | 512, 256, 128, 64, 32 | `BrowserWindow`'s `icon`, and a desktop entry at packaging (M6) |

Regenerate the PNGs with:

```bash
node scripts/build-brand.mjs
```

It rasterises with Roost's own vector backend (ADR-0015: resvg in WebAssembly), so the icon is
drawn by the same code that would draw an SVG asset in a library. They are committed rather than
built on demand because the window opens before any build step could produce one.

The SVGs carry a C2PA provenance manifest in `<metadata>` — about 8 KB of the ~9.5 KB file. It is
left exactly as delivered: it is the author's record of how the artwork was made, and stripping it
to save a few kilobytes in a bundle would be deciding that for them.
