/**
 * `wake` on a host session: the session-scoped command runs the drain an extension registered through
 * `pi.session.registerControlEndpoint` and answers what that pass admitted - the terminal endpoint's
 * contract. Driven through the real connection handler a host binds per session, over a harness
 * session with the faux provider; the unknown-session answer comes from the real router.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type {
	SessionControlAdmission,
	SessionControlRegistration,
	SessionControlWakeEvent,
} from "../../src/core/extensions/types.ts";
import { createRpcConnectionHandler, type RpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "./harness.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";

const HOST_SOCKET = "/tmp/senpi-wake-test/rpc/shards/p-0000000000000000.sock";

const harnesses: Harness[] = [];
const handlers: RpcConnectionHandler[] = [];
const scratches: string[] = [];

afterEach(async () => {
	while (handlers.length > 0) await handlers.pop()?.dispose();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	await Promise.all(scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Registrant {
	readonly registrations: SessionControlRegistration[];
	readonly wakes: SessionControlWakeEvent[];
	readonly observed: SessionControlWakeEvent[];
}

/**
 * A harness session bound the way a host binds it: a routing handle, and the host's public socket
 * in the launch profile's context. With `register`, its extension registers a control endpoint at
 * session_start whose drain admits every named delivery as a follow-up.
 */
async function hostSession(options: { readonly register: boolean; readonly hostSocket?: string }) {
	const registrant: Registrant = { registrations: [], wakes: [], observed: [] };
	const harness = await createHarness({
		persistSession: true,
		extensionFactories: [
			(pi) => {
				pi.on("session_control_wake", (event) => {
					registrant.observed.push(event);
				});
				if (!options.register) return;
				pi.on("session_start", async () => {
					const registration = await pi.session.registerControlEndpoint({
						inboxDir: join(harness.tempDir, "inbox"),
						drain: (event) => {
							registrant.wakes.push(event);
							const admitted: SessionControlAdmission[] = (event.delivery_ids ?? []).map((id) => ({
								delivery_id: id,
								kind: pi.session.admitExternalMessage({
									delivery_id: id,
									text: `from ${id}`,
									deliverAs: "followUp",
								}).kind,
							}));
							return { admitted };
						},
					});
					registrant.registrations.push(registration);
				});
			},
		],
	});
	harnesses.push(harness);
	const chunks: string[] = [];
	const runtimeHost = {
		session: harness.session,
		launchProfile:
			options.hostSocket === undefined
				? undefined
				: { cwd: harness.tempDir, sessionContext: { host_socket: options.hostSocket } },
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true, selectedText: "" }),
		dispose: async () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
	const handler = createRpcConnectionHandler(
		runtimeHost,
		{ writeRaw: (chunk) => chunks.push(chunk), waitForBackpressure: async () => {} },
		{ sessionId: "rpc-1", disposeRuntime: false },
	);
	handlers.push(handler);
	await handler.ready;
	const request = async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const id = `req-${chunks.length}`;
		await handler.handleInputLine(JSON.stringify({ ...command, id }));
		const records = chunks
			.join("")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const reply = records.find((record) => record.type === "response" && record.id === id);
		if (reply === undefined) throw new Error(`no response to ${String(command.type)}`);
		return reply;
	};
	return { harness, registrant, request };
}

describe("wake on a host session", () => {
	it("runs the registered drain and answers what it admitted, starting a turn on an idle session", async () => {
		// Given: an idle host session whose extension registered a drain.
		const host = await hostSession({ register: true, hostSocket: HOST_SOCKET });
		expect(host.registrant.registrations).toEqual([
			expect.objectContaining({ status: "registered", socket: HOST_SOCKET }),
		]);
		host.harness.setResponses([fauxAssistantMessage("answered d2")]);
		const idle = new Promise<void>((resolve) => {
			const unsubscribe = host.harness.session.subscribe((event) => {
				if (event.type !== "agent_idle") return;
				unsubscribe();
				resolve();
			});
		});

		// When: the host is woken for delivery d2.
		const reply = await host.request({ type: "wake", delivery_ids: ["d2"] });

		// Then: the reply is the drain's outcome, the pass named d2, and the delivery ran as a turn.
		expect(reply).toMatchObject({
			success: true,
			command: "wake",
			data: { admitted: [{ delivery_id: "d2", kind: "started" }] },
		});
		expect(host.registrant.wakes.at(-1)).toMatchObject({ reason: "command", delivery_ids: ["d2"] });
		await idle;
		const transcript = JSON.stringify(host.harness.sessionManager.getEntries());
		expect(transcript.match(/"delivery_id":"d2"/g)).toHaveLength(1);
	});

	it("answers admitted: [] with no drain registered, still emitting session_control_wake", async () => {
		// Given: a host session whose extension only listens for wakes.
		const host = await hostSession({ register: false, hostSocket: HOST_SOCKET });

		// When: it is woken.
		const reply = await host.request({ type: "wake", delivery_ids: ["d9"] });

		// Then: nothing was admitted and the extension saw exactly one command wake naming d9.
		expect(reply).toMatchObject({ success: true, data: { admitted: [] } });
		expect(host.registrant.observed).toEqual([
			{ type: "session_control_wake", reason: "command", reasons: ["command"], delivery_ids: ["d9"] },
		]);
	});

	it("registers nothing on a host with no public socket", async () => {
		const host = await hostSession({ register: true });
		expect(host.registrant.registrations).toEqual([{ status: "unsupported", reason: "unsupported_mode" }]);
		expect(await host.request({ type: "wake" })).toMatchObject({ success: true, data: { admitted: [] } });
	});

	it("answers unknown_session for a handle the router does not hold", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-wake-"));
		scratches.push(dir);
		await using rig = createInProcessRig(dir);
		const reply = await rig.router.handle({ type: "wake", id: "w", sessionId: "rpc-404", delivery_ids: ["d1"] });
		expect(reply).toMatchObject({ success: false, command: "wake", error: "unknown_session" });
	});
});
