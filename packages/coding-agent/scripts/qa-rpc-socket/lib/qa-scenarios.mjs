/**
 * Scenario registry of `tool-child-qa.mjs`. A scenario declares `requires: [todo ids]`; each todo id
 * maps to the capability tokens a host advertises in `get_protocol_info.capabilities` once that todo
 * has landed (`tool_runtime:*` from todo 1, `placement:<name>` for what the tool child's `hello`
 * placements cover, `entries-paging` from todo 14). The driver refuses a scenario with any unmet
 * requirement (`prerequisite_missing`, exit 3), so a scenario can never invoke a migrated tool before
 * its todo. Bodies of the later scenarios land with the todo that advertises their capability.
 */
import { fixtureDeadlineScenario } from "./qa-scenario-fixture-deadline.mjs";
import { fixtureToolsScenario } from "./qa-scenario-fixture-tools.mjs";
import { hostcallLargeScenario, lockDrainScenario } from "./qa-scenario-hostcall.mjs";
import { offloadLegacyNoChildScenario, offloadSessionStartScenario } from "./qa-scenario-offload.mjs";
import { terminalChildKillScenario, terminalStreamScenario } from "./qa-scenario-terminal.mjs";
import { launchApisAckGatedScenario } from "./qa-scenario-launch-barrier.mjs";
import { skipAckWaitScenario } from "./qa-scenario-skip-ack.mjs";

export const REQUIREMENT_CAPABILITIES = Object.freeze({
	4: ["tool_runtime:child", "placement:launch-barrier"],
	6: ["placement:job-policy"],
	7: ["placement:hostcall"],
	8: ["offload_api"],
	9: ["placement:terminal"],
	10: ["placement:durable-monitor"],
	11: ["placement:search"],
	12: ["placement:file"],
	13: ["placement:session-parse"],
	14: ["entries-paging"],
	15: ["branch-projection"],
	16: ["placement:compaction"],
	17: ["placement:kernel"],
	18: ["placement:residency"],
	19: ["placement:faults"],
	33: ["tui-attach"],
	36: ["tool_runtime_default:child"],
	37: ["tui-attach-default"],
});

const LATER = [
	["10-durable-recovery", [4, 10]],
	["10-durable-crash-loop", [4, 10]],
	["11-grep-missing-path", [11]],
	["12-two-sessions-one-file", [4, 12]],
	["12-read-truncation-parity", [12]],
	["13-torn-tail-open", [13]],
	["14-rows-and-paging", [4, 14]],
	["14-legacy-client-unpaged", [4, 14]],
	["15-shape-access", [4, 15]],
	["15-resident-warn", [4, 15]],
	["16-compact-25mb", [4, 16]],
	["16-kill-during-prepare", [4, 16]],
	["17-cell-launch-apis-ack-gated", [4, 17]],
	["17-cell-skip-ack-wait-detected", [4, 17]],
	["18-evict-respawn", [4, 18]],
	["18-python-tree-ceiling", [4, 18]],
	["19-two-sessions-kill", [4, 19]],
	["19-crash-loop", [4, 19]],
	["33-tui-attach", [4, 33]],
	["33-tui-reconnect", [4, 33]],
	["36-default-is-child", [36]],
	["36-legacy-bash-no-child", [36]],
	["37-tui-default-attaches", [37]],
	["37-tui-embedded-optin", [37]],
];

export const SCENARIOS = Object.freeze([
	fixtureToolsScenario,
	launchApisAckGatedScenario,
	skipAckWaitScenario(),
	fixtureDeadlineScenario,
	hostcallLargeScenario,
	lockDrainScenario,
	offloadSessionStartScenario,
	offloadLegacyNoChildScenario,
	terminalStreamScenario,
	terminalChildKillScenario(),
	...LATER.map(([id, requires]) => ({ id, requires, run: undefined })),
]);

/** Unmet requirements as `[{ todo, missing: [capability] }]`; empty when every requirement is met. */
export function unmetRequirements(requires, protocolInfo) {
	const advertised = new Set(Array.isArray(protocolInfo?.capabilities) ? protocolInfo.capabilities : []);
	const unmet = [];
	for (const todo of requires) {
		const needed = REQUIREMENT_CAPABILITIES[todo] ?? [`todo:${todo}`];
		const missing = needed.filter((capability) => !advertised.has(capability));
		if (missing.length > 0) unmet.push({ todo, missing });
	}
	return unmet;
}
