import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import { createIdentityHarness } from "./rpc-client-identity-harness.ts";

const WAIT_MS = 15_000;

// A background command that blocks on a loopback socket the test owns: its socket closes exactly when the process
// dies, so the test observes the stop with no sleeps or polling.
const WAITER_SOURCE = `const net = require("node:net");
const socket = net.connect(Number(process.argv[2]), "127.0.0.1");
socket.on("data", () => {});
`;

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not happen within ${WAIT_MS}ms`)), WAIT_MS);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(): Promise<{ port: number; nextConnection: () => Promise<Socket> }> {
	const server = createServer();
	const queued: Socket[] = [];
	const waiting: Array<(socket: Socket) => void> = [];
	server.on("connection", (socket) => {
		const next = waiting.shift();
		if (next) next(socket);
		else queued.push(socket);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("loopback server has no port");
	return {
		port: address.port,
		nextConnection: () => {
			const socket = queued.shift();
			if (socket) return Promise.resolve(socket);
			return new Promise((resolve) => waiting.push(resolve));
		},
	};
}

function closed(socket: Socket): Promise<void> {
	if (socket.destroyed) return Promise.resolve();
	return new Promise((resolve) => socket.once("close", () => resolve()));
}

async function setup(): Promise<{
	fixture: Fixture;
	waiter: string;
	port: number;
	nextConnection: () => Promise<Socket>;
}> {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	process.env.SENPI_PTY_FORCE_PIPE = "1";
	cleanups.push(() => {
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});
	const dir = mkdtempSync(join(tmpdir(), "senpi-interrupt-background-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const waiter = join(dir, "waiter.cjs");
	writeFileSync(waiter, WAITER_SOURCE);
	const { port, nextConnection } = await listen();
	const fixture = await createIdentityHarness({ extensionFactories: [registerTerminalExtension] });
	cleanups.push(async () => {
		await fixture.session.executeTool("kill_bash", { all: true });
		await fixture.cleanup();
	});
	await fixture.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	return { fixture, waiter, port, nextConnection };
}

function startWaiter(waiter: string, port: number, description: string, id: string) {
	return fauxAssistantMessage(
		fauxToolCall(
			"bash",
			{ command: `"${process.execPath}" "${waiter}" ${port}`, description, run_in_background: true },
			{ id },
		),
		{ stopReason: "toolUse" },
	);
}

/** The turn's second model call (after its tool call) blocks until the turn is aborted, so the turn is still running. */
function holdSecondCallUntilAbort(fixture: Fixture): Promise<void> {
	const entered = Promise.withResolvers<void>();
	const stream = fixture.harness.agent.streamFunction;
	let calls = 0;
	fixture.harness.agent.streamFunction = async (model, context, options) => {
		calls += 1;
		if (calls === 1) return stream(model, context, options);
		fixture.harness.agent.streamFunction = stream;
		entered.resolve();
		await new Promise<void>((resolve) => {
			if (options?.signal?.aborted) resolve();
			else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return stream(model, context, options);
	};
	return entered.promise;
}

function countAgentStarts(fixture: Fixture): { readonly count: () => number } {
	let count = 0;
	const unsubscribe = fixture.session.subscribe((event) => {
		if (event.type === "agent_start") count += 1;
	});
	cleanups.push(unsubscribe);
	return { count: () => count };
}

describe.skipIf(process.platform === "win32")("RPC interrupt stops the interrupted turn's background jobs", () => {
	it("stops the background bash the turn started, names it, and its exit starts no turn", async () => {
		const { fixture, waiter, port, nextConnection } = await setup();
		const rpc = fixture.bind();
		fixture.harness.setResponses([startWaiter(waiter, port, "turn waiter", "bg-1"), fauxAssistantMessage("held")]);
		const held = holdSecondCallUntilAbort(fixture);
		const connection = nextConnection();
		await rpc.send({ type: "prompt", message: "start it", clientMessageId: "start" });
		const socket = await withTimeout(connection, "the background waiter connecting");
		await withTimeout(held, "the turn's second model call");
		const turnId = fixture.session.currentTurnId;
		expect(turnId).toBeDefined();
		const starts = countAgentStarts(fixture);

		const answer = await rpc.send({ type: "interrupt", background: "stop" });

		expect(answer).toMatchObject({
			success: true,
			data: {
				interrupted: true,
				turnId,
				background: { stopped: [{ kind: "bash", id: "bash_1", description: "turn waiter" }], failed: [] },
			},
		});
		await withTimeout(closed(socket), "the background waiter dying");
		await withTimeout(fixture.session.waitForSettledSessionWork(), "the session settling");
		expect(starts.count()).toBe(0);
		expect(fixture.session.isIdle).toBe(true);

		let nextContext: TranscriptContext | undefined;
		fixture.harness.setResponses([
			(context) => {
				nextContext = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await fixture.session.prompt("what happened?");
		expect(JSON.stringify(nextContext?.messages)).toContain(
			`Background terminal session bash_1 was stopped when turn ${turnId} was interrupted`,
		);
	});

	it("keeps a background bash an earlier turn started", async () => {
		const { fixture, waiter, port, nextConnection } = await setup();
		const rpc = fixture.bind();
		fixture.harness.setResponses([
			startWaiter(waiter, port, "earlier waiter", "bg-early"),
			fauxAssistantMessage("ok"),
		]);
		const earlierConnection = nextConnection();
		await fixture.session.prompt("start the earlier one");
		const earlier = await withTimeout(earlierConnection, "the earlier waiter connecting");

		fixture.harness.setResponses([startWaiter(waiter, port, "turn waiter", "bg-2"), fauxAssistantMessage("held")]);
		const held = holdSecondCallUntilAbort(fixture);
		const connection = nextConnection();
		await rpc.send({ type: "prompt", message: "start the second", clientMessageId: "second" });
		const socket = await withTimeout(connection, "the turn's waiter connecting");
		await withTimeout(held, "the turn's second model call");

		const answer = await rpc.send({ type: "interrupt", background: "stop" });

		expect(answer).toMatchObject({
			data: { interrupted: true, background: { stopped: [{ kind: "bash", id: "bash_2" }], failed: [] } },
		});
		await withTimeout(closed(socket), "the turn's waiter dying");
		expect(earlier.destroyed).toBe(false);
		const output = await fixture.session.executeTool("bash_output", { bash_id: "bash_1" });
		expect(JSON.stringify(output)).toContain("running");
	});

	it("answers an idle session with an empty stop list", async () => {
		const { fixture } = await setup();
		const rpc = fixture.bind();
		expect(await rpc.send({ type: "interrupt", background: "stop" })).toMatchObject({
			success: true,
			data: { interrupted: false, background: { stopped: [], failed: [] } },
		});
	});

	it("leaves background jobs alone and answers as before without the field", async () => {
		const { fixture, waiter, port, nextConnection } = await setup();
		const rpc = fixture.bind();
		fixture.harness.setResponses([startWaiter(waiter, port, "turn waiter", "bg-3"), fauxAssistantMessage("held")]);
		const held = holdSecondCallUntilAbort(fixture);
		const connection = nextConnection();
		await rpc.send({ type: "prompt", message: "start it", clientMessageId: "start" });
		const socket = await withTimeout(connection, "the background waiter connecting");
		await withTimeout(held, "the turn's second model call");

		const answer = (await rpc.send({ type: "interrupt" })) as { data?: Record<string, unknown> };

		expect(answer.data).toMatchObject({ interrupted: true });
		expect(answer.data).not.toHaveProperty("background");
		expect(socket.destroyed).toBe(false);
		const output = await fixture.session.executeTool("bash_output", { bash_id: "bash_1" });
		expect(JSON.stringify(output)).toContain("running");
	});
});
