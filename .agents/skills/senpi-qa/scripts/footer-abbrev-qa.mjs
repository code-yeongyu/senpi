/**
 * Surface QA: footer context-usage abbreviation in the REAL TUI.
 * Boots the interactive TUI in tmux against the local fake model server
 * (model contextWindow = 1,000,000), drives one prompt so token counters
 * populate, then asserts the footer shows oh-my-pi-style abbreviated
 * notation (e.g. "1M", "K") and never comma-grouped "1,000,000".
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	cliEntry,
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
	stripAnsi,
	tsxEntry,
} from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";
import { readFileSync } from "node:fs";

const checks = createChecks("footer-abbrev-tui");
const guard = guardRealAuth();
installCleanupHooks();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const ev = evidenceDir("footer-abbrev");
const box = makeSandbox("footer-abbrev-tui");
const root = repoRoot();

// Fake model server; patch contextWindow up to 1,000,000 after writing.
const server = await startFakeModelServer({ turns: [{ text: "FOOTER-QA-OK" }] });
writeMockModelsJson(box.agentDir, server, "openai-completions");
const modelsPath = join(box.agentDir, "models.json");
const models = JSON.parse(readFileSync(modelsPath, "utf8"));
models.providers.mock.models[0].contextWindow = 1_000_000;
writeFileSync(modelsPath, JSON.stringify(models, null, 2));

const session = `senpi-qa-footer-${process.pid}`;
const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" });
const capture = () => {
	try {
		return tmux("capture-pane", "-t", session, "-p");
	} catch {
		return "";
	}
};

try {
	execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
} catch {}

const env = hermeticEnv({
	SENPI_CODING_AGENT_DIR: box.agentDir,
	SENPI_CODING_AGENT_SESSION_DIR: box.sessionDir,
	PI_OFFLINE: "1",
	PI_TELEMETRY: "0",
});
const envExports = Object.entries(env)
	.map(([k, v]) => `export ${k}=${shq(v)}`)
	.join(" && ");

try {
	tmux("new-session", "-d", "-s", session, "-x", "120", "-y", "30");
	tmux(
		"send-keys",
		"-t",
		session,
		`cd ${shq(box.cwd)} && ${envExports} && exec ${shq(process.execPath)} ${shq(tsxEntry(root))} --tsconfig ${shq(join(root, "tsconfig.json"))} ${shq(cliEntry(root))} --no-context-files --no-skills --no-extensions --approve --provider mock --model mock-model`,
		"Enter",
	);

	// Wait for boot (footer present), then drive one prompt.
	let booted = "";
	for (let i = 0; i < 60; i++) {
		await sleep(1000);
		booted = capture();
		if (/\(auto\)/.test(stripAnsi(booted))) break;
	}
	writeFileSync(join(ev, "footer-before-prompt.txt"), stripAnsi(booted));

	tmux("send-keys", "-t", session, "say FOOTER-QA-OK", "Enter");
	let after = "";
	for (let i = 0; i < 45; i++) {
		await sleep(1000);
		after = capture();
		if (stripAnsi(after).includes("FOOTER-QA-OK") && /K\/1M|M\/1M/.test(stripAnsi(after))) break;
	}
	const plain = stripAnsi(after);
	writeFileSync(join(ev, "footer-after-prompt.txt"), plain);

	const footerLine = plain.split("\n").find((l) => l.includes("(auto)")) ?? "";
	checks.ok("TUI booted with mock model", booted.trim().length > 0, `footer=${footerLine.trim()}`);
	checks.ok(
		"footer context window abbreviated to 1M",
		footerLine.includes("/1M"),
		`footer=${footerLine.trim()}`,
	);
	checks.ok(
		"footer shows no comma-grouped window (1,000,000)",
		!footerLine.includes("1,000,000"),
		`footer=${footerLine.trim()}`,
	);
	checks.ok(
		"mock turn completed (FOOTER-QA-OK visible)",
		plain.includes("FOOTER-QA-OK"),
		"turn output present",
	);
	const tokenFooter = /[0-9.,]+[KMB]?\/1M \([0-9.]+%\)/.test(footerLine);
	checks.ok("footer context usage is abbreviated tokens/1M (pct%)", tokenFooter, `footer=${footerLine.trim()}`);
} finally {
	try {
		execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
	} catch {}
	await server.stop();
	box.cleanup();
	checks.ok("real auth unchanged", guard.assertUnchanged(), "auth.json sha256 stable");
	checks.finish();
}
