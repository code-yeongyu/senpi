/**
 * omo-desktop-app#4042: a declaration the session's binding could not take answers `client_capabilities_not_applied`,
 * session-scoped or not, and leaves the connection's declaration and record filter as they were, so the filter
 * never runs ahead of what the session asks with.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { RpcCommand, RpcResponse } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { inProcessRuntimeFactory } from "../rpc-inprocess-host-support.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function host() {
	const dir = await mkdtemp(join(tmpdir(), "senpi-4042-apply-"));
	directories.push(dir);
	const { createRuntime } = inProcessRuntimeFactory();
	const registry = new RpcSessionRegistry({ agentDir: dir, createRuntime });
	const writer = new SessionEventWriter(() => {});
	const binding = { failing: false, applied: [] as (readonly string[])[] };
	const router = new SessionCommandRouter(
		registry,
		writer,
		{ cwd: dir },
		async (sessionId, _entry, sink, _close, options) => ({
			// Before this fix a session-scoped set_client_info reached the binding, whose handler declared through
			// clientInfo without waiting and answered success on its own; this binding does the same.
			handle: async (command: object) => {
				const declared = command as { id?: string; type?: string; capabilities?: string[] };
				if (declared.type !== "set_client_info" || declared.capabilities === undefined) return;
				options?.clientInfo?.setCapabilities(sink.currentConnection(), declared.capabilities);
				sink.enqueue(sessionId, { id: declared.id, type: "response", command: "set_client_info", success: true });
			},
			dispose: async () => {},
			cancelPendingExtensionUiRequests: () => {},
			setCapabilities: async (capabilities: readonly string[]) => {
				if (binding.failing) throw new Error("the binding refused the set");
				binding.applied.push([...capabilities]);
			},
		}),
	);
	writer.registerConnection("a", { writeRaw: () => {}, waitForBackpressure: async () => {} });
	const send = (command: RpcCommand) =>
		writer.withConnection("a", () => router.handle(command)) as Promise<RpcResponse | undefined>;
	const opened = await send({ id: "open", type: "open_session", cwd: dir });
	if (opened !== undefined) throw new Error(`open failed: ${JSON.stringify(opened)}`);
	const sessionId = registry.list()[0]?.sessionId;
	if (sessionId === undefined) throw new Error("no session");
	return { writer, binding, send, sessionId };
}

it("a session-scoped set_client_info whose apply fails answers client_capabilities_not_applied", async () => {
	const { binding, send, sessionId } = await host();
	binding.failing = true;
	const answer = await send({
		id: "declare",
		type: "set_client_info",
		sessionId,
		width: 80,
		capabilities: ["question"],
	});
	expect(answer).toMatchObject({
		id: "declare",
		success: false,
		error: expect.stringContaining("client_capabilities_not_applied"),
	});
});

it("a failed apply leaves the connection's declaration and record filter as they were", async () => {
	const { writer, binding, send } = await host();
	expect(await send({ id: "first", type: "set_client_info", width: 80, capabilities: ["question"] })).toMatchObject({
		success: true,
	});
	expect(writer.getConnectionCapabilities("a")).toEqual(["question"]);

	binding.failing = true;
	const refused = await send({ id: "withdraw", type: "set_client_info", width: 80, capabilities: [] });
	expect(refused).toMatchObject({ success: false, error: expect.stringContaining("client_capabilities_not_applied") });
	expect(writer.getConnectionCapabilities("a")).toEqual(["question"]);

	binding.failing = false;
	expect(await send({ id: "retry", type: "set_client_info", width: 80, capabilities: [] })).toMatchObject({
		success: true,
	});
	expect(writer.getConnectionCapabilities("a")).toEqual([]);
	expect(binding.applied.at(-1)).toEqual([]);
});
