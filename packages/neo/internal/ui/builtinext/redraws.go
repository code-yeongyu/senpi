package builtinext

import "sync/atomic"

// RedrawCounter backs the neo equivalent of tui.fullRedraws. The TUI increments
// it once per full-screen redraw; the /tui command reads the total. It is
// goroutine-safe because a bubbletea program and its render loop may touch it
// from different goroutines.
type RedrawCounter struct {
	count int64
}

// RecordFullRedraw increments the full-redraw counter.
func (c *RedrawCounter) RecordFullRedraw() { atomic.AddInt64(&c.count, 1) }

// FullRedraws returns the current full-redraw total.
func (c *RedrawCounter) FullRedraws() int { return int(atomic.LoadInt64(&c.count)) }

// RedrawsNotice mirrors redraws.ts:21 — the /tui command's notification:
// `TUI full redraws: <n>` at the "info" level. Returned as (message, level) so
// the app shell can route it through its notify path.
func RedrawsNotice(count int) (message, level string) {
	return "TUI full redraws: " + itoa(count), "info"
}
