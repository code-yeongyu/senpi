package app

import (
	// glamour (transcript markdown, todo 3) and bubbles/spinner (shell status
	// spinner, todo 7) are pinned charm deps that no wired neo package imports
	// yet. Keep them blank-imported so `go mod tidy` retains their versions until
	// those todos consume them for real; every other charm dep is now imported by
	// live code (bubbletea here, lipgloss/ansi/uniseg in internal/ui + theme).
	_ "charm.land/bubbles/v2/spinner"
	_ "charm.land/glamour/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/shell"
)

// Deps carries the collaborators the app Model composes into its frame. This
// todo's Deps hold only the presentational + input pieces the skeleton needs;
// the bridge session adapter, store, and recovery wiring attach in later todos.
type Deps struct {
	// Theme is the resolved neo skin every region renders through.
	Theme *theme.Theme
	// Keys is the keybinding manager. EVERY app-level chord (exit, interrupt,
	// hints) resolves through it — the Model never compares raw key bytes itself.
	Keys *keybindings.Manager
	// AppName is the welcome-card app label + terminal title (e.g. "senpi").
	AppName string
	// Welcome is the startup welcome content. When zero-valued the Model fills in
	// a default card titled with AppName.
	Welcome shell.WelcomeContent
}
