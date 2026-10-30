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
	"new_session@1": [
		["plain", {}, "thread"],
		["parent session file", { parentSession: "/x/p.jsonl" }, "device_admin"],
	],
};

/**
 * The record fields each dynamic rule was reviewed against, with the rule version that review produced. The test
 * file proves at compile time that each list is exactly `keyof` the record type: a new field fails the typecheck
 * until someone decides whether it changes the rule's answer (and bumps the version when it does).
 */
export const RULE_FIELDS = {
	open_session: {
		version: 2,
		fields: [
			"attended",
			"auto_title",
			"browserEngine",
			"context",
			"cwd",
			"durableSessionId",
			"env",
			"expectedHostInstance",
			"id",
			"kind",
			"modelId",
			"permissionPreset",
			"promptSurface",
			"provider",
			"retain_on_disconnect",
			"retryFallback",
			"sessionPath",
			"spawnedBy",
			"thinkingLevel",
			"type",
		],
	},
	new_session: { version: 1, fields: ["id", "parentSession", "sessionId", "type"] },
	get_effect_status: { version: 1, fields: ["effectId", "id", "sessionId", "sessionPath", "type"] },
	set_thinking_level: { version: 1, fields: ["effectId", "id", "level", "scope", "sessionId", "type"] },
	append_session_entry: { version: 1, fields: ["entry", "id", "sessionId", "type"] },
} as const;
