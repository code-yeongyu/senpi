import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { teardownChildProcessesAndRoots } from "./helpers/process-teardown.ts";

function spawnChurner(root: string, termMarker: string): ChildProcessWithoutNullStreams {
	const script = `
		const fs = require("node:fs");
		const path = require("node:path");
		const root = process.argv[1];
		const termMarker = process.argv[2];
		for (let i = 0; i < 20000; i++) {
			fs.mkdirSync(path.join(root, "initial-" + i));
		}
		process.stdout.write("ready\\n");
		let i = 0;
		process.on("SIGTERM", () => {
			fs.writeFileSync(termMarker, "term-observed");
			process.stdout.write("term-observed\\n");
		});
		setInterval(() => {
			try {
				const dir = path.join(root, "live-" + i++);
				fs.mkdirSync(dir);
				fs.writeFileSync(path.join(dir, "entry"), "x");
			} catch {}
		}, 0);
	`;
	return spawn(process.execPath, ["-e", script, root, termMarker], { stdio: ["pipe", "pipe", "pipe"] });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function waitForOutput(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let output = "";
		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes(expected)) {
				child.stdout.off("data", onData);
				resolve();
			}
		};
		child.stdout.on("data", onData);
		child.once("error", reject);
		child.once("exit", (code, signal) => reject(new Error(`churner exited: ${code ?? signal}`)));
	});
}

describe("process teardown", () => {
	it("proves immediate removal races a live writer, while event-driven teardown is clean", async () => {
		const oldRoot = mkdtempSync(join(tmpdir(), "senpi-teardown-old-"));
		const oldMarker = join(tmpdir(), `senpi-teardown-old-marker-${process.pid}`);
		const oldChild = spawnChurner(oldRoot, oldMarker);
		await waitForOutput(oldChild, "ready");
		oldChild.kill("SIGTERM");
		await waitForOutput(oldChild, "term-observed");
		let oldError: unknown;
		try {
			rmSync(oldRoot, { recursive: true, force: true });
		} catch (error) {
			oldError = error;
		}
		oldChild.kill("SIGKILL");
		await waitForExit(oldChild);
		if (!oldError) rmSync(oldRoot, { recursive: true, force: true });
		expect(oldError).toMatchObject({ code: "ENOTEMPTY" });

		rmSync(oldMarker, { force: true });

		const newRoot = mkdtempSync(join(tmpdir(), "senpi-teardown-new-"));
		const newMarker = join(tmpdir(), `senpi-teardown-new-marker-${process.pid}`);
		const newChild = spawnChurner(newRoot, newMarker);
		await waitForOutput(newChild, "ready");
		await teardownChildProcessesAndRoots([newChild], [newRoot], 100);
		expect(readFileSync(newMarker, "utf8")).toBe("term-observed");
		rmSync(newMarker, { force: true });
		expect(() => rmSync(newRoot, { recursive: true })).toThrow(/ENOENT/);
	}, 15000);
});
