// code-yeongyu/oh-my-openagent#10091: a host whose handover still refuses every new prompt until it is idle is never
// asked for one. The CLI answers `migration_deferred` before any `begin_handover` reaches the socket, and the update
// waits for that host's next cold start; a host that hands over without closing admission is asked as before.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { idleHandoverOutcome } from "../../../src/modes/rpc/host-handover-request.ts";
import { clientRuntimeBuildId } from "../../../src/modes/rpc/host-outcome.ts";
import { observeProtocolInfo, probeProtocolInfo, requestOnSocket } from "../../../src/modes/rpc/host-probe.ts";

vi.mock("../../../src/modes/rpc/host-probe.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../src/modes/rpc/host-probe.ts")>();
	return { ...original, observeProtocolInfo: vi.fn(), probeProtocolInfo: vi.fn(), requestOnSocket: vi.fn() };
});

const SPEC = { hostArgs: [], policy: { idleExitMs: 600_000 }, env: {} };

beforeEach(() => {
	vi.clearAllMocks();
});

// Both probes answer alike, so a CLI from before this change reaches the same step and fails on the behaviour.
function serve(capabilities: readonly string[]): void {
	vi.mocked(observeProtocolInfo).mockResolvedValue(host(capabilities));
	vi.mocked(probeProtocolInfo).mockResolvedValue(host(capabilities));
}

function host(capabilities: readonly string[]) {
	return {
		protocolVersion: 1,
		serverVersion: "test",
		capabilities: [...capabilities],
		instanceId: "instance-1",
		generation: 4,
	};
}

async function ask() {
	const target = await clientRuntimeBuildId(SPEC);
	if (typeof target !== "string") throw new Error("this runtime has no build id to ask for");
	return idleHandoverOutcome({ socket: "/socket/rpc.sock", agentDir: "/agent" }, SPEC, {
		operationId: "op-unit",
		ifInstanceId: "instance-1",
		ifGeneration: 4,
		targetRuntimeBuildId: target,
	});
}

describe("a runtime-identity handover asked of a host that would close its admission", () => {
	it("is deferred without sending begin_handover", async () => {
		serve(["runtime_identity_handover"]);

		const outcome = await ask();

		expect(outcome.exitCode).toBe(3);
		expect(outcome.payload).toMatchObject({ reason: "migration_deferred" });
		expect(String((outcome.payload as { detail?: unknown }).detail)).toContain("legacy_predecessor_transfer");
		expect(vi.mocked(requestOnSocket)).not.toHaveBeenCalled();
	}, 60_000);

	it("is sent to a host that transfers strictly and never closes its admission", async () => {
		serve(["runtime_identity_handover", "strict_session_transfer_v1"]);
		vi.mocked(requestOnSocket).mockResolvedValue({
			operation_id: "op-unit",
			state: "handover_blocked",
			phase: "migration_deferred",
			reason: "rollout_disabled",
		});

		const outcome = await ask();

		expect(vi.mocked(requestOnSocket)).toHaveBeenCalledTimes(1);
		expect(outcome.payload).toMatchObject({ reason: "migration_deferred", detail: "rollout_disabled" });
	}, 60_000);
});
