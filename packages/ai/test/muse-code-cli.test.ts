import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type MuseRunRequest, MuseSidecarError, runMuse } from "../src/api/muse-code-cli.ts";

const request: MuseRunRequest = {
	model: "muse-spark-1.2",
	prompt: "SIDECAR_TEST",
	reasoning: "low",
	workspace: process.cwd(),
	allowTools: false,
};

describe("muse CLI sidecar", () => {
	it("finishes on the run terminal even when the CLI keeps stdout open", async () => {
		// Given a CLI that streams, emits run_terminal, and then never closes stdout
		const binary = fileURLToPath(new URL("./fixtures/muse-hold-open.cjs", import.meta.url));
		const signal = AbortSignal.timeout(10_000);
		const deltas: string[] = [];
		// When
		const answer = await runMuse({ ...request, binary, signal }, (delta) => deltas.push(delta));
		// Then
		expect(answer).toBe("DONE");
		expect(deltas.join("")).toBe(answer);
	});

	it("rejects a CLI that exits without a completed run terminal", async () => {
		await expect(runMuse({ ...request, binary: "/usr/bin/false" }, () => {})).rejects.toBeInstanceOf(
			MuseSidecarError,
		);
	});

	it("does not launch the CLI for an already cancelled turn", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(runMuse({ ...request, signal: controller.signal }, () => {})).rejects.toMatchObject({
			name: "AbortError",
		});
	});
});
