import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";
import { RpcClient, RpcCommandError } from "../src/modes/rpc/rpc-client.ts";
import { answerProtocolInfo } from "./helpers/rpc-legacy-protocol.ts";

type Answer = (command: Record<string, unknown>) => Record<string, unknown>;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function wireHost(answer: Answer) {
	const directory = await mkdtemp(join(tmpdir(), "rpc-set-session-context-"));
	const socketPath = join(directory, "rpc.sock");
	const received: Record<string, unknown>[] = [];
	const server: Server = createServer((socket) => {
		attachJsonlLineReader(socket, (line) => {
			const command = JSON.parse(line) as Record<string, unknown>;
			if (answerProtocolInfo(socket, command)) return;
			received.push(command);
			const base = { type: "response", id: command.id, command: command.type };
			if (command.type === "open_session") {
				socket.write(serializeJsonLine({ ...base, success: true, data: { sessionId: "rpc-7", state: {} } }));
				return;
			}
			socket.write(serializeJsonLine({ ...base, ...answer(command) }));
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const client = new RpcClient({ socketPath });
	await client.start();
	cleanups.push(async () => {
		await client.stop();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	return { client, received };
}

describe("RpcClient.setSessionContext", () => {
	it("sends set_session_context for the attached session with the patch as given", async () => {
		const { client, received } = await wireHost(() => ({ success: true }));
		await client.openSession({ cwd: "/work" });

		await client.setSessionContext({ task_status: "completed", run_epoch: 2, stale_key: null });

		const sent = received.find((command) => command.type === "set_session_context");
		expect(sent).toMatchObject({
			type: "set_session_context",
			sessionId: "rpc-7",
			patch: { task_status: "completed", run_epoch: 2, stale_key: null },
		});
	});

	it("targets an explicit session id when one is passed", async () => {
		const { client, received } = await wireHost(() => ({ success: true }));

		await client.setSessionContext({ task_status: "running" }, "rpc-9");

		expect(received.find((command) => command.type === "set_session_context")?.sessionId).toBe("rpc-9");
	});

	it("rejects with the host's error code when the connection is not attached", async () => {
		const { client } = await wireHost(() => ({
			success: false,
			error: "session_not_attached: this connection is not attached to that session",
			errorCode: "session_not_attached",
			errorData: { reason: "this connection is not attached to that session", action: "attach first" },
		}));

		const refused = client.setSessionContext({ task_status: "completed" }, "rpc-9");

		await expect(refused).rejects.toBeInstanceOf(RpcCommandError);
		await expect(refused).rejects.toMatchObject({ errorCode: "session_not_attached" });
	});

	it("refuses without a session with the host's session_not_attached error, sending nothing", async () => {
		const { client, received } = await wireHost(() => ({ success: true }));

		const refused = client.setSessionContext({ task_status: "completed" });

		await expect(refused).rejects.toBeInstanceOf(RpcCommandError);
		await expect(refused).rejects.toMatchObject({ errorCode: "session_not_attached" });
		expect(received.some((command) => command.type === "set_session_context")).toBe(false);
	});
});
