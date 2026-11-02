// senpi#3566 todo 4: the test-only switches the barrier QA relies on are parsed and released exactly as specified.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTestControls } from "./test-controls.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("readTestControls", () => {
	it("enables a switch only for a non-empty, non-zero value and exposes its value", () => {
		const controls = readTestControls({
			SENPI_TOOL_CHILD_TEST_HOLD_LAUNCH_ACK: "1",
			SENPI_TOOL_CHILD_TEST_HOLD_LAUNCH_PROOF: "detached",
			SENPI_TOOL_CHILD_TEST_SKIP_ACK_WAIT: "0",
		});
		expect(controls.enabled("HOLD_LAUNCH_ACK")).toBe(true);
		expect(controls.value("HOLD_LAUNCH_PROOF")).toBe("detached");
		expect(controls.enabled("SKIP_ACK_WAIT")).toBe(false);
		expect(controls.enabled("STOP_AFTER_SPAWN")).toBe(false);
	});

	it("releases on a control file created after the wait began, and at once when it already exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tcc-ctl-"));
		roots.push(dir);
		const controls = readTestControls({ SENPI_TOOL_CHILD_TEST_CONTROL_DIR: dir });
		let released = false;
		const waiting = controls.released("release-L1").then(() => {
			released = true;
		});
		await Promise.resolve();
		expect(released).toBe(false);
		await writeFile(join(dir, "release-L1"), "");
		await waiting;
		expect(released).toBe(true);
		await controls.released("release-L1");
	});

	it("refuses to wait without a control directory", async () => {
		await expect(readTestControls({}).released("release-L1")).rejects.toThrow(/CONTROL_DIR/);
	});
});
