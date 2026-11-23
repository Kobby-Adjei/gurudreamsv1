# AirBridge Pro (desktop)

AirBridge Pro is the desktop app for the computers you own. It lets the AI apps on those
computers (Claude Desktop, Cursor, Codex) hand tasks and code to each other, and gives you a
quiet place to see what is going on. It brings its own private network: there is nothing else to
install or sign in to. Any computer running AirBridge Pro and signed in to the same account
appears automatically.

- **Devices** shows a live map. This computer sits in the middle and your other computers are
  arranged around it, each marked *Online* or *Offline* with when it was last seen.
- **Activity** is a real-time feed written in plain sentences, such as "Received task from
  MacBook", "Sent code to Desktop-PC" and "Couldn't reach Studio-Mac — is it awake?".
- **Settings** gives you a one-click config snippet for Claude Desktop or Cursor, the private
  network's status (*Connected*, *Connecting…* or *Couldn't connect* with Retry; the address is
  behind *Details*), the health of the background service, and your account and plan.

Sign-in uses Clerk in your browser. A $15/month AirBridge Pro subscription (Stripe) unlocks
the app. Once a valid licence is confirmed, main starts the bundled network daemon, enrols this
computer in your account's private network, and then starts the Python `airbridge-core` daemon.
The Starting screen shows those two steps ("Connecting your private network", "Starting
AirBridge").

## Develop

```bash
cd desktop
npm install
AIRBRIDGE_DEV_MOCKS=1 npm run dev     # fake signed-in user + valid licence; this computer is
                                      # "Dev-Workstation", peers MacBook-Pro, Desktop-PC, Studio-Mac,
                                      # with live mock events
npm test                              # vitest (renderer tests run in jsdom)
npm run typecheck
```

`AIRBRIDGE_DEV_MOCKS` is honoured only in unpackaged builds.

## Build

```bash
npm run build:backend   # PyInstaller → resources/bin/<os>-<arch>/airbridge-core
npm run build           # electron-vite: out/main, out/preload, out/renderer
npm run dist            # electron-builder installers (signing/notarisation required for release)
```

### App icon

electron-builder reads `build/icon.png` (1024×1024, committed, rendered from `build/icon.svg`
with Playwright and Chrome). For release builds also generate the platform formats from it:

```bash
# macOS .icns (on a Mac)
mkdir -p build/icon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out build/icon.iconset/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) build/icon.png --out build/icon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns build/icon.iconset -o build/icon.icns && rm -r build/icon.iconset

# Windows .ico (ImageMagick, any OS)
magick build/icon.png -define icon:auto-resize=256,128,64,48,32,16 build/icon.ico
```

If `icon.png` changes, re-render it from the SVG at 1024×1024 with a transparent background.

## Architecture

```
┌──────────────────────────┐  window.airbridge   ┌──────────────┐   IPC (ab:*)   ┌──────────────────────────┐
│ Renderer (React+Tailwind)│ ◀─────────────────▶ │   Preload    │ ◀────────────▶ │          Main            │
│ sandboxed, no Node, CSP  │   frozen, Promise   │ contextBridge│  sender-origin │ auth (Clerk OIDC+PKCE)   │
│ SignIn·Paywall·Devices…  │   based API only    └──────────────┘   validated    │ licence gate (Ed25519)   │
└──────────────────────────┘                                                    │ network manager + enrol  │
                                                                                │ processManager           │
                                                                                └──────┬────────────┬──────┘
                                                 secrets on stdin, never argv/env      │            │ HTTP + WS on [::1],
                                                                                       ▼            ▼ bearer token (main only)
                                                   ┌─────────────────────────────┐  ┌──────────────────────────┐
                                                   │ airbridge-net sidecar       │  │ airbridge-core --daemon  │
                                                   │ (embedded tsnet, no admin)  │◀─│ control API · events     │
                                                   │ local control API · :8989   │─▶│ inbox on 127.0.0.1:<eph> │
                                                   └──────────────┬──────────────┘  └──────────────────────────┘
                                                                  │ encrypted (WireGuard), same account only
                                                                  ▼
                                                   ┌─────────────────────────────┐
                                                   │ your other computers running│
                                                   │ AirBridge Pro               │
                                                   └─────────────────────────────┘
```

In short: renderer ⇄ preload ⇄ main ⇄ (`airbridge-net` sidecar + `airbridge-core`).
`airbridge-net` (`sidecar/airbridge-net`, Go) embeds the open-source Tailscale `tsnet` library
(BSD-3; licence notices ship in `resources/licenses/`), joins AirBridge's own Headscale server with a
single-use key, exposes only port 8989 on the private network (WhoIs-verified, same account only) and
never needs or uses a system Tailscale. Log upload is disabled. See `../airbridge/docs/PHASE3_PLAN.md`
§9. The app UI never names it; it is just "your private network".

The renderer only ever talks to `window.airbridge` (see `src/shared/types.ts`). It never
sees the control token or any Clerk token.

### Renderer layout (`src/renderer`)

| Path | What it is |
|---|---|
| `App.tsx` | State machine (`deriveScreen`): loading → sign in → checking → paywall / starting (two steps: network, then backend) → ready, plus *Couldn't connect your devices* (network error) and *stopped unexpectedly* screens |
| `views/` | `SignIn`, `Paywall`, `Starting`, `ErrorScreen`, `MainShell`, `SwarmMap`, `ActivityFeed`, `Settings` |
| `components/` | `Sidebar` (footer line "Private network · Connected"), `PrivateNetworkCard`, `StatusDot`, `Card`, `Button`, `CopyButton`, `EmptyState`, `Toast`, `Skeleton`, `SendTaskSheet`, `DeviceGlyph`, hand-drawn `Icons` |
| `lib/` | `api.ts` (bridge access), `network.ts` (`window.airbridge.network` status hook, plain-language states), `hooks.ts` (5-second node polling, live events capped at 500), `format.ts` (event → sentence, relative time) |
| `styles.css` | Colour tokens as CSS variables. Dark by default, with a light palette under `prefers-color-scheme: light` |
| `devCsp.ts` | Vite plugin for the dev server only. It relaxes the CSP so HMR can work. Production keeps the strict policy |

### Design system

The aim is restraint in the spirit of Apple's System Settings and Find My. Hierarchy comes from
type, spacing and alignment, not from effects.

- **Brand:** the mark is concept (d), the A-frame pylon: a bridge tower that doubles as the
  "A" of AirBridge. A short mast head, flat-cut feet and a road deck that runs past both legs
  make it read as a pylon rather than a letter. It is monochrome (`currentColor`) and crisp at
  16px. The concepts sheet (`docs/brand/logo-concepts.png`), the chosen mark
  (`docs/brand/logo.svg`, mirrored in `LogoMark` in `components/Icons.tsx`) and the palette
  sheet are in `docs/brand/`. In the app the mark is near-white on navy (navy ink in light
  mode). The app icon is `build/icon.svg` (light blue `#8EC5FF` on a navy `#0D1626` rounded
  square), rendered to `build/icon.png` at 1024×1024.
- **Colour ("night flight"):** a deep navy canvas (`#070B14`) with layered navy surfaces
  (`#0B111D` → `#0F1828` → `#162236`), a subtle film grain and dot grid, cool near-white text
  (`#EEF3FA`) and cool blue-greys (`#A4B2C7`, `#8593A9`) for secondary text and hairlines. There
  is one accent, a soft **light blue** (`#8EC5FF`). It is used only for the single primary action
  on a screen (light-blue fill with navy `#07111F` text, 10.4:1), focus rings and active states
  (the selected sidebar item's icon, the chosen device in *Send a task*, a link on the map as a
  task goes out). A calm green (`#5CC99A`) is used only for *Online*. Light mode ("daylight
  sky") follows the OS: a pale cool-blue canvas (`#EEF3F9`), navy ink (`#0B1626`) and a deeper
  sky blue (`#1F63B5`, white text 6.0:1; links `#1A5DAD`). Every text pair meets WCAG AA; hex
  values and contrast ratios are in `docs/brand/palette.png`.
- **Superseded:** the earlier warm palette (International Orange `#C83A23` / `#C0362C` on a warm
  near-black `#0D0C0B`) is retired. Do not reintroduce orange or warm greys.
- **Surfaces:** flat cards with hairline borders and `rounded-2xl` corners. There are no glows,
  gradients or glass blur, and only overlays (sheet, toast) cast a shadow.
- **Status:** a small solid dot plus text, never colour alone and never pulsing.
- **Motion:** almost none. There are short one-shot fades for new items and the sheet, and a
  link on the device map brightens briefly when a task is sent. Nothing loops except the
  loading spinner. Everything turns off under `prefers-reduced-motion`.
- **Type:** system stack (`-apple-system` / SF Pro, Segoe UI Variable). Spacing follows an
  8-point grid.
- **Accessibility:** landmarks, a skip link, visible focus rings, full keyboard navigation
  (tabs, arrow keys, Esc, ⌘/Ctrl+1–3 to switch views, ⌘/Ctrl+N for *Send a task*), live
  regions, and body text that meets WCAG AA contrast. axe-core runs in the test suite.

## Screenshots

| | |
|---|---|
| ![Devices](docs/screenshots/swarm.png) | ![Activity](docs/screenshots/activity.png) |
| ![Settings](docs/screenshots/settings.png) | ![Sign in](docs/screenshots/signin.png) |
| ![Paywall](docs/screenshots/paywall.png) | ![Private network in Settings](docs/screenshots/extra/settings-network.png) |

More states (Starting steps, network error, *stopped unexpectedly*, private network *Details*
and *Connecting…*, no other devices, list layout, Send-a-task sheet, toast, narrow window, and
light mode for every main screen as `*-light.png`) are in `docs/screenshots/extra/`.
They were rendered with Playwright (system Chrome) from a production Vite build of
`src/renderer` with a mocked `window.airbridge`.

<!-- Section owned by Systems (main process / backend). UI/UX sections are above. -->

## Test the real app today (needs Headscale + license server)

The app no longer uses a system Tailscale at all (PHASE3_PLAN.md §9): its only network is the bundled
`airbridge-net` sidecar, which joins **your** Headscale server with a pre-auth key from **your** license
server. Signed out, the app runs but shows "Sign in to connect your devices" and the engine has no network
(the activity feed and the MCP config still work); see `docs/screenshots/extra/preview-real.png`, a capture
of the real app (real engine, no servers configured). So testing two real computers now needs:

1. **Headscale v0.29.7 + license server, reachable over HTTPS from both computers.** Use the kit in
   `../license-server/headscale/` (docker-compose: Headscale + Caddy TLS, `policy.hujson` =
   `autogroup:self:8989`) and `../license-server/README.md`. Both can be deployed to Railway or Fly.io
   (see "Deploy" there; Headscale needs a persistent volume for its SQLite DB and UDP 3478 for STUN,
   which Fly supports and Railway does not, so prefer Fly for Headscale). Set `HEADSCALE_URL`,
   `HEADSCALE_API_KEY`, `HEADSCALE_PUBLIC_URL` and `ENFORCE_ENTITLEMENT=false` (preview: any signed-in
   user gets keys). Nothing is deployed by this repo.
2. **Clerk** OAuth app (`CLERK_OAUTH_ISSUER`, `CLERK_OAUTH_CLIENT_ID`) and `AIRBRIDGE_LICENSE_URL` pointing at
   the license server, exported before `npm run dev` (or `MAIN_VITE_*` in `desktop/.env` for a build).
3. Get the code, the dependencies and the two binaries:
   ```bash
   git clone https://github.com/Kobby-Adjei/gurudreamsv1.git
   cd gurudreamsv1/desktop
   npm install
   npm run build:backend     # airbridge-core (PyInstaller) + airbridge-net (Go; GOTOOLCHAIN=auto fetches Go 1.27)
   ```
   `npm run build:net` builds only the sidecar; `bash scripts/build-net.sh all` cross-compiles
   darwin/arm64, darwin/amd64, windows/amd64 and linux/amd64 into `resources/net/<platform>-<arch>/`
   (with `manifest.json` sha256s). The script vendors `tailscale.com` (gitignored `vendor/`), empties
   tsnet's built-in DNS-fallback server list so the sidecar can never contact Tailscale-operated hosts,
   runs the Go tests against that tree, and refuses any binary that still embeds `derpN.tailscale.com`. Windows: `npm run build:backend:win`. Instead of the PyInstaller
   binary you can run the engine from source: create a venv with `../airbridge/requirements.txt` and export
   `AIRBRIDGE_PYTHON=<venv>/bin/python`.
4. Start it **without** `AIRBRIDGE_DEV_MOCKS` (and don't copy `.env.example`, which turns mocks on):
   ```bash
   npm run dev
   ```
   Sign in (Settings -> Account). The main-process log shows `enroll: joining private network as
   airbridge-<name>`, then the private network connects and the engine restarts once with it. Do the same on
   the second computer with the **same** account; each lists the other under Devices. A different account
   never sees your devices (Headscale `autogroup:self`, plus a WhoIs same-user check in every sidecar).
   Sidecar logs (keys/URLs redacted): `<data dir>/logs/airbridge-net.log`.

Without any servers, `AIRBRIDGE_DEV_MOCKS=1 npm run dev` still gives the fully mocked demo (no engine, no
network). The real private network can also be exercised on one Linux/macOS machine with no servers or
accounts: `../airbridge/tests/integration/run_real_sidecar.sh` (local Headscale + three sidecars + three
real engines).

The free CLI (`../airbridge`, no app) still uses a system Tailscale; that path is unchanged.

## Launch checklist (turn licensing on)

Do these together, only after the product owner approves the app:

1. **Desktop build flag:** build with `MAIN_VITE_AIRBRIDGE_ENFORCE_LICENSE=1` (CI env or `desktop/.env`).
   It is inlined at compile time, so a shipped app cannot be flipped back at runtime. Check the bundle:
   `grep -A2 'function licenseEnforced' out/main/index.js` must show `return true`.
2. **License server:** set `ENFORCE_ENTITLEMENT=true` (the production default; preview uses `false`) so
   `/v1/network/preauth-key` only issues keys to paying users.
3. **Desktop config baked in:** `MAIN_VITE_AIRBRIDGE_LICENSE_URL`, `MAIN_VITE_CLERK_OAUTH_ISSUER`,
   `MAIN_VITE_CLERK_OAUTH_CLIENT_ID` and the production license public keys (`publicKeys.ts`). An
   enforced build without them keeps the engine **blocked** ("Sign-in is not configured in this build").
4. **Private network:** `airbridge-net` built for every shipped platform (`npm run build:backend` per CI
   runner, or `scripts/build-net.sh all`), signed + notarized on macOS (`mac.binaries` in
   `electron-builder.yml`), and Headscale reachable over TLS at the license server's `HEADSCALE_PUBLIC_URL`
   (its DERP relay too: clients only speak TLS to DERP). Run `../airbridge/tests/integration/run_real_sidecar.sh`
   on macOS and do one manual two-computer run on Windows before GA.
5. **Smoke test the enforced build:** signed out -> sign-in wall and no `airbridge-core` process;
   inactive subscription -> Paywall, engine blocked; active -> private network connects, then the engine.
   `npx vitest run tests/previewMode.test.ts` covers both modes.
6. Remove the "Preview" label / preview copy if UI/UX hasn't gated it on `LicenseStatus.enforced` already.
