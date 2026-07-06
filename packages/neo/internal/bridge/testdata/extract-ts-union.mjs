/**
 * TS union extractor for the Go bridge exhaustiveness test (task 3).
 *
 * The exhaustiveness test must NOT rely on a hand-maintained list. This script
 * parses the ACTUAL TypeScript sources at test time and emits, as JSON on
 * stdout, the discriminant members the Go bridge must mirror:
 *
 *   {
 *     "commands":       [ "prompt", "steer", ... ],   // RpcCommand.type
 *     "responseCommands":[ "prompt", "get_state", ... ],// RpcResponse.command literals
 *     "extensionUIMethods":[ "select", "confirm", ... ],// RpcExtensionUIRequest.method
 *     "events":         [ "agent_start", "queue_update", ... ] // AgentEvent + AgentSessionEvent .type
 *   }
 *
 * Sources (paths resolved from the senpi repo root):
 *   - packages/coding-agent/src/modes/rpc/rpc-types.ts       (RpcCommand, RpcResponse, RpcExtensionUIRequest)
 *   - packages/coding-agent/src/core/agent-session.ts        (AgentSessionEvent, lines ~145-172)
 *   - packages/agent/src/types.ts                            (base AgentEvent, extended by AgentSessionEvent)
 *   - packages/coding-agent/src/core/extensions/runner.ts    (ExtensionToolHookLifecycleEvent -> tool_hook_status)
 *   - packages/coding-agent/src/core/extensions/types.ts     (SystemPromptChangeEvent -> system_prompt_change)
 *   - packages/coding-agent/src/modes/rpc/rpc-mode.ts        (extension_error emit)
 *
 * The parse is deliberately narrow: it isolates the specific `export type X =`
 * declaration block, then harvests string-literal discriminants inside it. If a
 * source shape drifts (a union renamed / moved), extraction throws so the test
 * fails loudly rather than silently under-counting.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function repoRoot() {
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "packages", "coding-agent", "src", "cli.ts"))) return dir;
		dir = dirname(dir);
	}
	throw new Error("repo root not found");
}

const ROOT = repoRoot();
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/**
 * Extract the body of an `export type <name> = ... ;` declaration.
 * Returns the text between `=` and the terminating top-level `;`.
 */
function extractTypeBody(source, name) {
	const re = new RegExp(`export type ${name}\\s*=`);
	const m = re.exec(source);
	if (!m) throw new Error(`type ${name} not found`);
	let i = m.index + m[0].length;
	// Read until the semicolon that closes the type alias, tracking brace/bracket depth.
	let depth = 0;
	const start = i;
	for (; i < source.length; i++) {
		const c = source[i];
		if (c === "{" || c === "[" || c === "(") depth++;
		else if (c === "}" || c === "]" || c === ")") depth--;
		else if (c === ";" && depth === 0) break;
	}
	if (i >= source.length) throw new Error(`unterminated type ${name}`);
	return source.slice(start, i);
}

/** Extract the body of an `export interface <name> { ... }` declaration. */
function extractInterfaceBody(source, name) {
	const re = new RegExp(`export interface ${name}\\s*\\{`);
	const m = re.exec(source);
	if (!m) throw new Error(`interface ${name} not found`);
	let i = m.index + m[0].length;
	let depth = 1;
	const start = i;
	for (; i < source.length; i++) {
		const c = source[i];
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) break;
		}
	}
	return source.slice(start, i);
}

/** Harvest every `<key>: "literal"` discriminant for the given key from a body. */
function literalsForKey(body, key) {
	const re = new RegExp(`\\b${key}:\\s*"([^"]+)"`, "g");
	const out = [];
	let m;
	while ((m = re.exec(body)) !== null) out.push(m[1]);
	return out;
}

function uniq(arr) {
	return [...new Set(arr)].sort();
}

const rpcTypes = read("packages/coding-agent/src/modes/rpc/rpc-types.ts");
const agentSession = read("packages/coding-agent/src/core/agent-session.ts");
const agentTypes = read("packages/agent/src/types.ts");
const runner = read("packages/coding-agent/src/core/extensions/runner.ts");
const extTypes = read("packages/coding-agent/src/core/extensions/types.ts");
const rpcMode = read("packages/coding-agent/src/modes/rpc/rpc-mode.ts");

// --- Commands (RpcCommand.type) ---
const commandBody = extractTypeBody(rpcTypes, "RpcCommand");
const commands = uniq(literalsForKey(commandBody, "type"));

// --- Response commands (RpcResponse.command) ---
const responseBody = extractTypeBody(rpcTypes, "RpcResponse");
// The trailing error variant uses `command: string` (no literal) — the literal
// scan naturally skips it; Go models the error response separately.
const responseCommands = uniq(literalsForKey(responseBody, "command"));

// --- Extension UI request methods (RpcExtensionUIRequest.method) ---
const uiReqBody = extractTypeBody(rpcTypes, "RpcExtensionUIRequest");
const extensionUIMethods = uniq(literalsForKey(uiReqBody, "method"));

// --- Events: base AgentEvent (packages/agent) + AgentSessionEvent extensions ---
const agentEventBody = extractTypeBody(agentTypes, "AgentEvent");
const baseEvents = literalsForKey(agentEventBody, "type");

const sessionEventBody = extractTypeBody(agentSession, "AgentSessionEvent");
const sessionInlineEvents = literalsForKey(sessionEventBody, "type");

// AgentSessionEvent references two named event types by identifier; resolve their
// discriminants from their own declarations so nothing is missed.
const hookBody = extractTypeBody(runner, "ExtensionToolHookLifecycleEvent");
// tool_hook_status lives on the Base type it composes.
const hookBaseMatch = /ExtensionToolHookLifecycleEventBase\s*=\s*\{[\s\S]*?type:\s*"([^"]+)"/.exec(runner);
const hookEvent = hookBaseMatch ? [hookBaseMatch[1]] : literalsForKey(hookBody, "type");

const sysPromptBody = extractInterfaceBody(extTypes, "SystemPromptChangeEvent");
const sysPromptEvent = literalsForKey(sysPromptBody, "type");

// extension_error is emitted by rpc-mode (not part of AgentSessionEvent), but the
// Go demux MUST classify it, so the exhaustiveness set includes it.
const extErrMatch = /output\(\{\s*type:\s*"(extension_error)"/.exec(rpcMode);
const extErrEvent = extErrMatch ? [extErrMatch[1]] : [];

const events = uniq([
	...baseEvents,
	...sessionInlineEvents,
	...hookEvent,
	...sysPromptEvent,
	...extErrEvent,
]);

// Sanity floor: if any source drifted so the scan under-collected, fail loudly.
if (commands.length < 20) throw new Error(`suspiciously few commands: ${commands.length}`);
if (extensionUIMethods.length !== 9) throw new Error(`expected 9 extension-UI methods, got ${extensionUIMethods.length}: ${extensionUIMethods}`);
if (events.length < 15) throw new Error(`suspiciously few events: ${events.length}`);

process.stdout.write(JSON.stringify({ commands, responseCommands, extensionUIMethods, events }, null, 2));
process.stdout.write("\n");
