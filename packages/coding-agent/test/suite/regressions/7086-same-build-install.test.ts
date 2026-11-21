/**
 * senpi#7086: an install of the SAME build never displaces the serving host while that host's own install is
 * still on disk (two live installs would otherwise hand the host back and forth), and replaces it once that install
 * is gone - still only at the host's next idle point. `host status` names the program a generation runs and
 * whether its install is still present. The CLI's report of an `already_current` refusal is owned by
 * `rpc-host-idle-handover-refusals.test.ts`.
 */
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { engineBuildIdentity } from "../../../src/core/engine-build-identity.ts";
import {
	type HandoverOutcome,
	HostIdleHandover,
	type IdleHandoverRequest,
} from "../../../src/modes/rpc/host-idle-handover.ts";
import { readHostStatus } from "../../../src/modes/rpc/host-status.ts";
import { signalGeneration } from "../../../src/modes/rpc/host-stop.ts";
import { loadedRuntimeSource } from "../../../src/modes/rpc/runtime-build-id.ts";
import { type GenerationScratch, reapProcessesUnder, waitForPidGone } from "../../helpers/rpc-generation-support.ts";
import { startHandoverRig } from "../../helpers/rpc-idle-handover-support.ts";

const BUILD = `sha256:${"a".repeat(64)}`;

function request(overrides: Partial<IdleHandoverRequest> = {}): IdleHandoverRequest {
	return {
		operationId: "op-1",
		ifInstanceId: "host-a",
		ifGeneration: 0,
		targetRuntimeBuildId: BUILD,
		launch: { command: "node", args: [] },
		hostArgs: [],
		env: {},
		targetEngine: engineBuildIdentity(),
		...overrides,
	};
}

function handover(options: {
	installPresent: boolean;
	idle: () => boolean;
	perform?: () => Promise<HandoverOutcome>;
}): { readonly handover: HostIdleHandover; readonly performed: () => number } {
	let performed = 0;
	const handover = new HostIdleHandover({
		identity: () => ({
			instanceId: "host-a",
			generation: 0,
			runtimeBuildId: BUILD,
			engine: engineBuildIdentity(),
			installPresent: options.installPresent,
		}),
		isIdle: options.idle,
		perform: async () => {
			performed++;
			return options.perform
				? options.perform()
				: { ok: true, successor: { pid: 2, instanceId: "host-b", generation: 1, runtimeBuildId: BUILD } };
		},
		pollMs: 60_000,
	});
	return { handover, performed: () => performed };
}

describe("an idle handover to the same build (senpi#7086)", () => {
	it("is refused already_current while the serving install is present, and nothing moves", async () => {
		const { handover: host, performed } = handover({ installPresent: true, idle: () => true });
		expect(await host.begin(request())).toMatchObject({ kind: "refused", reason: "already_current" });
		expect(performed()).toBe(0);
		expect(host.admits("prompt")).toBe(true);
		host.dispose();
	});

	it("hands over once the serving install is gone, at the host's idle point", async () => {
		let idle = false;
		const { handover: host, performed } = handover({ installPresent: false, idle: () => idle });
		expect(await host.begin(request())).toMatchObject({ kind: "operation", view: { state: "handover_pending" } });
		expect(performed()).toBe(0);
		expect(host.admits("prompt")).toBe(false);
		idle = true;
		host.observe();
		await Promise.resolve();
		await Promise.resolve();
		expect(performed()).toBe(1);
		expect(host.view()).toMatchObject({ state: "handover_completed", successor: { instanceId: "host-b" } });
		host.dispose();
	});

	it("keeps serving and admits work again when the successor for a gone install fails", async () => {
		const { handover: host } = handover({
			installPresent: false,
			idle: () => true,
			perform: async () => ({ ok: false, reason: "successor_unavailable: exited" }),
		});
		expect(await host.begin(request())).toMatchObject({
			kind: "operation",
			view: { state: "handover_blocked", reason: "successor_unavailable: exited" },
		});
		expect(host.admits("prompt")).toBe(true);
		host.dispose();
	});
});

const scratches: GenerationScratch[] = [];
const pids: number[] = [];
afterEach(async () => {
	for (const pid of pids.splice(0)) if (signalGeneration(pid, "SIGKILL")) await waitForPidGone(pid, 20_000);
	for (const qa of scratches.splice(0)) {
		await reapProcessesUnder(qa.root);
		await rm(qa.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}, 120_000);

describe.skipIf(process.platform === "win32")("host status of a real host (senpi#7086)", () => {
	it("names the program a generation runs and whether its install is present", async () => {
		const rig = await startHandoverRig("7086-same-build");
		scratches.push(rig.qa);
		pids.push(rig.firstPid);

		const status = await readHostStatus({ socket: rig.qa.socket, agentDir: rig.qa.agentDir });
		expect(status.instanceId).toBe(rig.instanceId);
		expect(status.generation).toBe(rig.generation);
		expect(status.binaryPath).toBe(loadedRuntimeSource().root);
		expect(status.installPresent).toBe(true);
		expect(status.engineVersion).toBe(engineBuildIdentity().text);
	});
});
