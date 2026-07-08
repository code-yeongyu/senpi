package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
)

// neoFavoritesKey is the additive, neo-namespaced settings key the favorites
// editor persists its set under (never the classic key — additive-only guardrail).
const neoFavoritesKey = "neo.favoriteModels"

// FileOpResultMsg is the advisory outcome of a native store file-op. The route
// step surfaces Notice (or Err) as a one-line transcript notice; a successful
// no-notice op is silent.
type FileOpResultMsg struct {
	Op     string
	Err    error
	Notice string
}

// SessionsScannedMsg carries a native session scan back to the Update loop, where
// the session picker overlay is built and pushed.
type SessionsScannedMsg struct {
	Sessions []store.SessionInfo
	Err      error
}

// overlayRequester is the overlay manager's command issuer. RPC commands the
// daemon understands go through the live session; the file-ops and the daemon-less
// `trust` outcome are performed natively via internal/store (never sent to the
// bridge — the RPC protocol has no trust command).
type overlayRequester struct {
	ref      *clientRef
	agentDir string
	cwd      string
}

var _ Requester = (*overlayRequester)(nil)

// Request issues an overlay Outcome command. `trust` is intercepted and written
// natively (no RPC trust command exists); every other command is a real RPC.
func (r *overlayRequester) Request(cmd bridge.Command) tea.Cmd {
	if cmd.Type == "trust" {
		return r.trustWrite(cmd.Fields)
	}
	return call(r.ref, func(s *Session) tea.Cmd { return s.Request(cmd) })
}

// FileOp performs a native store operation off the Update goroutine.
func (r *overlayRequester) FileOp(op string, fields map[string]any) tea.Cmd {
	switch op {
	case "write_settings":
		return r.writeSettings(fields)
	case "save_favorites":
		return r.saveFavorites(fields)
	case "scan_sessions":
		return r.scanSessions()
	case "delete_session":
		return r.deleteSession(fields)
	default:
		// edit_label and any future native op with no settled store schema degrade
		// to an honest notice rather than an invented (and wrong) write.
		return fileOpNotice(op, "this action is not available in the Go TUI yet")
	}
}

// writeSettings merges a single key into the global settings.json under the store
// lockfile protocol (classic-writer-safe), never overwriting the whole file.
func (r *overlayRequester) writeSettings(fields map[string]any) tea.Cmd {
	key, _ := fields["key"].(string)
	value := fields["value"]
	agentDir := r.agentDir
	return func() tea.Msg {
		if key == "" {
			return FileOpResultMsg{Op: "write_settings", Err: fmt.Errorf("write_settings: missing key")}
		}
		if err := writeSettingKey(agentDir, key, value); err != nil {
			return FileOpResultMsg{Op: "write_settings", Err: err, Notice: "settings save failed: " + err.Error()}
		}
		return FileOpResultMsg{Op: "write_settings", Notice: "settings saved"}
	}
}

// saveFavorites persists the favorite model set under the neo-namespaced key.
func (r *overlayRequester) saveFavorites(fields map[string]any) tea.Cmd {
	agentDir := r.agentDir
	payload := map[string]any{"ids": fields["ids"], "all": fields["all"]}
	return func() tea.Msg {
		if err := writeSettingKey(agentDir, neoFavoritesKey, payload); err != nil {
			return FileOpResultMsg{Op: "save_favorites", Err: err, Notice: "favorites save failed: " + err.Error()}
		}
		return FileOpResultMsg{Op: "save_favorites", Notice: "favorites saved"}
	}
}

// scanSessions lists picker info for the cwd's sessions directory natively.
func (r *overlayRequester) scanSessions() tea.Cmd {
	agentDir, cwd := r.agentDir, r.cwd
	return func() tea.Msg {
		sessions, err := store.ScanSessions(agentDir, cwd)
		return SessionsScannedMsg{Sessions: sessions, Err: err}
	}
}

// deleteSession removes a session file natively (classic delete parity).
func (r *overlayRequester) deleteSession(fields map[string]any) tea.Cmd {
	path, _ := fields["path"].(string)
	return func() tea.Msg {
		if path == "" {
			return FileOpResultMsg{Op: "delete_session", Err: fmt.Errorf("delete_session: missing path")}
		}
		if err := os.Remove(path); err != nil {
			return FileOpResultMsg{Op: "delete_session", Err: err, Notice: "delete failed: " + err.Error()}
		}
		return FileOpResultMsg{Op: "delete_session", Notice: "session deleted"}
	}
}

// trustWrite records the project trust decision natively. The store package
// exposes no trust API, so the decision is written under the neo-namespaced
// settings key keyed by the cwd — additive, classic-writer-safe, and never sent
// to the bridge (there is no RPC trust command).
func (r *overlayRequester) trustWrite(fields map[string]any) tea.Cmd {
	trusted, _ := fields["trusted"].(bool)
	agentDir, cwd := r.agentDir, r.cwd
	return func() tea.Msg {
		if err := writeTrustDecision(agentDir, cwd, trusted); err != nil {
			return FileOpResultMsg{Op: "trust", Err: err, Notice: "trust save failed: " + err.Error()}
		}
		state := "trusted"
		if !trusted {
			state = "untrusted"
		}
		return FileOpResultMsg{Op: "trust", Notice: "project marked " + state}
	}
}

// writeSettingKey merges one key into the global settings.json under the store
// lockfile, preserving every other key (mirrors store.WriteNeoTheme, generalized).
func writeSettingKey(agentDir, key string, value any) error {
	path := filepath.Join(agentDir, "settings.json")
	return store.WithSettingsLock(path, func(current string) (string, error) {
		merged := map[string]any{}
		if t := strings.TrimSpace(current); t != "" {
			if err := json.Unmarshal([]byte(t), &merged); err != nil {
				return "", err
			}
		}
		merged[key] = value
		out, err := json.MarshalIndent(merged, "", "  ")
		if err != nil {
			return "", err
		}
		return string(out), nil
	})
}

// writeTrustDecision records cwd -> trusted under the neo trust settings key.
func writeTrustDecision(agentDir, cwd string, trusted bool) error {
	path := filepath.Join(agentDir, "settings.json")
	return store.WithSettingsLock(path, func(current string) (string, error) {
		merged := map[string]any{}
		if t := strings.TrimSpace(current); t != "" {
			if err := json.Unmarshal([]byte(t), &merged); err != nil {
				return "", err
			}
		}
		trust, _ := merged["neo.projectTrust"].(map[string]any)
		if trust == nil {
			trust = map[string]any{}
		}
		trust[cwd] = trusted
		merged["neo.projectTrust"] = trust
		out, err := json.MarshalIndent(merged, "", "  ")
		if err != nil {
			return "", err
		}
		return string(out), nil
	})
}

// fileOpNotice builds a one-shot advisory FileOpResultMsg command.
func fileOpNotice(op, notice string) tea.Cmd {
	return func() tea.Msg { return FileOpResultMsg{Op: op, Notice: notice} }
}
