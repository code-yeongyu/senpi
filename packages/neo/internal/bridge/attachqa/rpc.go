package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
)

// attachResult bundles a DaemonConn with its live Client for a scenario.
type attachResult struct {
	conn   *bridge.DaemonConn
	client *bridge.Client
}

// Path exposes the attach path for logging.
func (a attachResult) Path() bridge.AttachPath { return a.conn.Path }

// Record exposes the attached registry record (socket + pid + token).
func (a attachResult) Record() bridge.NeoDaemonRecord { return a.conn.Record }

// Conn exposes the raw DaemonConn (for Session construction / transport drop).
func (a attachResult) Conn() *bridge.DaemonConn { return a.conn }

// Close closes the client + connection (never kills the daemon).
func (a attachResult) Close() {
	if a.client != nil {
		_ = a.client.Close()
	}
}

// attach runs the Go attach-or-spawn client with the given neo argv and returns a
// live client wrapped in an attachResult, plus an ok flag.
func (h *harnessEnv) attach(argv []string) (attachResult, bool) {
	opts, _ := bridge.ParseNeoRuntimeArgv(argv)
	conn, err := bridge.AttachOrSpawn(bridge.AttachConfig{
		AgentDir:       h.agentDir,
		Cwd:            h.cwd,
		Capabilities:   []string{"custom_unsupported"},
		RuntimeOptions: opts,
		Timeout:        attachTimeout,
	})
	if err != nil {
		fmt.Printf("ATTACH FAILED argv=%v err=%v\n", argv, err)
		return attachResult{}, false
	}
	return attachResult{conn: conn, client: bridge.NewClient(conn.Transport)}, true
}

// getState issues get_state and decodes the session state.
func (h *harnessEnv) getState(a attachResult) bridge.RPCSessionState {
	resp, err := a.client.Request(bridge.Command{Type: "get_state"}, 15*time.Second)
	if err != nil || !resp.Success {
		fmt.Printf("get_state failed: %v success=%v\n", err, resp.Success)
		return bridge.RPCSessionState{}
	}
	var state bridge.RPCSessionState
	_ = json.Unmarshal(resp.Data, &state)
	return state
}

// getCommands issues get_commands and returns the command names.
func (h *harnessEnv) getCommands(a attachResult) []string {
	resp, err := a.client.Request(bridge.Command{Type: "get_commands"}, 15*time.Second)
	if err != nil || !resp.Success {
		fmt.Printf("get_commands failed: %v success=%v\n", err, resp.Success)
		return nil
	}
	var data struct {
		Commands []bridge.RPCSlashCommand `json:"commands"`
	}
	_ = json.Unmarshal(resp.Data, &data)
	names := make([]string, 0, len(data.Commands))
	for _, c := range data.Commands {
		names = append(names, c.Name)
	}
	return names
}

// prompt fires a prompt turn (async; the worker talks to the fake server).
func (h *harnessEnv) prompt(a attachResult, message string) {
	_, err := a.client.Request(
		bridge.Command{Type: "prompt", Fields: map[string]any{"message": message}},
		15*time.Second,
	)
	if err != nil {
		fmt.Printf("prompt failed: %v\n", err)
	}
}
