/**
 * senpi#4602: the supervisor writes its own milestones and relays its host child's on one pipe, but the two come
 * from different processes. On Windows the supervisor's internal probe connected before the relay had read the
 * host's `host_runtime`, so `internal_ready` reached the launcher first and failed the attempt. The reporter keeps
 * the launcher's phase order whatever order the two producers' bytes arrive in.
 */
import { once } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { startupReporter } from "../../src/modes/rpc/host-startup-beacon.ts";
import { newStartupAttempt, startupEventIngress } from "../../src/modes/rpc/host-startup-events.ts";
import { type StartupClock, startStartupController } from "../../src/modes/rpc/host-startup-policy.ts";
import { type StartupBinding, type StartupMilestone, startupEventLine } from "../../src/modes/rpc/host-startup-wire.ts";

const frozenClock: StartupClock = { now: () => 0, scheduleAt: () => undefined, cancel: () => {} };

function coordinatedStart() {
	const binding: StartupBinding = {
		attempt: newStartupAttempt(),
		endpoint: "/tmp/senpi-test/host.sock",
		instanceId: "instance-1",
		generation: 0,
		launchKind: "initial",
		predecessor: null,
	};
	const controller = startStartupController({ launchKind: "initial", clock: frozenClock });
	const supervisorIngress = startupEventIngress(controller, binding, "supervisor");
	const hostIngress = startupEventIngress(controller, binding, "host");
	const reporter = startupReporter((line) => {
		const frame: unknown = JSON.parse(line);
		const inner = typeof frame === "object" && frame !== null ? Reflect.get(frame, "line") : undefined;
		if (typeof inner === "string") hostIngress(inner);
		else supervisorIngress(line);
	});
	let supervisorSeq = 0;
	let hostSeq = 0;
	const child = new Readable({ read() {} });
	reporter.relay(child);
	return {
		controller,
		child,
		supervisor(milestone: StartupMilestone) {
			reporter.report(startupEventLine(binding, "supervisor", ++supervisorSeq, milestone), milestone);
		},
		async host(milestone: StartupMilestone) {
			const delivered = once(child, "data");
			child.push(startupEventLine(binding, "host", ++hostSeq, milestone));
			await delivered;
		},
	};
}

describe("supervisor startup reporter (senpi#4602)", () => {
	it("holds internal_ready until the host's host_runtime has been relayed", async () => {
		const start = coordinatedStart();
		start.supervisor("supervisor_bootstrap");
		start.supervisor("supervisor_setup");
		await start.host("host_bootstrap");
		// The host wrote host_runtime before it listened, but the supervisor's probe connected first.
		start.supervisor("internal_ready");
		start.supervisor("observer_ready");
		expect(start.controller.terminal).toBeUndefined();
		expect(start.controller.phase).toBe("host_runtime");
		await start.host("host_runtime");
		expect(start.controller.terminal).toBeUndefined();
		expect(start.controller.phase).toBe("public_published");
	});

	it("holds a host record relayed before the supervisor reported supervisor_setup", async () => {
		const start = coordinatedStart();
		start.supervisor("supervisor_bootstrap");
		await start.host("host_bootstrap");
		expect(start.controller.terminal).toBeUndefined();
		start.supervisor("supervisor_setup");
		expect(start.controller.phase).toBe("host_runtime");
		await start.host("host_runtime");
		start.supervisor("internal_ready");
		expect(start.controller.terminal).toBeUndefined();
		expect(start.controller.phase).toBe("observer_ready");
	});

	it("releases what it held when the relay ends, so the launcher still decides", async () => {
		const start = coordinatedStart();
		start.supervisor("supervisor_bootstrap");
		start.supervisor("supervisor_setup");
		await start.host("host_bootstrap");
		start.supervisor("internal_ready");
		expect(start.controller.terminal).toBeUndefined();
		const ended = once(start.child, "end");
		start.child.push(null);
		start.child.resume();
		await ended;
		expect(start.controller.terminal).toMatchObject({
			kind: "failed",
			cause: expect.objectContaining({ message: expect.stringContaining("internal_ready reported before") }),
		});
	});
});
