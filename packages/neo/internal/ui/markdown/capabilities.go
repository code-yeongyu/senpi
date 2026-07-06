package markdown

import "sync"

// Capabilities mirrors the subset of pi's TerminalCapabilities the markdown
// renderer consumes. Images is the protocol name ("kitty"/"iterm2") or "" when
// unsupported; Hyperlinks enables OSC 8 link emission.
type Capabilities struct {
	Images     string
	TrueColor  bool
	Hyperlinks bool
}

var (
	capMu       sync.RWMutex
	capOverride *Capabilities
)

// SetCapabilities forces a capability set (test hook, mirrors pi setCapabilities).
func SetCapabilities(c Capabilities) {
	capMu.Lock()
	defer capMu.Unlock()
	cp := c
	capOverride = &cp
}

// ResetCapabilities clears any forced capabilities so detection applies again.
func ResetCapabilities() {
	capMu.Lock()
	defer capMu.Unlock()
	capOverride = nil
}

// GetCapabilities returns the active capability set. When unset, hyperlinks are
// off by default (the conservative, deterministic path used by tests).
func GetCapabilities() Capabilities {
	capMu.RLock()
	defer capMu.RUnlock()
	if capOverride != nil {
		return *capOverride
	}
	return Capabilities{}
}
