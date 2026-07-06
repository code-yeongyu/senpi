package app

// This file anchors the charm TUI stack and supporting libraries as direct
// module dependencies so their pinned versions are retained by `go mod tidy`
// before the packages that use them in earnest land in later tasks. The
// blank imports are load-bearing: they are the app's real runtime deps
// (bubbletea program, bubbles widgets, lipgloss styling, glamour markdown,
// ansi/uniseg text handling) and go-winio for Windows named-pipe transport.
import (
	_ "charm.land/bubbles/v2/spinner"
	_ "charm.land/bubbletea/v2"
	_ "charm.land/glamour/v2"
	_ "charm.land/lipgloss/v2"
	_ "github.com/charmbracelet/x/ansi"
	_ "github.com/rivo/uniseg"
)
