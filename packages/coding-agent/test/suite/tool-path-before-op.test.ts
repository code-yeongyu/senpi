import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpName, PolicyDecision, PolicyHooks } from "@code-yeongyu/senpi-machine-ops";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAllToolDefinitions } from "../../src/core/tools/index.ts";

// senpi#5592: on the tool path, PolicyHooks.beforeOp gates each read/write/edit/bash call exactly once, before any
// effect; a denial leaves the filesystem untouched and the command unrun.

type Call = { op: OpName; args: unknown };

// The tools fall back to their factory cwd and skip session metadata when no extension context is passed.
const NO_CONTEXT = undefined as never;

function recordingPolicy(decide: (op: OpName) => PolicyDecision): { calls: Call[]; policy: PolicyHooks } {
	const calls: Call[] = [];
	return {
		calls,
		policy: {
			async beforeOp(op, args) {
				calls.push({ op, args });
				return decide(op);
			},
		},
	};
}

describe("tool path beforeOp (senpi#5592)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tool-path-before-op-"));
		writeFileSync(join(dir, "note.txt"), "alpha\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("calls beforeOp exactly once per read, write, edit and bash call", async () => {
		const { calls, policy } = recordingPolicy(() => ({ allow: true }));
		const tools = createAllToolDefinitions(dir, { machinePolicy: policy });

		await tools.read.execute("r", { path: "note.txt" }, undefined, undefined, NO_CONTEXT);
		await tools.write.execute("w", { path: "new.txt", content: "fresh\n" }, undefined, undefined, NO_CONTEXT);
		await tools.edit.execute(
			"e",
			{ path: "note.txt", edits: [{ oldText: "alpha", newText: "beta" }] },
			undefined,
			undefined,
			NO_CONTEXT,
		);
		await tools.bash.execute("b", { command: "printf ran > ran.txt" }, undefined, undefined, NO_CONTEXT);

		expect(calls.map((call) => call.op)).toEqual(["files.read", "files.write", "files.edit", "process.exec"]);
		expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("fresh\n");
		expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("beta\n");
		expect(readFileSync(join(dir, "ran.txt"), "utf8")).toBe("ran");
	});

	it("a deny decision blocks the effect: no file written or changed, no command run", async () => {
		const { calls, policy } = recordingPolicy(() => ({ allow: false, reason: "denied by test policy" }));
		const tools = createAllToolDefinitions(dir, { machinePolicy: policy });

		await expect(tools.read.execute("r", { path: "note.txt" }, undefined, undefined, NO_CONTEXT)).rejects.toThrow(
			"denied by test policy",
		);
		await expect(
			tools.write.execute("w", { path: "new.txt", content: "fresh\n" }, undefined, undefined, NO_CONTEXT),
		).rejects.toThrow("denied by test policy");
		await expect(
			tools.edit.execute(
				"e",
				{ path: "note.txt", edits: [{ oldText: "alpha", newText: "beta" }] },
				undefined,
				undefined,
				NO_CONTEXT,
			),
		).rejects.toThrow("denied by test policy");
		await expect(
			tools.bash.execute("b", { command: "printf ran > ran.txt" }, undefined, undefined, NO_CONTEXT),
		).rejects.toThrow("denied by test policy");

		expect(calls).toHaveLength(4);
		expect(existsSync(join(dir, "new.txt"))).toBe(false);
		expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("alpha\n");
		expect(existsSync(join(dir, "ran.txt"))).toBe(false);
	});
});
