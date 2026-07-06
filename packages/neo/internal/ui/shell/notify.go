package shell

// NotifyLevel is the extension-notify severity, mirroring the
// info/warning/error union of ctx.ui.notify (interactive-mode
// showExtensionNotify).
type NotifyLevel int

const (
	// NotifyInfo routes to the status line (showStatus).
	NotifyInfo NotifyLevel = iota
	// NotifyWarning routes to the warning presentation (showWarning).
	NotifyWarning
	// NotifyError routes to the error presentation (showError).
	NotifyError
)

// RouteNotify maps an extension-notify level to the neo presentation channel.
// This mirrors interactive-mode.ts showExtensionNotify exactly: error → error
// channel, warning → warning channel, everything else → status/info channel.
// (undefined type ⇒ info is the default because the zero value is NotifyInfo.)
func RouteNotify(level NotifyLevel) NotifyLevel {
	switch level {
	case NotifyError:
		return NotifyError
	case NotifyWarning:
		return NotifyWarning
	default:
		return NotifyInfo
	}
}

// BellSequence returns the terminal bell (BEL, \x07) when the system-bell
// policy is enabled, else the empty string. The policy comes from settings
// (the shell reads it once and passes the resolved bool); neo never rings the
// bell when the user has disabled it.
func BellSequence(enabled bool) string {
	if enabled {
		return "\x07"
	}
	return ""
}
