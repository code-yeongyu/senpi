// code-yeongyu/oh-my-openagent#10091: the handover journal is the durable record of every phase. A phase recorded
// later must never land under an earlier one, and the record names the request's terms only by digest.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHandoverJournal, handoverTermsDigest } from "../../src/modes/rpc/host-handover-journal.ts";
import type { HandoverView, IdleHandoverRequest } from "../../src/modes/rpc/host-idle-handover.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const request: IdleHandoverRequest = {
	operationId: "op-1",
	ifInstanceId: "host-a",
	ifGeneration: 2,
	targetRuntimeBuildId: "sha256:target",
	launch: { command: "senpi", args: [] },
	hostArgs: [],
	env: { SENPI_TEST_TOKEN: "value-never-written" },
};

function view(phase: "preparing" | "draining"): HandoverView {
	return {
		operationId: "op-1",
		phase,
		state: phase === "draining" ? "handover_completed" : "handover_pending",
		targetRuntimeBuildId: "sha256:target",
	};
}

describe("the handover journal", () => {
	it("ends at the latest phase when writes overlap, and names the terms only by digest", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-10091-journal-"));
		roots.push(root);
		const journal = createHandoverJournal(root);

		await Promise.all([journal.write(view("preparing"), request), journal.write(view("draining"), request)]);

		const path = join(root, "handovers", "op-1.json");
		const text = await readFile(path, "utf8");
		expect(JSON.parse(text)).toMatchObject({
			operation_id: "op-1",
			phase: "draining",
			if_instance_id: "host-a",
			if_generation: 2,
			terms: handoverTermsDigest(request),
		});
		expect(text).not.toContain("value-never-written");
		if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("gives other terms another digest, the environment's values and the presenter policy included", () => {
		expect(handoverTermsDigest({ ...request, env: { SENPI_TEST_TOKEN: "other" } })).not.toBe(
			handoverTermsDigest(request),
		);
		expect(handoverTermsDigest({ ...request, mcpPresenterEnforcement: true })).not.toBe(handoverTermsDigest(request));
	});
});
