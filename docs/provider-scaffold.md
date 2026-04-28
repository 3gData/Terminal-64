# Provider Scaffold Guide

Terminal 64 providers are split across frontend manifests/runtimes, frontend
event decoding, provider-owned session metadata, backend adapters, and
verification fixtures. Use the scaffold script to create provider-owned stubs
first, then coordinate the shared registry edits in the MCP team chat.

## Generate A Scaffold

Dry run:

```bash
node scripts/scaffold-provider.mjs opencode --label OpenCode
```

Write files:

```bash
node scripts/scaffold-provider.mjs opencode --label OpenCode --write
```

The script creates:

- `src/lib/providerRuntimes/<provider>.ts`
- `src/lib/<provider>EventDecoder.ts`
- `src-tauri/src/providers/<provider>.rs`
- `docs/provider-scaffolds/<provider>.md`

It does not rewrite shared files automatically. The generated checklist
contains snippets for `src/lib/providers.ts`, `src/lib/providerRuntime.ts`,
`src/lib/providerEventIngestion.ts`, `src/stores/claudeStore.ts`,
`src-tauri/src/providers/mod.rs`, `src-tauri/src/providers/traits.rs`,
`src-tauri/src/lib.rs`, and `src/lib/providerModularity.verification.ts`.

## Shared Edit Order

1. Add the provider id and manifest entry in `src/lib/providers.ts`.
2. Register the frontend runtime in `src/lib/providerRuntime.ts`.
3. Add provider IPC request map augmentation in the runtime stub.
4. Wire the decoder in `src/lib/providerEventIngestion.ts`, preferably through
   the shared backend `provider-event` envelope.
5. Add provider-owned metadata under `ProviderSessionMetadataRegistry`.
6. Register the backend adapter and `ProviderKind`.
7. Extend `src/lib/providerModularity.verification.ts` so `tsc --noEmit`
   proves the new provider has manifest/runtime/IPC/metadata coverage.

Keep history capabilities disabled until both the frontend runtime and backend
adapter implement hydrate/fork/rewind/delete. Generic history IPC returns
structured `unsupported` results, so a new provider can start with create/send
without weakening Claude or Codex behavior.

## Provider Ownership Rules

- UI labels, model options, effort options, permissions, feature gates, and
  delegation policy belong in the provider manifest.
- Create/send request shaping belongs in `src/lib/providerRuntimes/<provider>.ts`.
- Raw provider event drift belongs in `src/lib/<provider>EventDecoder.ts`;
  backend providers should emit the shared `provider-event` envelope and keep
  per-provider legacy topics only as a compatibility fallback.
- Provider session details belong under
  `providerState.providerMetadata[provider]`.
- Backend CLI/process details belong in `src-tauri/src/providers/<provider>.rs`.
- Shared files should contain registration and routing only.

## Verification

Run the lightweight checks after applying the shared snippets:

```bash
npm run typecheck
npm run build
cd src-tauri && cargo fmt && cargo check
```

Run Clippy before a PR when the backend adapter has real process code:

```bash
cd src-tauri && cargo clippy --all-targets -- -D warnings
```
