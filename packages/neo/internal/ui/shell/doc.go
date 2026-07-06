// Package shell assembles the neo interactive TUI's app shell: the startup
// welcome card, the input footer (model/cwd/mode + token/context HUD + hints),
// the status-indicator stack with retry/compaction countdowns, the extension
// widget areas above/below the editor, the pending/queued-messages area, the
// terminal-title updater, and the notification/system-bell policy.
//
// Every visual surface is styled ONLY through internal/theme (no approximated
// colors) and every reflow (120x36 large bordered logo card → 80x24 compact
// centered text + version bottom-right) mirrors the grok build captures in
// .omo/research/neo-grok/captures. The components are pure state holders that
// emit []string lines for a given width; the bubbletea Model that drives them
// (ticks, resize, focus) lands when the app assembles in a later integration
// step. Ports:
//
//   - Welcome:   the grok welcome card structure + reflow (both capture sizes).
//   - Footer:    coding-agent interactive components/footer.ts.
//   - Status:    components/status-indicator.ts + countdown-timer.ts.
//   - Queue:     interactive-mode.ts steering/follow-up queue + display.
//   - Title:     tui/terminal.ts setTitle (OSC 0, control-char stripped).
//   - Notify:    interactive-mode.ts showExtensionNotify + system-bell policy.
package shell
