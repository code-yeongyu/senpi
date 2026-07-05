// Package bridge speaks senpi's JSONL RPC protocol to the TypeScript agent
// brain. It defines the RPC command/response and event types, a JSONL codec,
// and a Transport that spawns `node <cli> --mode rpc` and correlates requests
// with responses. The concrete implementation lands in a later task; this file
// establishes the package so the module builds and tests as a whole.
package bridge
