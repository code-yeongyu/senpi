# packages/web-ui

`@earendil-works/pi-web-ui` provides browser-only Lit components, storage abstractions, tools, and sandboxed artifact rendering. It is not bundled into the Senpi CLI.

## STRUCTURE

```text
src/ChatPanel.ts            Top-level `pi-chat-panel` component
src/components/             Messages, input, sandbox, render registries
src/dialogs/                Settings, sessions, models, providers, storage dialogs
src/storage/app-storage.ts  Storage facade with injected backend
src/storage/backends/       Backend implementations
src/storage/stores/         Domain stores
src/tools/                  Browser tools and artifact renderers
src/app.css                 Tailwind v4 source, built to dist/app.css
example/                    Standalone consumer that selects IndexedDB
```

## WHERE TO LOOK

| Task | Path |
|---|---|
| Top-level chat behavior | `src/ChatPanel.ts` |
| Message rendering | `src/components/message-renderer-registry.ts` |
| Artifact iframe behavior | `src/components/SandboxedIframe.ts` and sandbox helpers |
| Storage contract | `src/storage/app-storage.ts` and `src/storage/types.ts` |
| Browser tool | `src/tools/` |
| Styling | `src/app.css` |

## INVARIANTS

- Components use Lit legacy decorators compiled by `tsc`; do not switch this package to tsgo.
- The public top-level tag is `pi-chat-panel`.
- `AppStorage` accepts an injected backend. The example chooses IndexedDB; the core facade must not hardwire it.
- Iframe artifacts use `allow-scripts` and `allow-modals` sandbox tokens; web/srcdoc mode has no package-provided CSP. Direct handlers check `event.source`, but the shared router accepts ambient messages by registered sandbox ID without sender authentication or typed schema validation. Treat router input as untrusted unless source-bound and parsed.
- Package imports remain browser-only. Do not import Node modules into component, storage, or tool entry points.
- The build is TypeScript emit plus Tailwind CSS generation; do not claim bundling or tree-shaking occurs here.
- Edit `src/app.css`, never generated `dist/app.css`.

## ANTI-PATTERNS

- Running the repository-forbidden development command.
- Treating the standalone `example/` project as a root workspace.
- Coupling storage consumers directly to IndexedDB.
- Weakening iframe sandbox tokens or widening ambient `postMessage` routing.
- Hardcoding credentials in browser state or source.

## VALIDATION

- This package has no test script or in-tree tests. Run `npm run check` from this package for static validation.
- Storage, iframe, and message-routing changes require focused browser QA in the example consumer.
- Root `npm run check` covers the package integration; save visual/browser evidence for user-facing changes.
