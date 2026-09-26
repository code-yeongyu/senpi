#!/usr/bin/env bun
/**
 * macOS live QA driver for senpi computer use (senpi#2128 todo 18). Drives the full stack - coding-agent over
 * rpc with a scripted model -> the `computer` tool -> desktop-service -> the located engine binary -> macOS -
 * and judges every scenario only by independent observer processes (osascript/AX/CoreGraphics probes, TextEdit's
 * scripting dictionary, a Terminal tty) and by files on disk.
 *
 * Run it INSIDE the Aqua session from a launcher holding Screen Recording + Accessibility (Terminal.app):
 *   osascript -e 'tell application "Terminal" to do script "cd <repo> && JETKVM=<jetkvm cli> \
 *     bun scripts/qa-desktop-macos.ts --all --json > <evidence>.jsonl"'
 * Flags: --all | --scenario <name> (repeatable), --sabotage force-foreground, --kvm-shots <dir>, --json.
 * `preflight` always runs first; when it fails nothing else runs. Exit code 0 only when every line passed.
 * The driver owns TextEdit for the run: it is killed between scenarios, so close real TextEdit work first.
 */
import { parseArgs } from "node:util";
import {
	isScenarioName,
	type RunOptions,
	SCENARIOS,
	type ScenarioName,
	type ScenarioResult,
} from "./qa/desktop-macos/scenario.ts";
import {
	backgroundClickKeepsFocus,
	backgroundTypeMultiwindowRefused,
	backgroundTypeSoleWindow,
	foregroundRestores,
} from "./qa/desktop-macos/scenarios-input.ts";
import {
	canary,
	capabilitiesTruth,
	killswitchRealHid,
	preflight,
	screenshotBudget,
} from "./qa/desktop-macos/scenarios-safety.ts";
import { tccDiagnostic } from "./qa/desktop-macos/tcc.ts";

function assertNever(value: never): never {
	throw new TypeError(`unhandled scenario ${JSON.stringify(value)}`);
}

function runScenario(name: ScenarioName, options: RunOptions): Promise<ScenarioResult> {
	switch (name) {
		case "preflight":
			return preflight();
		case "background-click-keeps-focus":
			return backgroundClickKeepsFocus(options);
		case "background-type-sole-window":
			return backgroundTypeSoleWindow();
		case "background-type-multiwindow-refused":
			return backgroundTypeMultiwindowRefused();
		case "foreground-restores":
			return foregroundRestores();
		case "killswitch-real-hid":
			return killswitchRealHid(options);
		case "tcc-diagnostic":
			return tccDiagnostic();
		case "screenshot-budget":
			return screenshotBudget();
		case "capabilities-truth":
			return capabilitiesTruth();
		case "canary":
			return canary();
		default:
			return assertNever(name);
	}
}

/** A scenario that throws still yields its line: `pass:false` with the error as the fact. */
async function judged(name: ScenarioName, options: RunOptions): Promise<ScenarioResult> {
	try {
		return await runScenario(name, options);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return { scenario: name, pass: false, facts: { error: error.message } };
	}
}

const { values } = parseArgs({
	options: {
		all: { type: "boolean", default: false },
		scenario: { type: "string", multiple: true, default: [] },
		sabotage: { type: "string" },
		"kvm-shots": { type: "string" },
		json: { type: "boolean", default: false },
	},
});
const unknown = values.scenario.filter((name) => !isScenarioName(name));
if (unknown.length > 0) throw new Error(`unknown --scenario ${unknown.join(", ")}; known: ${SCENARIOS.join(", ")}`);
if (values.sabotage !== undefined && values.sabotage !== "force-foreground") {
	throw new Error(`unknown --sabotage ${values.sabotage}; known: force-foreground`);
}
const requested = values.all ? SCENARIOS.slice(1) : values.scenario.filter(isScenarioName);
const options: RunOptions = {
	forceForeground: values.sabotage === "force-foreground",
	jetkvm: process.env.JETKVM,
	kvmShots: values["kvm-shots"],
};

const report = (result: ScenarioResult) =>
	console.log(values.json ? JSON.stringify(result) : `${result.pass ? "PASS" : "FAIL"} ${result.scenario}`);
const gate = await judged("preflight", options);
report(gate);
let passed = gate.pass;
if (gate.pass) {
	for (const name of requested.filter((scenario) => scenario !== "preflight")) {
		const result = await judged(name, options);
		report(result);
		passed &&= result.pass;
	}
}
process.exitCode = passed ? 0 : 1;
