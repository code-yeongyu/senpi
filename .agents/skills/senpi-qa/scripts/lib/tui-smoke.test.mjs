import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { observeFrames } from "./tui-frames.mjs";

// Hold the first render at its real protocol boundary without delaying a clock.
test("render waits for a non-empty committed frame, including split commit bytes", async () => {
	const frames = observeFrames();
	let sampled = false;
	const first = frames.waitFor(text => text.trim().length > 0, "render", 3000)
		.then(frame => { sampled = true; return frame; });
	frames.push("Loading CLI\r\nStill loading\r\n");
	frames.push("\x1b[?2026h\x1b[?7l\x1b[?7h\x1b[?2026l");
	frames.push("\x1b[?2026h\x1b[?7lComposer\r\nStatus\x1b[?7h\x1b[?2026");
	await Promise.resolve();
	assert.equal(sampled, false, "startup text, blank commits and a held frame must not be sampled");
	frames.push("l");
	assert.equal(await first, "Composer\nStatus");
});

/** Run the tmux smoke against a fixture CLI body; resolves { code, output }. */
async function runSmoke(dir, body, env = process.env) {
	const fixture = join(dir, "cli.mjs");
	writeFileSync(fixture, `#!/usr/bin/env node\n${body}`);
	chmodSync(fixture, 0o700);
	const child = spawn(process.execPath, [
		fileURLToPath(new URL("../tui-smoke.mjs", import.meta.url)),
		"--self-test", "--driver", "tmux", "--child", `binary:${fixture}`, "--timeout-ms", "3000",
	], { env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", data => { output += data; });
	child.stderr.on("data", data => { output += data; });
	const code = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { child.kill(); reject(new Error("smoke subprocess did not exit")); }, 60000);
		child.once("error", reject);
		child.once("close", code => { clearTimeout(timer); resolve(code); });
	});
	return { code, output };
}

// senpi#4986: pre-render diagnostics plus input echo are not a rendered frame.
test("TUI smoke rejects a live process that never renders", { skip: process.platform === "win32" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "smoke-no-render-"));
	try {
		const { code, output } = await runSmoke(dir, `process.stdout.write("Loading CLI\\r\\nStill loading\\r\\n");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", data => {
	if (data.includes(3)) process.exit(0);
	process.stdout.write(data);
});
`);
		assert.equal(code, 1, output);
		assert.match(output, /render.*timed out/i);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// The tmux control socket must stay under the Unix socket path limit (~104-108 bytes) whatever TMPDIR is.
test("TUI smoke passes a rendering process under a TMPDIR longer than the socket path limit", { skip: process.platform === "win32" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "smoke-long-tmp-"));
	try {
		const longTmp = join(dir, "t".repeat(60), "u".repeat(60));
		mkdirSync(longTmp, { recursive: true });
		const { code, output } = await runSmoke(dir, `const frame = text => process.stdout.write("\\x1b[?2026h" + text + "\\x1b[?2026l");
frame("Composer> ");
process.stdin.setRawMode(true);
process.stdin.resume();
let typed = "";
process.stdin.on("data", data => {
	if (data.includes(3)) process.exit(0);
	typed += data;
	frame("\\x1b[H\\x1b[2KComposer> " + typed);
});
`, { ...process.env, TMPDIR: longTmp });
		assert.equal(code, 0, output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
