// Regression for senpi issue #3560, CLI half of the idle handover: `idleHandoverOutcome` must refuse a
// foreign agent dir BEFORE any `begin_handover` is written to the socket. The host-side gate backstops it
// on a current host, but the CLI refusal is the only guard against a host without that gate, so its
// placement is pinned here with the probe and the request seam both mocked: a foreign dir answers
// `foreign_agent_dir` without the request ever leaving, and the same dir reaches the next check.
import { describe, expect, it, vi } from "vitest";
import { idleHandoverOutcome } from "../../../src/modes/rpc/host-handover-request.ts";

vi.mock("../../../src/modes/rpc/host-probe.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../src/modes/rpc/host-probe.ts")>();
	return {
		...original,
		probeProtocolInfo: vi.fn(async () => ({
			protocolVersion: 1,
			serverVersion: "test",
			capabilities: ["runtime_identity_handover"],
			instanceId: "instance-1",
			generation: 4,
			agentDir: "/agent-dir-of-the-host",
		})),
		requestOnSocket: vi.fn(async () => {
			throw new Error("begin_handover must not be sent");
		}),
	};
});

describe("an idle handover from another agent directory (#3560, CLI check)", () => {
	it("refuses before sending anything, naming both dirs", async () => {
		const outcome = await idleHandoverOutcome(
			{ socket: "/socket/rpc.sock", agentDir: "/agent-dir-of-the-caller" },
			spec(),
			terms(),
		);

		expect(outcome.exitCode).toBe(3);
		expect(outcome.payload).toMatchObject({ reason: "foreign_agent_dir" });
		expect(JSON.stringify(outcome.payload)).toContain("/agent-dir-of-the-host");
		expect(JSON.stringify(outcome.payload)).toContain("/agent-dir-of-the-caller");
		expect(vi.mocked((await import("../../../src/modes/rpc/host-probe.ts")).requestOnSocket)).not.toHaveBeenCalled();
	});

	it("lets the same agent dir past the check", async () => {
		const outcome = await idleHandoverOutcome(
			{ socket: "/socket/rpc.sock", agentDir: "/agent-dir-of-the-host" },
			spec(),
			terms(),
		);

		// Past the agent-dir check the next gate refuses: this CLI never launches the all-zero target build.
		expect(outcome.payload).toMatchObject({ reason: "target_build_mismatch" });
	});
});

function spec() {
	return { hostArgs: [], policy: { idleExitMs: 600_000 }, env: {} };
}

function terms() {
	return {
		operationId: "op-unit",
		ifInstanceId: "instance-1",
		ifGeneration: 4,
		targetRuntimeBuildId: `sha256:${"0".repeat(64)}`,
	};
}
