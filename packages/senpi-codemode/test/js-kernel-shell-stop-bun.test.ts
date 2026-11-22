import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const driver = fileURLToPath(new URL("../scripts/qa-shell-stop.ts", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

async function runDriver(
	mode: string,
	expectedExitCode = 0,
): Promise<{ readonly report: unknown; readonly stdout: string; readonly stderr: string }> {
	const child = spawn("bun", [driver, mode], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	try {
		expect(await exited, stderr).toBe(expectedExitCode);
		const report: unknown = expectedExitCode === 0 ? JSON.parse(stdout.split("\n")[0] ?? "") : undefined;
		return { report, stdout, stderr };
	} finally {
		child.kill();
	}
}

describe.skipIf(!bunAvailable)("Bun shell Stop", () => {
	it.each(["shell", "text", "lines"])(
		"reports state loss when Stop interrupts a native %s wait",
		async (mode) => {
			// Given a real kernel and a command that announces readiness through a socket.
			// When the driver stops the command after its readiness event.
			const { report, stdout } = await runDriver(mode);
			// Then the command has exited, globals are cleared, and the result names the restart class.
			expect(report).toMatchObject({
				retained: false,
				result: { ok: false, error: { code: "js_shell_interrupt_restart" } },
				note: expect.any(String),
				next: { ok: true },
			});
			expect(report).not.toHaveProperty("next.valueRepr");
			expect(stdout).toContain("COMMAND_EXITED");
		},
		90_000,
	);

	it("keeps globals and refuses the shell when a cell swallows Stop and then starts a native shell", async () => {
		// Given a cell that awaits a host tool, swallows the interruption, then starts a native shell (#2788).
		// When Stop interrupts the host-tool wait.
		const { report } = await runDriver("late");
		// Then the cell is released with its globals kept, and the late shell is refused instead of costing the worker.
		expect(report).toMatchObject({
			retained: true,
			result: { ok: false },
			next: { ok: true, valueRepr: expect.stringContaining('"saved":41') },
		});
		expect(report).toMatchObject({
			next: { valueRepr: expect.stringContaining('"lateShell":"JS cell interrupted: stop') },
		});
	}, 90_000);

	it("keeps globals without a shell restart notice when Stop interrupts a normal await", async () => {
		// Given a completed native shell followed by a host-tool wait.
		// When Stop interrupts that wait after its tool-call event.
		const { report } = await runDriver("normal");
		// Then globals survive and the former shell cannot contaminate the outcome.
		expect(report).toMatchObject({ retained: true, result: { ok: false }, next: { ok: true, valueRepr: "41" } });
		expect(report).not.toHaveProperty("note");
		expect(report).not.toHaveProperty("result.error.code");
	}, 90_000);

	it("keeps normal shell output and globals when the cell finishes", async () => {
		// Given a native shell that prints one line.
		// When it completes without interruption.
		const { report } = await runDriver("finished");
		// Then its output and persistent variables are unchanged.
		expect(report).toMatchObject({
			completed: { ok: true, valueRepr: '"normal\\n"' },
			next: { ok: true, valueRepr: "41" },
		});
	}, 90_000);

	it("cleans up when the shell exits before connecting", async () => {
		// Given a command that fails before announcing socket readiness.
		// When the real driver waits for its readiness event.
		const { stdout, stderr } = await runDriver("failed", 1);
		// Then failure exits through cleanup rather than leaving the listener alive.
		expect(JSON.parse(stderr.trim())).toMatchObject({ code: "qa_shell_ready_failed" });
		expect(stdout).toContain("CLEANUP_COMPLETE");
	}, 90_000);
});
