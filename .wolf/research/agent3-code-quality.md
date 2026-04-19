# Agent 3 — Code Quality Gates, CI, and Project Hygiene

## What pingdotgg/t3code actually has

**Important framing:** t3code is **Electron + TypeScript**, not Tauri. There is no `src-tauri/`, no `Cargo.toml`, no `rustfmt.toml`, no `clippy.toml`. Their gates are 100% JS/TS. Terminal 64 has to design the Rust half itself — t3code provides no template for it.

| Concern | t3code uses | File |
|---|---|---|
| Tool versions | `mise` + package.json `engines` | `.mise.toml`, `package.json` |
| Package manager | Bun 1.3.x, single lockfile | `bun.lock`, `packageManager: bun@1.3.11` |
| Linter | **oxlint** (not ESLint) | `.oxlintrc.json` |
| Formatter | **oxfmt** (not Prettier/Biome) | `.oxfmtrc.json` |
| TS strictness | Extreme — see below | `tsconfig.base.json` |
| Tests | vitest + Playwright (browser) | `vitest.config.ts`, `apps/web/vitest.browser.config.ts` |
| Pre-commit hooks | **None** (no husky/lefthook) | — |
| Coverage / Codecov | **None** | — |
| `.editorconfig` / `.nvmrc` | **None** (mise + engines replace them) | — |
| Line-ending policy | LF enforced via gitattributes | `.gitattributes` |
| CI | Single workflow, single Linux runner, `bun run fmt:check && lint && typecheck && test && build` | `.github/workflows/ci.yml` |
| VSCode | One extension recommendation (oxc), format-on-save | `.vscode/{settings,extensions}.json` |

Notable: t3code's CI runs on **`blacksmith-8vcpu-ubuntu-2404`** (Blacksmith.sh, GitHub Actions drop-in, faster than `ubuntu-latest`). Single OS — no matrix. They rely on the release workflow (Agent 1's territory) for cross-platform builds, not on PR CI.

## Exact configs to copy / adapt

**`.gitattributes`** (copy verbatim — critical for Windows contributors once formatters are added):
```
* text=auto eol=lf
```

**`.mise.toml`** (replaces `.nvmrc`/`.node-version`; works alongside `rustup`):
```toml
[tools]
node = "20.11.1"
rust = "1.82.0"
```

**`tsconfig.base.json` strict block** (Terminal 64's current `tsconfig.json` should adopt these — `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` will surface real bugs):
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  }
}
```

**`Cargo.toml` `[lints]` section** (t3code has none — Terminal 64 should invent this):
```toml
[lints.rust]
unsafe_code = "warn"
unused_must_use = "deny"

[lints.clippy]
all = { level = "warn", priority = -1 }
unwrap_used = "warn"
expect_used = "warn"
todo = "warn"
```

**`.vscode/extensions.json`** (Tauri-flavoured equivalent of t3code's pattern):
```json
{ "recommendations": ["tauri-apps.tauri-vscode", "rust-lang.rust-analyzer", "biomejs.biome"] }
```

## Recommended minimum CI for Terminal 64

t3code's single-runner approach **is wrong for a Tauri app** — the entire point of the cross-OS matrix is to catch platform-specific Rust/PTY/audio breakage before release. Terminal 64 should run a 3-OS matrix on every PR.

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
  push:
    branches: [master]

jobs:
  frontend:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npx tsc --noEmit
      # add when lint/format chosen: - run: npm run lint && npm run fmt:check

  rust:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { components: rustfmt, clippy }
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: 'src-tauri -> target' }
      - if: matrix.os == 'ubuntu-latest'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev
      - run: cargo fmt --manifest-path src-tauri/Cargo.toml --check
      - run: cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
      - run: cargo check --manifest-path src-tauri/Cargo.toml --all-targets

  build:
    needs: [frontend, rust]
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: 'src-tauri -> target' }
      - if: matrix.os == 'ubuntu-latest'
        run: sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev
      - run: npm ci
      - run: npm run tauri build -- --ci
```

Split frontend/rust/build so a TS error doesn't burn 45 min of macOS minutes.

## Adopt vs skip (solo-dev calibration)

**Adopt now** (cheap, high-value):
- `.gitattributes` LF enforcement
- `tsconfig` strict flags (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- `Cargo.toml` `[lints]` block + `cargo fmt --check` + `cargo clippy -D warnings` in CI
- 3-OS Tauri build matrix on PRs (the one place to NOT copy t3code)
- `Swatinem/rust-cache@v2` (mandatory — Rust builds otherwise destroy CI minutes)
- `.vscode/extensions.json` recommendations
- `npm run typecheck` script wrapping `tsc --noEmit`
- `engines` field in `package.json` pinning Node version

**Adopt later** (worth it once codebase stabilises):
- oxlint (faster than ESLint, zero-config) OR Biome (handles format + lint in one tool — probably the better single-tool pick for solo dev)
- vitest with `--passWithNoTests` so CI doesn't fail before tests exist
- `.mise.toml` once a second contributor appears

**Skip** (overhead > value for solo dev):
- husky / lefthook / pre-commit — rely on CI + editor format-on-save instead. t3code skips these for the same reason.
- Codecov / coverage badges — no tests yet to cover; meaningless number.
- `.editorconfig` — redundant with formatter + `.gitattributes`.
- Separate Prettier config — pick one of Biome/oxfmt, don't stack formatters.
- t3code's `release_smoke` job — overkill until release pipeline exists.
- Required status checks on master — solo dev, just review your own PRs.

## Apply to Terminal 64 — punch list

1. Add `.gitattributes` with `* text=auto eol=lf`.
2. Tighten `tsconfig.json` with the 4 strict flags above; fix the resulting errors as a separate pass.
3. Add `[lints]` block to `src-tauri/Cargo.toml`.
4. Create `.github/workflows/ci.yml` from the template above.
5. Add `typecheck`, `lint`, `fmt:check` scripts to `package.json` (even as no-ops initially) so CI commands stay stable when tooling changes.
6. Pick one JS tool: **Biome** recommended (single binary, handles fmt + lint, no config explosion) — defer oxlint/oxfmt unless you specifically want t3code parity.
7. Add `.vscode/extensions.json` so contributors get rust-analyzer + Tauri extension on first open.
