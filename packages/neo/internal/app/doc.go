// Package app is the neo TUI's root bubbletea model: it wires the bridge,
// store, theme, and ui packages together, dispatches keybinding actions, and
// owns the top-level update/view loop. The concrete implementation lands in a
// later task; this file establishes the package so the module builds and
// tests as a whole.
package app
