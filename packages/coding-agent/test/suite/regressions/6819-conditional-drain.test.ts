import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { parseHostArgs } from "../../../src/cli/host-command.ts";
import { sessionQuestionBridges } from "../../../src/modes/rpc/connection-question-bridge.ts";
import { attach } from "../rpc-delegated-host-support.ts";
import { drainRig, expectAdmitting, expectRefused } from "./6819-conditional-drain-support.ts";

// senpi#6819: the host decides and closes admission together, without disturbing refused work.
it("drains an idle unattached generation and reaches its empty exit", async () => {
	await using rig = await drainRig();
	await rig.detach();
	expect(await rig.operator.send(rig.command)).toMatchObject({ success: true, data: { action: "drained" } });
	await rig.exited;
	expect(rig.core.router.sessionCount).toBe(0);
});

it("refuses an attached session without closing new connection or open admission", async () => {
	await using rig = await drainRig();
	await expectRefused(rig.operator, rig.command, "host_attached");
	await expectAdmitting(rig);
});

it("refuses a busy automatic turn and remains fully admitting", async () => {
	await using rig = await drainRig();
	await rig.detach();
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	rig.faux.setResponses([
		async () => {
			entered.resolve();
			await finish.promise;
			return fauxAssistantMessage("Finished.");
		},
	]);
	const running = rig.session.sendCustomMessage(
		{ customType: "senpi-monitor:event", content: "Work", display: false },
		{ triggerTurn: true },
	);
	try {
		await entered.promise;
		await expectRefused(rig.operator, rig.command, "host_busy");
		await expectAdmitting(rig);
	} finally {
		finish.resolve();
		await running;
	}
});

it("refuses a pending question even when no turn is streaming", async () => {
	await using rig = await drainRig();
	await rig.detach();
	const bridge = sessionQuestionBridges.get(rig.session);
	if (bridge === undefined) throw new Error("question bridge missing");
	const controller = new AbortController();
	const answering = bridge.ask(
		{
			requestId: "6819-question",
			waitForAnswer: true,
			timeoutMs: 60_000,
			questions: [
				{ id: "q", header: "Choice", question: "Continue?", options: [{ label: "Yes" }], multiSelect: false },
			],
		},
		{ signal: controller.signal },
	);
	try {
		expect(rig.session.isStreaming).toBe(false);
		await expectRefused(rig.operator, rig.command, "host_busy");
		await expectAdmitting(rig);
	} finally {
		controller.abort();
		await answering;
	}
});

it("refuses standalone bash while the session otherwise reports idle", async () => {
	await using rig = await drainRig();
	await rig.detach();
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<{ exitCode: number }>();
	const running = rig.session.executeBash("controlled command", undefined, {
		operations: {
			exec: () => {
				entered.resolve();
				return finish.promise;
			},
		},
	});
	try {
		await entered.promise;
		expect(rig.session.isStreaming).toBe(false);
		await expectRefused(rig.operator, rig.command, "host_busy");
		await expectAdmitting(rig);
	} finally {
		finish.resolve({ exitCode: 0 });
		await running;
	}
});

it.each(["isCompacting", "hasSessionWork"] as const)("refuses the engine activity signal %s", async (field) => {
	await using rig = await drainRig();
	await rig.detach();
	const snapshot = rig.session.activitySnapshot;
	const activity = vi.spyOn(rig.session, "activitySnapshot", "get").mockReturnValue({ ...snapshot, [field]: true });
	try {
		await expectRefused(rig.operator, rig.command, "host_busy");
		await expectAdmitting(rig);
	} finally {
		activity.mockRestore();
	}
});

it("refuses a different instance without redirecting or changing admission", async () => {
	await using rig = await drainRig();
	await rig.detach();
	await expectRefused(rig.operator, { ...rig.command, instanceId: "another-generation" }, "unknown_owner");
	await expectAdmitting(rig);
});

it.each(["attach-first", "drain-first"] as const)("serializes attachment admission: %s", async (order) => {
	await using rig = await drainRig();
	await rig.detach();
	const attaching = attach(rig.opened);
	const commands = order === "attach-first" ? [attaching, rig.command] : [rig.command, attaching];
	const [first, second] = await Promise.all(rig.operator.sendTogether(commands));
	if (order === "attach-first") {
		expect(first).toMatchObject({ success: true });
		expect(second).toMatchObject({
			success: true,
			data: { action: "refuse", reason: expect.stringMatching(/^host_(attached|busy)$/) },
		});
		expect(rig.core.router.sessionCount).toBe(1);
	} else {
		expect(first).toMatchObject({ success: true, data: { action: "drained" } });
		expect(second).toMatchObject({ success: false });
		await rig.exited;
	}
});

it("holds an automatic wake admitted after the conditional drain wins", async () => {
	await using rig = await drainRig();
	await rig.detach();
	rig.faux.setResponses([fauxAssistantMessage("Must not run.")]);
	expect(await rig.operator.send(rig.command)).toMatchObject({ success: true, data: { action: "drained" } });
	await rig.session.sendCustomMessage(
		{ customType: "senpi-monitor:event", content: "Late wake", display: false },
		{ triggerTurn: true },
	);
	expect(rig.faux.state.callCount).toBe(0);
	await rig.exited;
});

it.each([{ wait: [] }, { wait: ["--wait-ms", "1000"] }])(
	"parses the conditional named drain with optional wait $wait",
	({ wait }) => {
		expect(parseHostArgs(["stop", "--drain", "--instance", "generation", "--if-idle", ...wait])).toMatchObject({
			subcommand: "stop",
			drain: true,
			instanceId: "generation",
			ifIdle: true,
		});
	},
);

it.each([
	["stop", "--if-idle"],
	["stop", "--drain", "--if-idle"],
	["stop", "--drain", "--instance", "--if-idle"],
	["stop", "--instance", "generation", "--if-idle"],
	["status", "--drain", "--instance", "generation", "--if-idle"],
])("rejects incomplete conditional drain arguments %j", (...args) => {
	expect(typeof parseHostArgs(args)).toBe("string");
});
