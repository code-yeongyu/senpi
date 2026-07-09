package bridge

import "encoding/json"

// This file mirrors the TypeScript RPC protocol
// (packages/coding-agent/src/modes/rpc/rpc-types.ts) and the event union
// (packages/coding-agent/src/core/agent-session.ts AgentSessionEvent, which
// extends packages/agent's AgentEvent) plus the extension_error line emitted by
// rpc-mode.ts. The exhaustiveness test parses those TS sources at runtime and
// asserts a Go variant exists for every union member here — so the registries
// below are the mirror surface, not a hand-maintained convenience.
//
// Wire fidelity: decode/encode preserves the original JSON bytes (see codec.go)
// so round-trips are byte-equal. The typed fields here are the accessors the TUI
// needs; the raw bytes carry everything else verbatim.

// ThinkingLevel mirrors the TS ThinkingLevel string union.
type ThinkingLevel string

// QueueMode mirrors the steeringMode / followUpMode "all" | "one-at-a-time"
// unions.
type QueueMode string

// ---------------------------------------------------------------------------
// Commands (stdin) — RpcCommand
// ---------------------------------------------------------------------------

// Command is the minimal typed shape a caller uses to issue an RpcCommand. The
// transport injects the id (req_N). Command-specific payload fields are carried
// in Fields, which is merged into the wire object so every RpcCommand variant is
// expressible without a struct per variant.
type Command struct {
	Fields map[string]any
	Type   string
}

// commandTypes is the closed set of RpcCommand.type discriminants mirrored from
// rpc-types.ts. Verified exhaustive by TestExhaustiveCommands against the TS
// parse.
var commandTypes = []string{
	// Prompting
	"prompt", "steer", "follow_up", "abort", "new_session",
	// State
	"get_state",
	// Model
	"set_model", "cycle_model", "get_available_models",
	// Thinking
	"set_thinking_level", "cycle_thinking_level",
	// Queue modes
	"set_steering_mode", "set_follow_up_mode",
	// Compaction
	"compact", "set_auto_compaction",
	// Retry
	"set_auto_retry", "abort_retry",
	// Bash
	"bash", "abort_bash",
	// Session
	"get_session_stats", "export_html", "switch_session", "fork", "clone",
	"get_fork_messages", "get_entries", "get_tree", "get_last_assistant_text",
	"set_session_name",
	// Messages
	"get_messages",
	// Commands
	"get_commands",
	// Auth (task 13): login/logout is additive. get_auth_providers, login_api_key
	// and logout answer synchronously; login_start responds immediately and the
	// URL + result arrive as auth_login_url / auth_login_end events.
	"get_auth_providers", "login_start", "login_cancel", "login_api_key", "logout",
}

// KnownCommandTypes returns the mirrored RpcCommand.type set as a lookup.
func KnownCommandTypes() map[string]bool { return toSet(commandTypes) }

// ---------------------------------------------------------------------------
// Responses (stdout) — RpcResponse
// ---------------------------------------------------------------------------

// Response is a decoded RpcResponse line. Data carries the command-specific
// success payload verbatim; Error is set when Success is false. Obtain one from
// a Message via Message.AsResponse.
type Response struct {
	ID      string          `json:"id,omitempty"`
	Type    string          `json:"type"`
	Command string          `json:"command"`
	Error   string          `json:"error,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
	Success bool            `json:"success"`
}

// responseCommands mirrors the RpcResponse.command literals. The error variant
// uses `command: string` (any command may fail) and is handled by Success=false.
var responseCommands = commandTypes // 1:1 with commands (verified by TS parse)

// KnownResponseCommands returns the mirrored RpcResponse.command set.
func KnownResponseCommands() map[string]bool { return toSet(responseCommands) }

// ---------------------------------------------------------------------------
// Session state — RPCSessionState
// ---------------------------------------------------------------------------

// RPCSessionState mirrors rpc-types.ts RPCSessionState (get_state response data).
type RPCSessionState struct {
	ThinkingLevel         ThinkingLevel   `json:"thinkingLevel"`
	SteeringMode          QueueMode       `json:"steeringMode"`
	FollowUpMode          QueueMode       `json:"followUpMode"`
	SessionFile           string          `json:"sessionFile,omitempty"`
	SessionID             string          `json:"sessionId"`
	SessionName           string          `json:"sessionName,omitempty"`
	Model                 json.RawMessage `json:"model,omitempty"`
	MessageCount          int             `json:"messageCount"`
	PendingMessageCount   int             `json:"pendingMessageCount"`
	IsStreaming           bool            `json:"isStreaming"`
	IsCompacting          bool            `json:"isCompacting"`
	AutoCompactionEnabled bool            `json:"autoCompactionEnabled"`
}

// AuthProvider mirrors rpc-types.ts RpcAuthProvider (get_auth_providers data
// item): one provider row for the /login and /logout selectors.
type AuthProvider struct {
	ID       string     `json:"id"`
	Name     string     `json:"name"`
	AuthType string     `json:"authType"`
	Status   AuthStatus `json:"status"`
}

// AuthStatus mirrors rpc-types.ts RpcAuthStatus: provider auth status without any
// credential value (from getProviderAuthStatus).
type AuthStatus struct {
	Source     string `json:"source,omitempty"`
	Label      string `json:"label,omitempty"`
	Configured bool   `json:"configured"`
}

// RPCSlashCommand mirrors rpc-types.ts RPCSlashCommand (get_commands data item).
type RPCSlashCommand struct {
	Name        string     `json:"name"`
	Description string     `json:"description,omitempty"`
	Source      string     `json:"source"`
	SourceInfo  SourceInfo `json:"sourceInfo"`
}

// SourceInfo mirrors packages/coding-agent/src/core/source-info.ts SourceInfo.
type SourceInfo struct {
	Path    string `json:"path"`
	Source  string `json:"source"`
	Scope   string `json:"scope"`
	Origin  string `json:"origin"`
	BaseDir string `json:"baseDir,omitempty"`
}

// ---------------------------------------------------------------------------
// Extension UI (stdout request / stdin response)
// ---------------------------------------------------------------------------

// ExtensionUIRequest is a decoded extension_ui_request line. Method selects the
// variant; per-method fields are carried in Fields verbatim. Obtain one from a
// Message via Message.AsExtensionUIRequest.
type ExtensionUIRequest struct {
	Fields map[string]any `json:"-"`
	Type   string         `json:"type"`
	ID     string         `json:"id"`
	Method string         `json:"method"`
}

// extensionUIMethods mirrors the RpcExtensionUIRequest.method literals: the 9
// renderable-inline methods plus the additive custom_unsupported notice (task
// 13/14), which a capability-flagged client sees before ctx.ui.custom returns
// undefined.
var extensionUIMethods = []string{
	"select", "confirm", "input", "editor", "notify",
	"setStatus", "setWidget", "setTitle", "set_editor_text",
	"custom_unsupported",
}

// KnownExtensionUIMethods returns the mirrored extension-UI method set.
func KnownExtensionUIMethods() map[string]bool { return toSet(extensionUIMethods) }

// ExtensionUIResponse models the three RpcExtensionUIResponse variants sent back
// on stdin: a value reply, a confirm reply (Confirmed), or a cancellation.
type ExtensionUIResponse struct {
	Confirmed *bool  `json:"confirmed,omitempty"`
	Type      string `json:"type"`
	ID        string `json:"id"`
	Value     string `json:"value,omitempty"`
	Cancelled bool   `json:"cancelled,omitempty"`
}

// ---------------------------------------------------------------------------
// Events (stdout) — AgentSessionEvent (extends AgentEvent) + extension_error
// ---------------------------------------------------------------------------

// Event is a decoded event line. Type is the discriminant; the full payload is
// carried in Payload (raw JSON) for typed decoding on demand. Obtain one from a
// Message via Message.AsEvent.
type Event struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"-"`
}

// eventTypes mirrors the AgentSessionEvent union: base AgentEvent (10 variants)
// + session extensions + tool_hook_status + system_prompt_change, plus
// extension_error (emitted by rpc-mode.ts, classified by the demux as a distinct
// top-level shape but part of the stream the client observes). Verified
// exhaustive by TestExhaustiveEvents against the TS parse of BOTH
// agent-session.ts and packages/agent types.ts.
var eventTypes = []string{
	// --- base AgentEvent (packages/agent/src/types.ts) ---
	"agent_start", "agent_end", "turn_start", "turn_end",
	"message_start", "message_update", "message_end",
	"tool_execution_start", "tool_execution_update", "tool_execution_end",
	// --- AgentSessionEvent extensions (agent-session.ts:145-172) ---
	"agent_settled", "queue_update",
	"compaction_start", "compaction_progress", "compaction_end",
	"entry_appended", "session_info_changed",
	"tool_hook_status",     // ExtensionToolHookLifecycleEvent
	"system_prompt_change", // SystemPromptChangeEvent
	"thinking_level_changed",
	"auto_retry_start", "auto_retry_end",
	// --- auth login flow (task 13): additive, event-only completion ---
	"auth_login_url", "auth_login_end",
	// --- emitted by the connection handler (not in AgentSessionEvent) ---
	"extension_error",
}

// KnownEventTypes returns the mirrored event discriminant set.
func KnownEventTypes() map[string]bool { return toSet(eventTypes) }

func toSet(xs []string) map[string]bool {
	m := make(map[string]bool, len(xs))
	for _, x := range xs {
		m[x] = true
	}
	return m
}
