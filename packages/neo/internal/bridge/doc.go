// Package bridge speaks senpi's JSONL RPC protocol to the TypeScript agent
// brain. It mirrors the RPC command/response and event types
// (packages/coding-agent/src/modes/rpc/rpc-types.ts and the AgentSessionEvent
// union in packages/coding-agent/src/core/agent-session.ts, which extends
// packages/agent's AgentEvent), provides a strict LF-framed JSONL codec, a
// four-shape stdout demux (response / extension_ui_request / extension_error /
// event), and a Transport that spawns `node <cli> --mode rpc` and correlates
// requests (req_N) with responses under a per-request timeout — mirroring
// rpc-client.ts semantics (100ms init wait, 30s default request timeout with a
// per-call override for event-completed commands, stderr capture, typed
// exit-error propagation).
package bridge
