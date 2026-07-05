// Package store holds the neo TUI's client-side state: session snapshot,
// transcript entries, queued messages, keybinding registry, and the
// shell-out clipboard adapter. The concrete implementation lands in later
// tasks; this file establishes the package so the module builds and tests as
// a whole.
package store
