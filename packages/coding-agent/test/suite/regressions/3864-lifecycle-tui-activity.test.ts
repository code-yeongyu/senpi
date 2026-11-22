import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import type { SessionLifecycle } from "../../../src/core/session-lifecycle-types.ts";
import { ControlAttachments } from "../../../src/modes/interactive/session-control-attach.ts";
import type { ControlConnection } from "../../../src/modes/interactive/session-control-server.ts";
import { createHarness } from "../harness.ts";
import { nextSessionEvent, runToAgentIdle } from "../lifecycle-test-harness.ts";
import { makeSink } from "../rpc-connection-harness.ts";

it("delivers overlapping activity counts 1, 2, 1 through the bound TUI attachment writer", async () => {
	const gates = { a: Promise.withResolvers<void>(), b: Promise.withResolvers<void>() };
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				for (const name of ["a", "b"] as const)
					pi.registerTool({
						name,
						label: name,
						description: "Controlled parallel operation",
						parameters: Type.Object({}),
						execute: async () => {
							await gates[name].promise;
							return { content: [], details: {} };
						},
					});
			},
		],
	});
	let attachments: ControlAttachments | undefined;
	let run: Promise<unknown> | undefined;
	try {
		await h.session.bindExtensions({ mode: "tui" });
		attachments = new ControlAttachments(h.session, () => 0);
		const sink = makeSink();
		const connection: ControlConnection = { id: 1, transport: sink.sink, send: () => {} };
		attachments.opened(connection);
		attachments.attach(connection);
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("a", {}), fauxToolCall("b", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		const bothStarted = nextSessionEvent(
			h,
			(event) => event.type === "tool_execution_start" && event.toolName === "b",
		);
		run = runToAgentIdle(h, () => h.session.prompt("Run both."));
		await bothStarted;
		const ended = nextSessionEvent(h, (event) => event.type === "tool_execution_end" && event.toolName === "b");
		gates.b.resolve();
		await ended;
		await attachments.writer.flush();
		await attachments.writer.flushConnection("tui-1");
		const activity = sink
			.messages()
			.filter((record) => record.type === "session_lifecycle")
			.map((record) => record.lifecycle as SessionLifecycle)
			.filter((lifecycle) => lifecycle.activity?.kind === "tool");
		expect(
			activity.map((lifecycle) => lifecycle.activity?.kind === "tool" && lifecycle.activity.outstanding),
		).toEqual([1, 2, 1]);
		expect(activity.map((lifecycle) => lifecycle.seq)).toEqual(Array(3).fill(activity[0].seq));
		expect(activity.map((lifecycle) => lifecycle.activity?.since)).toEqual(
			Array(3).fill(activity[0].activity?.since),
		);
		const firstRevision = activity[0].activityRevision;
		expect(firstRevision).toBeDefined();
		expect(activity.map((lifecycle) => lifecycle.activityRevision)).toEqual(
			[0, 1, 2].map((offset) => ({
				instanceId: firstRevision?.instanceId,
				revision: (firstRevision?.revision ?? Number.NaN) + offset,
			})),
		);
	} finally {
		gates.a.resolve();
		gates.b.resolve();
		try {
			await run;
		} finally {
			attachments?.dispose();
			h.cleanup();
		}
	}
});
