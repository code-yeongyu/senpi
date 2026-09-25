import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { ExecuteToolError } from "../../src/core/extensions/types.ts";
import {
	createRpcConnectionHandler,
	type RpcConnectionHandler,
	type RpcConnectionSink,
} from "../../src/modes/rpc/connection-handler.ts";
import { type ComputerUseHarness, callTool, createComputerUseHarness } from "./computer-use-harness.ts";

// Every case waits on real engine child-process I/O; the guard only catches a hang, it never times behavior.
const HANG_GUARD = { timeout: 30_000 };

type RpcRecord = Readonly<Record<string, unknown>>;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function runtimeHost(session: AgentSession): AgentSessionRuntime {
	const host: Pick<
		AgentSessionRuntime,
		"session" | "newSession" | "switchSession" | "fork" | "dispose" | "setRebindSession"
	> = {
		session,
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true, selectedText: "" }),
		dispose: async () => {},
		setRebindSession: () => {},
	};
	// The connection handler reads only these members of the runtime.
	return host as AgentSessionRuntime;
}

/** An rpc connection over the session; `next` resolves with the first later record matching `predicate`. */
function connect(session: AgentSession) {
	const waiters: { readonly predicate: (record: RpcRecord) => boolean; readonly resolve: (r: RpcRecord) => void }[] =
		[];
	const sink: RpcConnectionSink = {
		writeRaw: (chunk) => {
			for (const line of chunk.split("\n").filter(Boolean)) {
				const record: RpcRecord = JSON.parse(line);
				for (const waiter of waiters.filter((candidate) => candidate.predicate(record))) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve(record);
				}
			}
		},
		waitForBackpressure: async () => {},
	};
	const handler: RpcConnectionHandler = createRpcConnectionHandler(runtimeHost(session), sink);
	const next = (predicate: (record: RpcRecord) => boolean) =>
		new Promise<RpcRecord>((resolve) => waiters.push({ predicate, resolve }));
	/** Sends `/computer <args>` as an rpc `prompt` and resolves with the notification the command produced. */
	const command = async (args: string): Promise<string> => {
		const notified = next((record) => record.type === "extension_ui_request" && record.method === "notify");
		await handler.handleInputLine(JSON.stringify({ id: args, type: "prompt", message: `/computer ${args}` }));
		const notification = await notified;
		return String(notification.message);
	};
	return { handler, command };
}

async function rpcComputerUse(): Promise<{ computerUse: ComputerUseHarness; command(args: string): Promise<string> }> {
	const computerUse = await createComputerUseHarness({ bindTestUi: false });
	const { handler, command } = connect(computerUse.harness.session);
	cleanups.push(async () => {
		await handler.dispose();
		await computerUse.cleanup();
	});
	await handler.ready;
	return { computerUse, command };
}

describe("computer-use stop and resume over rpc", HANG_GUARD, () => {
	it("latches the stop path when /computer stop arrives as an rpc prompt", async () => {
		// Given
		const { computerUse, command } = await rpcComputerUse();
		await command("on");
		const stopped = computerUse.engine.nthRequest("stopPath.stop", 1);

		// When
		const reply = await command("stop");

		// Then
		expect({ sent: (await stopped).params, suspended: /suspended=true/.test(reply) }).toEqual({
			sent: { source: "host-relay" },
			suspended: true,
		});
	});

	it("lets the user resume over rpc with the service-held token", async () => {
		// Given
		const { computerUse, command } = await rpcComputerUse();
		await command("on");
		await command("stop");

		// When
		const reply = await command("resume");

		// Then
		expect({
			resumes: computerUse.methods().filter((method) => method === "stopPath.resume").length,
			lifted: /suspended=false/.test(reply),
		}).toEqual({ resumes: 1, lifted: true });
	});
});

describe("computer-use resume is unreachable from a tool call", HANG_GUARD, () => {
	it("rejects a model tool call asking the computer tool to resume", async () => {
		// Given
		const computerUse = await createComputerUseHarness();
		cleanups.push(() => computerUse.cleanup());
		await computerUse.command("on");
		await computerUse.command("stop");

		// When
		await callTool(computerUse.harness, "computer", { action: "resume" });

		// Then
		const result = [...computerUse.harness.session.messages]
			.reverse()
			.find((message) => message.role === "toolResult");
		expect({
			isError: result?.role === "toolResult" ? result.isError : undefined,
			resumed: computerUse.methods().includes("stopPath.resume"),
		}).toEqual({ isError: true, resumed: false });
	});

	it("rejects an eval-style tool.computer resume as invalid params", async () => {
		// Given
		const computerUse = await createComputerUseHarness();
		cleanups.push(() => computerUse.cleanup());
		await computerUse.command("on");

		// When
		const call = computerUse.harness.session.executeTool("computer", { action: "resume" });

		// Then
		await expect(call).rejects.toBeInstanceOf(ExecuteToolError);
		await expect(call).rejects.toMatchObject({ code: "invalid_params" });
	});
});
