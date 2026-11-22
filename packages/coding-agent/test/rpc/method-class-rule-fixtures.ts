import type { RpcMethodClass } from "../../src/modes/rpc/method-classes.ts";

type RuleCase = readonly [name: string, fields: Record<string, unknown>, expected: RpcMethodClass];

const entry = (fields: Record<string, unknown>) => ({ id: "e", parentId: null, timestamp: "t", ...fields });
const message = (fields: Record<string, unknown>) => entry({ type: "message", message: { timestamp: 0, ...fields } });

const APPEND_ENTRY_CASES: ReadonlyArray<readonly [string, unknown, RpcMethodClass]> = [
	["user message", message({ role: "user", content: "hi" }), "drive"],
	["assistant message", message({ role: "assistant", content: [] }), "device_admin"],
	["tool result", message({ role: "toolResult", toolCallId: "t", toolName: "bash", content: [] }), "device_admin"],
	["message without a role", message({ content: "hi" }), "device_admin"],
	["message without a message", entry({ type: "message" }), "device_admin"],
	["custom entry", entry({ type: "custom", customType: "x", data: {} }), "device_admin"],
	["custom message", entry({ type: "custom_message", customType: "x", content: "hi", display: true }), "device_admin"],
	["label", entry({ type: "label", targetId: "e", label: "x" }), "device_admin"],
	["compaction", entry({ type: "compaction", summary: "s", firstKeptEntryId: "e", tokensBefore: 1 }), "device_admin"],
	["model change", entry({ type: "model_change", provider: "p", modelId: "m" }), "device_admin"],
	["unknown entry type", entry({ type: "zz_unknown" }), "device_admin"],
	["entry not an object", "message", "device_admin"],
	["no entry", undefined, "device_admin"],
];

const IDLE_START_CASES: ReadonlyArray<RuleCase> = [
	["command that starts a turn", { message: "/mcp enable x", whenIdle: "start" }, "device_admin"],
	["command on the queue path", { message: "/mcp enable x" }, "drive"],
	["command explicitly queued", { message: "/mcp enable x", whenIdle: "queue" }, "drive"],
	["text that starts a turn", { message: "hi", whenIdle: "start" }, "drive"],
	["leading space is not a command", { message: " /mcp", whenIdle: "start" }, "drive"],
	["non-string message that starts a turn", { message: 7, whenIdle: "start" }, "device_admin"],
];

/**
 * Each dynamic rule's OUTPUTS, keyed `<type>@<version>`. A classify change without a version bump fails the output
 * comparison; a bump fails the key match until the fixture is re-recorded under the new version on purpose.
 */
export const RULE_FIXTURES: Readonly<Record<string, ReadonlyArray<RuleCase>>> = {
	"append_session_entry@1": APPEND_ENTRY_CASES.map(([name, value, expected]) => [name, { entry: value }, expected]),
	"open_session@2": [
		["by id only", { sessionId: "s" }, "thread"],
		["expected host instance", { expectedHostInstance: "h" }, "thread"],
		["provider and model", { provider: "p", modelId: "m" }, "thread"],
		["session file", { sessionPath: "/x/s.jsonl" }, "device_admin"],
		["cwd", { cwd: "/x" }, "device_admin"],
		["permission preset", { permissionPreset: "full-access" }, "device_admin"],
		["browser engine", { browserEngine: "connected" }, "device_admin"],
		["tool environment", { env: { OMOCAT_LANE: "x" } }, "device_admin"],
		["an empty tool environment still names one", { env: {} }, "device_admin"],
		["a null path still names one", { sessionPath: null }, "device_admin"],
		["an explicitly undefined field is absent", { cwd: undefined, env: undefined }, "thread"],
	],
	"get_effect_status@1": [
		["by session id", { sessionId: "s", effectId: "e" }, "observe"],
		["in a named session file", { sessionPath: "/x/s.jsonl", effectId: "e" }, "device_admin"],
	],
	"set_thinking_level@1": [
		["this turn only", { level: "high", scope: "turn" }, "drive"],
		["remembered for the model", { level: "high" }, "device_admin"],
		["another scope", { level: "high", scope: "session" }, "device_admin"],
	],
	"set_model@1": [
		["this session only", { provider: "p", modelId: "m", scope: "session" }, "drive"],
		["persisted as the default", { provider: "p", modelId: "m" }, "device_admin"],
		["another scope", { provider: "p", modelId: "m", scope: "turn" }, "device_admin"],
	],
	"new_session@1": [
		["plain", {}, "thread"],
		["parent session file", { parentSession: "/x/p.jsonl" }, "device_admin"],
	],
	"prompt@1": [
		["plain text", { message: "hi" }, "drive"],
		["slash command", { message: "/mcp enable x" }, "device_admin"],
		["credential command", { message: "/account openai remove a" }, "device_admin"],
		["bare slash", { message: "/" }, "device_admin"],
		["templates explicitly on", { message: "/mcp enable x", expandPromptTemplates: true }, "device_admin"],
		["a non-boolean opt-out still expands", { message: "/mcp", expandPromptTemplates: "false" }, "device_admin"],
		["templates off sends the text", { message: "/mcp enable x", expandPromptTemplates: false }, "drive"],
		["leading space is not a command", { message: " /mcp" }, "drive"],
		["slash later in the text", { message: "see /mcp" }, "drive"],
		["non-string message", { message: 7 }, "device_admin"],
		["missing message", {}, "device_admin"],
	],
	"steer@1": IDLE_START_CASES,
	"follow_up@1": IDLE_START_CASES,
};
