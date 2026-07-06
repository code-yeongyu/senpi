package clipboard

// tools.go holds the per-OS tool-selection matrix. Each selector probes the
// runner's lookPath for candidate tools in priority order and returns the
// command + args to run, or ok=false when none are present. Keeping selection
// separate from execution lets the tests drive the whole matrix with a fake
// runner that only reports which tools "exist".

// firstPresent returns the first candidate whose binary resolves, in order.
func (a *Adapter) firstPresent(names ...string) (string, bool) {
	for _, n := range names {
		if _, err := a.run.lookPath(n); err == nil {
			return n, true
		}
	}
	return "", false
}

// textReadTool selects the command that prints clipboard text to stdout.
func (a *Adapter) textReadTool() (name string, args []string, ok bool) {
	switch a.os {
	case "darwin":
		if n, present := a.firstPresent("pbpaste"); present {
			return n, nil, true
		}
	case "windows":
		if n, present := a.firstPresent("powershell", "powershell.exe", "pwsh"); present {
			return n, []string{"-NoProfile", "-Command", "Get-Clipboard"}, true
		}
	default: // linux and other unix
		if n, present := a.firstPresent("wl-paste"); present {
			return n, []string{"--no-newline"}, true
		}
		if n, present := a.firstPresent("xclip"); present {
			return n, []string{"-selection", "clipboard", "-o"}, true
		}
		if n, present := a.firstPresent("xsel"); present {
			return n, []string{"--clipboard", "--output"}, true
		}
	}
	return "", nil, false
}

// textWriteTool selects the command that reads stdin into the clipboard.
func (a *Adapter) textWriteTool() (name string, args []string, ok bool) {
	switch a.os {
	case "darwin":
		if n, present := a.firstPresent("pbcopy"); present {
			return n, nil, true
		}
	case "windows":
		if n, present := a.firstPresent("clip", "clip.exe"); present {
			return n, nil, true
		}
	default:
		if n, present := a.firstPresent("wl-copy"); present {
			return n, nil, true
		}
		if n, present := a.firstPresent("xclip"); present {
			return n, []string{"-selection", "clipboard"}, true
		}
		if n, present := a.firstPresent("xsel"); present {
			return n, []string{"--clipboard", "--input"}, true
		}
	}
	return "", nil, false
}

// imageReadTool selects the command that emits raw image bytes to stdout.
func (a *Adapter) imageReadTool() (name string, args []string, ok bool) {
	switch a.os {
	case "darwin":
		// osascript reads the clipboard PNG. Because AppleScript cannot stream
		// binary to stdout, the production runner special-cases this command: it
		// writes the PNG to a temp file (via the osascript image script) and
		// returns the file's bytes. Tests inject their own runner, so they see
		// this as a plain osascript invocation returning scripted bytes.
		if n, present := a.firstPresent("osascript"); present {
			return n, osascriptImageArgs(), true
		}
	case "windows":
		if n, present := a.firstPresent("powershell", "powershell.exe", "pwsh"); present {
			return n, []string{"-NoProfile", "-Command", powershellImageScript()}, true
		}
	default:
		if n, present := a.firstPresent("wl-paste"); present {
			return n, []string{"--type", "image/png"}, true
		}
		if n, present := a.firstPresent("xclip"); present {
			return n, []string{"-selection", "clipboard", "-t", "image/png", "-o"}, true
		}
	}
	return "", nil, false
}
