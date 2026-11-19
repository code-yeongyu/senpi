import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createPermissionP0Host } from "./permission-p0-host.ts";

// senpi#6683 / oh-my-openagent#13441: a turn parked on a permission prompt nobody answers must end on RPC `interrupt`,
// and must not keep the session from closing (`unload_session`, the close a remote client sends). Guards the RPC
// session-control contract: interrupt answers promptly, the prompt is cancelled, the gated call never runs.

type Host = Awaited<ReturnType<typeof createPermissionP0Host>>;

async function within<T>(work: Promise<T>, ms: number): Promise<{ value: T } | "timed_out"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<"timed_out">((resolve) => {
		timer = setTimeout(() => resolve("timed_out"), ms);
	});
	try {
		return await Promise.race([work.then((value) => ({ value })), expired]);
	} finally {
		clearTimeout(timer);
	}
}

describe("a turn parked on a permission prompt (senpi#6683)", () => {
	const hosts: Host[] = [];

	afterEach(async () => {
		while (hosts.length > 0) await hosts.pop()?.dispose();
	});

	async function parked(): Promise<{ host: Host; probe: string; sessionId: string }> {
		const host = await createPermissionP0Host();
		hosts.push(host);
		const probe = join(host.cwd, "probe.txt");
		const sessionId = await host.park({ name: "write", args: { path: probe, content: "probe" } });
		return { host, probe, sessionId };
	}

	it("interrupt ends the turn within 2 s, cancels the prompt and never runs the call", async () => {
		const { host, probe, sessionId } = await parked();
		const idle = host.next((frame) => frame.sessionId === sessionId && frame.type === "agent_idle");

		const reply = await within(host.send({ type: "interrupt", sessionId }), 2_000);
		const settled = await within(idle, 5_000);
		const state = await host.send({ type: "get_state", sessionId });

		expect({
			reply:
				reply === "timed_out"
					? reply
					: { success: reply.value?.success, interrupted: reply.value?.data?.interrupted },
			settled: settled === "timed_out" ? settled : "idle",
			pendingDialogs: state?.data?.pendingDialogs,
			wrote: existsSync(probe),
		}).toEqual({
			reply: { success: true, interrupted: true },
			settled: "idle",
			pendingDialogs: [],
			wrote: false,
		});
	}, 60_000);

	it("unload_session as a remote close sends it (interrupt, force, children: detach) unloads the session", async () => {
		const { host, probe, sessionId } = await parked();

		const reply = await within(
			host.send({ type: "unload_session", sessionId, interrupt: true, force: true, children: "detach" }),
			5_000,
		);

		expect({
			reply:
				reply === "timed_out" ? reply : { outcome: reply.value?.data?.outcome, reason: reply.value?.data?.reason },
			wrote: existsSync(probe),
		}).toEqual({ reply: { outcome: "unloaded", reason: undefined }, wrote: false });
	}, 60_000);

	it("unload_session without interrupt unloads a session whose turn only waits on the prompt", async () => {
		const { host, probe, sessionId } = await parked();

		const reply = await within(host.send({ type: "unload_session", sessionId }), 5_000);

		expect({
			reply:
				reply === "timed_out" ? reply : { outcome: reply.value?.data?.outcome, reason: reply.value?.data?.reason },
			wrote: existsSync(probe),
		}).toEqual({ reply: { outcome: "unloaded", reason: undefined }, wrote: false });
	}, 60_000);

	// senpi#6684 review L1: a running tool can open a dialog (an MCP elicitation) while another call of its batch still
	// works. That run is not parked: without `interrupt` the unload must refuse and leave the work running.
	it("unload_session without interrupt refuses turn_active while another call of the batch is executing", async () => {
		const work = Promise.withResolvers<void>();
		const working = Promise.withResolvers<void>();
		let workAborted = false;
		const tools: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "long_work",
				label: "Long work",
				description: "Works until the test releases it.",
				parameters: Type.Object({}),
				async execute(_id, _params, signal) {
					signal?.addEventListener(
						"abort",
						() => {
							workAborted = true;
							work.resolve();
						},
						{ once: true },
					);
					working.resolve();
					await work.promise;
					return { content: [{ type: "text", text: "worked" }], details: {} };
				},
			});
			pi.registerTool({
				name: "ask_choice",
				label: "Ask choice",
				description: "Asks the user to pick an option while it runs.",
				parameters: Type.Object({}),
				async execute(_id, _params, _signal, _onUpdate, ctx) {
					const picked = await ctx.ui.select("Pick one", ["a", "b"]);
					return { content: [{ type: "text", text: picked ?? "none" }], details: {} };
				},
			});
		};
		const host = await createPermissionP0Host([tools]);
		hosts.push(host);
		const asked = host.next((frame) => frame.type === "extension_ui_request" && frame.title === "Pick one");
		const { sessionId, sent } = await host.begin(undefined, [
			{ id: "work-call", name: "long_work", args: {} },
			{ id: "dialog-call", name: "ask_choice", args: {} },
		]);
		await Promise.all([working.promise, asked]);

		const reply = await within(host.send({ type: "unload_session", sessionId }), 5_000);
		const refusal = {
			reply:
				reply === "timed_out" ? reply : { outcome: reply.value?.data?.outcome, reason: reply.value?.data?.reason },
			workAborted,
		};

		const idle = host.next((frame) => frame.sessionId === sessionId && frame.type === "agent_idle");
		work.resolve();
		await host.send({ type: "interrupt", sessionId });
		await sent;
		const settled = await within(idle, 10_000);
		const unloaded = await host.send({ type: "unload_session", sessionId });

		expect({
			...refusal,
			settled: settled === "timed_out" ? settled : "idle",
			unloaded: unloaded?.data?.outcome,
		}).toEqual({
			reply: { outcome: "refused", reason: "turn_active" },
			workAborted: false,
			settled: "idle",
			unloaded: "unloaded",
		});
	}, 60_000);
});
