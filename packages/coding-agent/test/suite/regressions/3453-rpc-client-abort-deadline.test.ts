import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ABORT_DEFAULT_GRACE_MS, ABORT_MAX_GRACE_MS } from "../../../src/modes/rpc/abort-grace.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../../../src/modes/rpc/jsonl.ts";
import { RpcClient } from "../../../src/modes/rpc/rpc-client.ts";
import { REQUEST_DEADLINE_MS, requestDeadlineMs } from "../../../src/modes/rpc/rpc-request-deadline.ts";

async function abortHost() {
	const directory = await mkdtemp(join(tmpdir(), "rpc-abort-deadline-"));
	const socketPath = join(directory, "rpc.sock");
	const connected = Promise.withResolvers<Socket>();
	const abort = Promise.withResolvers<{ id: string }>();
	const server = createServer((socket) => {
		connected.resolve(socket);
		attachJsonlLineReader(socket, (line) => {
			const command = JSON.parse(line) as { id: string; type: string };
			if (command.type === "abort") abort.resolve({ id: command.id });
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const client = new RpcClient({ socketPath });
	await client.start();
	const peer = await connected.promise;
	return {
		client,
		abort: abort.promise,
		answer(id: string) {
			peer.write(
				serializeJsonLine({
					type: "response",
					command: "abort",
					id,
					success: true,
					data: { stopped: true, idle: true },
				}),
			);
		},
		async close() {
			await client.stop();
			peer.destroy();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

describe("RpcClient waits for an awaited abort as long as the host may take (senpi#3453)", () => {
	afterEach(() => vi.useRealTimers());

	test.each([
		{ graceMs: 45_000, waited: 45_000 },
		{ graceMs: undefined, waited: 10_000 },
	])(
		"abort({ awaitIdle, graceMs: $graceMs }) still gets the host's answer after $waited ms",
		async ({ graceMs, waited }) => {
			// Given: a socket host that answers the awaited abort only when its grace runs out
			const host = await abortHost();
			try {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				const answer = host.client
					.abort({ effectId: "stop-1", awaitIdle: true, ...(graceMs === undefined ? {} : { graceMs }) })
					.catch((error: unknown) => error);
				const { id } = await host.abort;

				// When: the grace (past the plain 30 s request deadline for 45 s) elapses before the host answers
				await vi.advanceTimersByTimeAsync(Math.max(waited, REQUEST_DEADLINE_MS) + 1_000);
				host.answer(id);

				// Then: the client was still waiting and returns the typed answer
				expect(await answer).toEqual({ stopped: true, idle: true });
			} finally {
				await host.close();
			}
		},
	);
});

describe("A graceMs the host would refuse leaves the client listening for that refusal (senpi#3453)", () => {
	afterEach(() => vi.useRealTimers());

	test.each([
		{ graceMs: undefined, deadline: ABORT_DEFAULT_GRACE_MS + REQUEST_DEADLINE_MS },
		{ graceMs: 0, deadline: REQUEST_DEADLINE_MS },
		{ graceMs: 45_000, deadline: 45_000 + REQUEST_DEADLINE_MS },
		{ graceMs: ABORT_MAX_GRACE_MS, deadline: ABORT_MAX_GRACE_MS + REQUEST_DEADLINE_MS },
		{ graceMs: -50_000, deadline: REQUEST_DEADLINE_MS },
		{ graceMs: -1, deadline: REQUEST_DEADLINE_MS },
		{ graceMs: ABORT_MAX_GRACE_MS + 1, deadline: REQUEST_DEADLINE_MS },
		{ graceMs: 1.5, deadline: REQUEST_DEADLINE_MS },
		{ graceMs: Number.NaN, deadline: REQUEST_DEADLINE_MS },
		{ graceMs: Number.POSITIVE_INFINITY, deadline: REQUEST_DEADLINE_MS },
		{ graceMs: 1e12, deadline: REQUEST_DEADLINE_MS },
	])("an awaited abort with graceMs $graceMs waits $deadline ms", ({ graceMs, deadline }) => {
		expect(requestDeadlineMs({ type: "abort", awaitIdle: true, graceMs })).toBe(deadline);
	});

	test.each([{ graceMs: -50_000 }, { graceMs: Number.NaN }, { graceMs: 1e12 }])(
		"abort({ awaitIdle, graceMs: $graceMs }) still receives the host's answer one second later",
		async ({ graceMs }) => {
			// Given: a host that answers one second after it receives the abort, as it does for a refusal
			const host = await abortHost();
			try {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				const answer = host.client
					.abort({ effectId: "stop-2", awaitIdle: true, graceMs })
					.catch((error: unknown) => error);
				const { id } = await host.abort;

				// When: one second passes before the answer
				await vi.advanceTimersByTimeAsync(1_000);
				host.answer(id);

				// Then: the client was still waiting, so the caller gets the host's answer, not a client timeout
				expect(await answer).toEqual({ stopped: true, idle: true });
			} finally {
				await host.close();
			}
		},
	);
});
