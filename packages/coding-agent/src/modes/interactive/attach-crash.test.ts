/**
 * #4269 review M1: the attached TUI restores the terminal on every way the process can die. Each case
 * runs the real presentation in a child Bun process on a real terminal (script(1)), so the exit code
 * and the restore sequence are observed, not mocked.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../config.ts";

const endpointModule = fileURLToPath(new URL("../../../test/helpers/attach-endpoint.ts", import.meta.url));
const runModule = fileURLToPath(new URL("./run-attached-tui.ts", import.meta.url));
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the attached TUI against a scripted endpoint, then `action` once `trigger` reached the endpoint.
 * A Bun driver gives the fixture a real terminal (a PTY) and reports its exit code and everything it drew.
 * The PTY's input stays open, so nothing but the action under test ends the presentation.
 */
function attachOnTerminal(options: { hold?: string[]; trigger: string; action: string[] }) {
	const dir = mkdtempSync(join(tmpdir(), "senpi-attach-crash-"));
	dirs.push(dir);
	const fixture = join(dir, "fixture.ts");
	writeFileSync(
		fixture,
		[
			`import { endpoint } from ${JSON.stringify(endpointModule)};`,
			`import { runAttachedTui } from ${JSON.stringify(runModule)};`,
			`const host = await endpoint({ hold: ${JSON.stringify(options.hold ?? [])} });`,
			'const run = runAttachedTui({ address: host.path, session: "durable" });',
			`await host.command(${JSON.stringify(options.trigger)});`,
			...options.action,
		].join("\n"),
	);
	const driver = join(dir, "driver.ts");
	writeFileSync(
		driver,
		[
			"let output = '';",
			`const child = Bun.spawn(['bun', ${JSON.stringify(fixture)}], {`,
			"  env: { ...process.env, TERM: 'xterm-256color' },",
			"  terminal: { cols: 80, rows: 24, data(_terminal, bytes) { output += Buffer.from(bytes).toString('utf8'); } },",
			"});",
			"const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);",
			"const status = await child.exited;",
			"clearTimeout(timer);",
			"child.terminal?.close();",
			"process.stdout.write(JSON.stringify({ status, output }));",
		].join("\n"),
	);
	const result = spawnSync("bun", [driver], {
		env: { ...process.env, [ENV_AGENT_DIR]: dir },
		encoding: "utf8",
		timeout: 60_000,
	});
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout) as { status: number; output: string };
}

function expectRestored(output: string): void {
	const on = output.indexOf(BRACKETED_PASTE_ON);
	expect(on, "the TUI started on the terminal").toBeGreaterThanOrEqual(0);
	expect(output.lastIndexOf(BRACKETED_PASTE_OFF), "the terminal was restored after it started").toBeGreaterThan(on);
}

describe.skipIf(process.platform === "win32")("attached TUI crash safety", { timeout: 90_000 }, () => {
	it("restores the terminal and exits non-zero with the original error on an uncaught throw", () => {
		const result = attachOnTerminal({
			trigger: "get_entries",
			action: ['setTimeout(() => { throw new Error("attach-crash-probe"); }, 0);', "await run;"],
		});
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("attach-crash-probe");
		expectRestored(result.output);
	});

	it("restores the terminal and exits non-zero with the original error on an unhandled rejection", () => {
		const result = attachOnTerminal({
			trigger: "get_entries",
			action: ['void Promise.reject(new Error("attach-rejection-probe"));', "await run;"],
		});
		expect(result.status).not.toBe(0);
		expect(result.output).toContain("attach-rejection-probe");
		expectRestored(result.output);
	});

	it("restores the terminal and exits non-zero on a second signal while the release waits on a silent endpoint", () => {
		const started = Date.now();
		const result = attachOnTerminal({
			hold: ["release_attachment"],
			trigger: "get_entries",
			action: [
				'process.kill(process.pid, "SIGTERM");',
				'await host.command("release_attachment");',
				'process.kill(process.pid, "SIGTERM");',
				"await run;",
				"process.stdout.write('ATTACH_RETURNED\\n');",
				"process.exit(0);",
			],
		});
		expect(Date.now() - started, "left before the release deadline").toBeLessThan(25_000);
		expect(result.output).not.toContain("ATTACH_RETURNED");
		expect(result.status).not.toBe(0);
		expectRestored(result.output);
	});

	it("leaves promptly when interrupted while the endpoint has not answered", () => {
		const result = attachOnTerminal({
			hold: ["set_client_info"],
			trigger: "set_client_info",
			action: [
				"const interrupted = Date.now();",
				'process.kill(process.pid, "SIGINT");',
				"await run;",
				"process.stdout.write('ATTACH_RETURNED ' + (Date.now() - interrupted) + '\\n');",
				"await host.close();",
				"process.exit(0);",
			],
		});
		const returned = /ATTACH_RETURNED (\d+)/.exec(result.output);
		expect(returned, result.output).not.toBeNull();
		expect(Number(returned?.[1])).toBeLessThan(5_000);
		expect(result.status).toBe(0);
		expectRestored(result.output);
	});
});
