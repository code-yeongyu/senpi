import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliEntry, makeSandbox, repoRoot } from "../lib/common.mjs";
import { hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";

const scenarios = ["retry-recovery", "exhausted", "cancelled", "replay", "separate-turns"];
const selfTest = process.argv.includes("--self-test");
const scenario = process.argv.find((arg) => scenarios.includes(arg)) ?? "retry-recovery";
const box = makeSandbox("provider-errors-tui");
const root = repoRoot();
const preload = fileURLToPath(new URL("./provider-error-tui-preload.mjs", import.meta.url));
// No HTTP server is needed: this fixture injects provider events at the actual
// InteractiveMode seam. Input is consumed by the fixture, never sent to a model.
writeMockModelsJson(box.agentDir, { url: "http://127.0.0.1:1/v1" }, "openai-completions");
writeFileSync(join(box.agentDir, "settings.json"), JSON.stringify({
	theme: "dark", tuiMode: "fullscreen", smoothStreaming: false,
	showChangelog: "never", showStartupTip: false, quietStartup: true,
}));
const env = {
	...hermeticEnv(box.env), SENPI_QA_PROVIDER_SCENARIO: scenario,
	SENPI_CLI_ISOLATED_CHILD: "1", TERM: "xterm-256color",
};
let output = "";
let ready = false;
let phases = 0;
let failure;
let child;
const terminal = selfTest ? {
	cols: 100, rows: 30,
	data(_terminal, data) {
		output += new TextDecoder().decode(data);
	},
} : undefined;
try {
	child = Bun.spawn([
		process.execPath, "--tsconfig-override", join(root, "tsconfig.json"),
		"--preload", preload, cliEntry(root),
		"--provider", "mock", "--model", "mock-model",
		"--no-extensions", "--no-skills", "--no-prompt-templates",
	], {
		cwd: box.cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
		...(terminal ? { terminal } : {}),
		ipc(value) {
			if (value.type === "fixture-error") {
				failure = value.message;
				child?.kill();
			}
			if (value.type === "fixture-ready") {
				ready = true;
				if (selfTest) child.terminal.write("n");
			}
			if (value.type === "fixture-phase") {
				phases = value.phase;
				if (selfTest) child.terminal.write(phases < (scenario === "separate-turns" ? 4 : 3) ? "n" : "q");
			}
		},
	});
	const watchdog = setTimeout(() => {
		failure = "CLI fixture did not complete within 90 seconds";
		child.kill();
	}, 90000);
	const exitCode = await child.exited;
	clearTimeout(watchdog);
	child.terminal?.close();
	if (failure || exitCode !== 0 || !ready || (selfTest && phases < 3)) {
		throw new Error(`${failure ?? "Fixture failed"}: exit=${exitCode}, ready=${ready}, phases=${phases}\n${output}`);
	}
	if (selfTest) console.log(JSON.stringify({ scenario, ready, phases, exitCode, outputBytes: output.length }));
} finally {
	child?.kill();
	box.cleanup();
	console.log("FIXTURE_CLEANUP sandbox removed; owned CLI stopped");
}
