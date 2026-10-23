# Third-party notices

Roost is open source under the MIT licence, © 2026 Digitalku (see [LICENSE](LICENSE)). It is built
on other people's work, distributed under the terms below. Those terms govern those components, and
nothing in Roost's licence limits any right they give you.

This file is the index. **Every distributed artifact must carry it, together with the full
licence text of each component** — generated into `licenses/` at packaging time (M6), because an
index without the texts does not satisfy Apache-2.0, MPL-2.0, or LGPL-3.0.

Regenerate the package list with:

```bash
pnpm licenses list --prod
```

Last regenerated: 2026-09-08.

---

## 1. The runtime platform

| Component | Version | Licence |
| --- | --- | --- |
| Electron | 43.4.1 | MIT |
| Chromium (inside Electron) | — | BSD-3-Clause, and the licences listed in Chromium's own `credits.html` |
| Node.js and V8 (inside Electron) | 24.18.1 | MIT (Node.js), BSD-3-Clause (V8) |
| libffmpeg (inside Electron) | — | LGPL-2.1-or-later |

**libffmpeg is Electron's, and it is dynamically linked.** Ship it as the separate shared library
Electron ships it as — never statically linked into the binary — which is what keeps LGPL-2.1
satisfied however Roost itself is licensed.

**Roost's own use of ffmpeg is a different thing entirely and is not bundled.** ADR-0017 calls the
*system's* `ffmpeg` and `ffprobe` executables, probed once per session and absent gracefully. They
are never distributed with Roost, never linked against, and their licence — which for a
distribution build is frequently GPL — never reaches this product. **Do not bundle an ffmpeg
build**; if one is ever wanted, it needs an ADR that starts from the build's configure flags.

## 2. Components that oblige more than attribution

### sharp — Apache-2.0

Used unmodified. Apache-2.0 §4 requires its `NOTICE` file to travel with any distribution, and
requires a statement of modification where there is one; there is none.

### libvips — LGPL-3.0-or-later

`sharp`'s image library. On Linux, Roost builds `sharp` from source against **the system's**
libvips (ADR-0013), so a development install links a library it does not ship.

**Packaging changes this.** An AppImage or a Flatpak bundles libvips, and LGPL-3.0 then requires
that the library's source be offered and that the user be able to relink Roost against their own
build of it — which means bundling it as a **shared** object, never statically. The prebuilt
`@img/sharp-libvips-linux-x64` in the dependency tree is the package that carries it.

### @resvg/resvg-wasm — MPL-2.0

The SVG rasteriser (ADR-0015). MPL-2.0 is file-level copyleft: the obligation is to make the
source of *those files* available, and it is discharged by naming the exact released version,
which is used unmodified — `@resvg/resvg-wasm` 2.6.2, `https://github.com/thx/resvg-js`.

**Do not vendor and patch it.** Modifying resvg's own files puts the modifications under MPL-2.0
and obliges publishing them; keeping to a released version keeps that boundary clean.

### pdfium — BSD-3-Clause

Bundled inside `@hyzyla/pdfium` (MIT wrapper) as WebAssembly (ADR-0016). Attribution only: the
copyright notice and the disclaimer must appear in the distributed licence texts.

## 3. Every production dependency

Workspace packages (`@roost/*`) are Roost's own and are not listed. Type-only packages are
omitted because they are erased at build time and reach no artifact.

**MIT** — 93 packages

`@floating-ui/core` · `@floating-ui/dom` · `@floating-ui/react-dom` · `@floating-ui/utils` ·
`@hyzyla/pdfium` · `@img/colour` · `@napi-rs/blake-hash` · `@napi-rs/blake-hash-linux-x64-gnu` ·
`@radix-ui/number` · `@radix-ui/primitive` · `@radix-ui/react-accessible-icon` ·
`@radix-ui/react-accordion` · `@radix-ui/react-alert-dialog` · `@radix-ui/react-arrow` ·
`@radix-ui/react-aspect-ratio` · `@radix-ui/react-avatar` · `@radix-ui/react-checkbox` ·
`@radix-ui/react-collapsible` · `@radix-ui/react-collection` · `@radix-ui/react-compose-refs` ·
`@radix-ui/react-context` · `@radix-ui/react-context-menu` · `@radix-ui/react-dialog` ·
`@radix-ui/react-direction` · `@radix-ui/react-dismissable-layer` ·
`@radix-ui/react-dropdown-menu` · `@radix-ui/react-focus-guards` · `@radix-ui/react-focus-scope`
· `@radix-ui/react-form` · `@radix-ui/react-hover-card` · `@radix-ui/react-id` ·
`@radix-ui/react-label` · `@radix-ui/react-menu` · `@radix-ui/react-menubar` ·
`@radix-ui/react-navigation-menu` · `@radix-ui/react-one-time-password-field` ·
`@radix-ui/react-password-toggle-field` · `@radix-ui/react-popover` · `@radix-ui/react-popper` ·
`@radix-ui/react-portal` · `@radix-ui/react-presence` · `@radix-ui/react-primitive` ·
`@radix-ui/react-progress` · `@radix-ui/react-radio-group` · `@radix-ui/react-roving-focus` ·
`@radix-ui/react-scroll-area` · `@radix-ui/react-select` · `@radix-ui/react-separator` ·
`@radix-ui/react-slider` · `@radix-ui/react-slot` · `@radix-ui/react-switch` ·
`@radix-ui/react-tabs` · `@radix-ui/react-toast` · `@radix-ui/react-toggle` ·
`@radix-ui/react-toggle-group` · `@radix-ui/react-toolbar` · `@radix-ui/react-tooltip` ·
`@radix-ui/react-use-callback-ref` · `@radix-ui/react-use-controllable-state` ·
`@radix-ui/react-use-effect-event` · `@radix-ui/react-use-escape-keydown` ·
`@radix-ui/react-use-is-hydrated` · `@radix-ui/react-use-layout-effect` ·
`@radix-ui/react-use-previous` · `@radix-ui/react-use-rect` · `@radix-ui/react-use-size` ·
`@radix-ui/react-visually-hidden` · `@radix-ui/rect` · `aria-hidden` · `base64-js` ·
`better-sqlite3` · `brotli` · `clone` · `detect-node-es` · `dfa` · `fast-deep-equal` · `fontkit`
· `get-nonce` · `node-addon-api` · `pako` · `radix-ui` · `react` · `react-dom` ·
`react-remove-scroll` · `react-remove-scroll-bar` · `react-style-singleton` · `restructure` ·
`scheduler` · `tiny-inflate` · `unicode-properties` · `unicode-trie` · `use-callback-ref` ·
`use-sidecar`

**Apache-2.0** — 4 packages

`@img/sharp-linux-x64` · `@swc/helpers` · `detect-libc` · `sharp`

**ISC** — 1 package

`semver`

**0BSD** — 1 package

`tslib`

**MPL-2.0** — 1 package

`@resvg/resvg-wasm`

**LGPL-3.0-or-later** — 1 package

`@img/sharp-libvips-linux-x64`

---

## 4. Fonts, icons, and brand assets

Roost's interface uses the operating system's font stack and ships no font files — invariant 7
forbids a webfont, and no local one was added. The wordmark, the icon, and everything under
`assets/brand/` are Digitalku's own work and are **not** covered by any of the licences above:
they are trademarks, and the licence to use Roost is not a licence to use its name or its mark.
