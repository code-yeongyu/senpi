import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DETACH_CONNECTION_CAPABILITY } from "../../../src/modes/rpc/custom-capability.ts";
import { detachBeforeClose } from "../../../src/modes/rpc/host-session-detach.ts";
import { runHostSessionRequest } from "../../../src/modes/rpc/host-session-runner.ts";
import { RpcClient } from "../../../src/modes/rpc/rpc-client.ts";
import { REQUEST_DEADLINE_MS } from "../../../src/modes/rpc/rpc-request-deadline.ts";

type Command = { readonly id?: string; readonly type: string };
type FakeHostOptions = {
	readonly capabilities: readonly string[];
	readonly answerDetach: boolean;
	readonly unanswered?: readonly string[];
};

/**
 * A multi-session host reduced to what `senpi host session` touches. Like the real host, it releases a closed
 * connection's attachments asynchronously; here that release waits until the test lets it, which makes the
 * window between "the client returned" and "the host dropped the attachment" deterministic.
 */
class FakeHost {
	readonly commands: string[] = [];
	private readonly attachments = new Map<Socket, number>();
	private readonly heldCloses: Array<() => void> = [];
	private readonly closeWaiters: Array<() => void> = [];
	private readonly commandWaiters: Array<{ readonly type: string; readonly notify: () => void }> = [];
	private readonly server: Server;
	readonly socketPath: string;
	private readonly options: FakeHostOptions;
	private constructor(socketPath: string, options: FakeHostOptions) {
		this.socketPath = socketPath;
		this.options = options;
		this.server = createServer((socket) => this.accept(socket));
	}

	static async start(dir: string, options: FakeHostOptions): Promise<FakeHost> {
		const host = new FakeHost(join(dir, "rpc.sock"), options);
		await new Promise<void>((resolve, reject) => {
			host.server.once("error", reject);
			host.server.listen(host.socketPath, () => {
				host.server.off("error", reject);
				resolve();
			});
		});
		return host;
	}

	attachmentCount(): number {
		return [...this.attachments.values()].reduce((sum, count) => sum + count, 0);
	}

	nextClose(): Promise<void> {
		return new Promise((resolve) => this.closeWaiters.push(resolve));
	}

	received(type: string): Promise<void> {
		return new Promise((notify) => this.commandWaiters.push({ type, notify }));
	}

	releaseClosedConnections(): void {
		for (const release of this.heldCloses.splice(0)) release();
	}

	async stop(): Promise<void> {
		this.releaseClosedConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private accept(socket: Socket): void {
		let buffered = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			for (let index = buffered.indexOf("\n"); index !== -1; index = buffered.indexOf("\n")) {
				const line = buffered.slice(0, index);
				buffered = buffered.slice(index + 1);
				if (line.trim() !== "") this.handle(socket, JSON.parse(line) as Command);
			}
		});
		socket.once("close", () => {
			this.heldCloses.push(() => this.attachments.delete(socket));
			for (const notify of this.closeWaiters.splice(0)) notify();
		});
		socket.on("error", () => {});
	}

	private handle(socket: Socket, command: Command): void {
		this.commands.push(command.type);
		for (const waiter of this.commandWaiters.filter((entry) => entry.type === command.type)) waiter.notify();
		if (this.options.unanswered?.includes(command.type)) return;
		const reply = (data?: unknown) =>
			socket.write(
				`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, ...(data === undefined ? {} : { data }) })}\n`,
			);
		switch (command.type) {
			case "get_protocol_info":
				return void reply({ protocolVersion: 1, capabilities: this.options.capabilities, mode: "multi" });
			case "list_sessions":
				return void reply({
					sessions: [{ sessionId: "rpc-1", cwd: "/work", status: "open", attachments: this.attachmentCount() }],
				});
			case "open_session":
				this.attachments.set(socket, (this.attachments.get(socket) ?? 0) + 1);
				return void reply({ sessionId: "rpc-1", state: { sessionId: "durable-1" }, attached: true });
			case "get_state":
				return void reply({ sessionId: "durable-1", isStreaming: false });
			case "detach_connection":
				if (!this.options.answerDetach) return;
				this.attachments.delete(socket);
				return void reply();
			default:
				return void reply();
		}
	}
}

const dirs: string[] = [];
const hosts: FakeHost[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const host of hosts.splice(0)) await host.stop();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fakeHost(options: FakeHostOptions): Promise<{ host: FakeHost; agentDir: string }> {
	const dir = mkdtempSync(join(tmpdir(), "hs-3238-"));
	dirs.push(dir);
	const host = await FakeHost.start(dir, options);
	hosts.push(host);
	return { host, agentDir: join(dir, "agent") };
}

async function connectedClient(socketPath: string): Promise<RpcClient> {
	const client = new RpcClient({ socketPath });
	await client.start();
	return client;
}

describe("a short-lived host session client releases its attachment before it returns (senpi#3238)", () => {
	it("#given a host that confirms detach #when a ref command returns #then no attachment is left behind", async () => {
		// given
		const { host, agentDir } = await fakeHost({ capabilities: [DETACH_CONNECTION_CAPABILITY], answerDetach: true });

		// when
		const outcome = await runHostSessionRequest({
			action: "state",
			ref: "rpc-1",
			target: { socket: host.socketPath, agentDir },
		});

		// then
		expect(outcome.exitCode).toBe(0);
		expect(host.attachmentCount()).toBe(0);
		expect(host.commands.slice(-2)).toEqual(["get_protocol_info", "detach_connection"]);
	});

	it("#given an older host without detach_connection #when a ref command returns #then it never sends the request and the close still releases", async () => {
		// given
		const { host, agentDir } = await fakeHost({ capabilities: [], answerDetach: false });
		const closed = host.nextClose();

		// when
		const outcome = await runHostSessionRequest({
			action: "state",
			ref: "rpc-1",
			target: { socket: host.socketPath, agentDir },
		});

		// then
		expect(outcome.exitCode).toBe(0);
		expect(host.commands).not.toContain("detach_connection");
		await closed;
		host.releaseClosedConnections();
		expect(host.attachmentCount()).toBe(0);
	});

	it("#given a host that stopped answering #when the command times out #then the client closes without asking for a detach", async () => {
		// given
		const { host, agentDir } = await fakeHost({
			capabilities: [DETACH_CONNECTION_CAPABILITY],
			answerDetach: true,
			unanswered: ["get_state"],
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const stateSent = host.received("get_state");

		// when
		const outcome = runHostSessionRequest({
			action: "state",
			ref: "rpc-1",
			target: { socket: host.socketPath, agentDir },
		});
		await stateSent;
		await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
		const result = await outcome;

		// then
		expect(result.payload).toMatchObject({ action: "error", reason: "host_error" });
		expect(String(result.payload.detail)).toContain("Timeout waiting for response to get_state");
		expect(host.commands.slice(host.commands.indexOf("get_state") + 1)).toEqual([]);
	});

	it("#given a host that never answers the detach #when the client closes #then it reports the missing answer once and still closes", async () => {
		// given
		const { host } = await fakeHost({ capabilities: [DETACH_CONNECTION_CAPABILITY], answerDetach: false });
		const client = await connectedClient(host.socketPath);
		const reports: string[] = [];

		// when
		await detachBeforeClose(client, (line) => reports.push(line), 50);
		await client.stop();

		// then
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain("did not confirm the detach within 50 ms");
	});

	it("#given a client whose connection is already gone #when it detaches #then nothing is reported", async () => {
		// given
		const { host } = await fakeHost({ capabilities: [DETACH_CONNECTION_CAPABILITY], answerDetach: true });
		const client = await connectedClient(host.socketPath);
		await client.stop();
		const reports: string[] = [];

		// when
		await detachBeforeClose(client, (line) => reports.push(line), 50);

		// then
		expect(reports).toEqual([]);
	});
});
