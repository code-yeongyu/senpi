// Package store provides native Go readers for the on-disk ~/.senpi agent
// directory, mirroring the classic senpi TypeScript loaders exactly so neo and
// classic senpi agree about configuration:
//
//   - agent-dir resolution and path helpers (config.ts:494-561),
//   - settings load with global+project merge (settings-manager.ts:93-210),
//   - a lockfile-replicating settings writer that persists neo's skin under a
//     separate neo.theme key without ever overwriting the whole file or the
//     classic theme key (settings-manager.ts:240-268,592-621),
//   - keybindings.json overrides (keybindings.ts:288-301),
//   - a sessions scanner producing picker-sufficient info (session-manager.ts),
//   - models.json and auth.json readers (auth exposes provider->type only,
//     never key material), and custom-theme listing.
//
// Later tasks layer the client-side UI state (transcript, queue, clipboard)
// on top of these readers.
package store
