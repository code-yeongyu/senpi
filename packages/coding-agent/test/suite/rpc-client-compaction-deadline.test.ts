import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../../src/modes/rpc/jsonl.ts";
import { RpcClient, type RpcClientEvent, RpcTransportGoneError } from "../../src/modes/rpc/rpc-client.ts";
import {
	PROMPT_ACK_MAX_WAIT_MS,
	PROMPT_AFTER_QUEUED_DEADLINE_MS,
	PROMPT_COMPACTION_DEADLINE_MS,
	REQUEST_DEADLINE_MS,
} from "../../src/modes/rpc/rpc-request-deadline.ts";

// Captured before any test installs fake timers, so a lost event fails fast instead of hanging.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const EVENT_DELIVERY_BOUND_MS = 5_000;

async function createHost(autoOpenSessions = false) {
	const directory = await mkdtemp(join(tmpdir(), "rpc-compaction-deadline-"));
	const socketPath = join(directory, "rpc.sock");
	const connected = Promise.withResolvers<Socket>();
	const request = Promise.withResolvers<{ id: string; type: string; sessionId: string | undefined }>();
	let sessionNumber = 0;
	const server = createServer((socket) => {
		connected.resolve(socket);
		attachJsonlLineReader(socket, (line) => {
			const command: unknown = JSON.parse(line);
			if (
				typeof command !== "object" ||
				command === null ||
				!("id" in command) ||
				typeof command.id !== "string" ||
				!("type" in command) ||
				typeof command.type !== "string"
			) {
				throw new Error("Invalid client request");
			}
			if (autoOpenSessions && command.type === "open_session") {
				socket.write(
					serializeJsonLine({
						type: "response",
						id: command.id,
						command: "open_session",
						success: true,
						data: { sessionId: `session-${++sessionNumber}`, state: {} },
					}),
				);
				return;
			}
			const sessionId =
				"sessionId" in command && typeof command.sessionId === "string" ? command.sessionId : undefined;
			request.resolve({ id: command.id, type: command.type, sessionId });
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const client = new RpcClient({ socketPath });
	await client.start();
	const peer = await connected.promise;
	return {
		client,
		peer,
		request: request.promise,
		async emit(event: RpcClientEvent & { sessionId?: string }) {
			const seen = Promise.withResolvers<void>();
			const unsubscribe = client.onEvent((received) => {
				if (received.type === event.type) {
					unsubscribe();
					seen.resolve();
				}
			});
			peer.write(serializeJsonLine(event));
			const bound = realSetTimeout(() => {
				unsubscribe();
				seen.reject(new Error(`the client never delivered the ${event.type} event it was sent`));
			}, EVENT_DELIVERY_BOUND_MS);
			try {
				await seen.promise;
			} finally {
				realClearTimeout(bound);
			}
		},
		async close() {
			await client.stop();
			peer.destroy();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

describe("RpcClient prompt admission during compaction", () => {
	afterEach(() => vi.useRealTimers());

	test.each([
		{ timing: "before", requestId: "current-compaction" },
		{ timing: "during", requestId: "current-compaction" },
		{ timing: "during", requestId: undefined },
	])(
		"keeps the real acknowledgement authoritative when compaction starts $timing admission ($requestId)",
		async ({ timing, requestId }) => {
			// Given: a real socket client, with time controlled independently of the host.
			const host = await createHost();
			const preflight = vi.fn();
			const disposition = vi.fn();
			try {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				if (timing === "before") {
					await host.emit({ type: "compaction_start", reason: "threshold", requestId });
				}
				const prompt = host.client
					.prompt("request", { preflightResult: preflight, promptDisposition: disposition })
					.catch((error: unknown) => error);
				const { id } = await host.request;

				// When: preflight compaction takes longer than the ordinary 30-second wait.
				if (timing === "during") {
					await host.emit({ type: "compaction_start", reason: "threshold", requestId });
				}
				await vi.advanceTimersByTimeAsync(60_000);
				expect(preflight).not.toHaveBeenCalled();
				await host.emit({
					type: "compaction_end",
					reason: "threshold",
					requestId,
					result: undefined,
					aborted: false,
					willRetry: false,
				});
				host.peer.write(
					serializeJsonLine({
						type: "response",
						command: "prompt",
						id,
						success: true,
						data: { disposition: "queued" },
					}),
				);

				// Then: only the host's actual response admits the prompt, with its original disposition.
				expect(await prompt).toBe("queued");
				expect(preflight.mock.calls).toEqual([[true]]);
				expect(disposition.mock.calls).toEqual([["queued"]]);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				await host.close();
			}
		},
	);

	test("does not shorten an admission wait for another compaction's terminal event", async () => {
		// Given
		const host = await createHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const prompt = host.client.prompt("request").catch((error: unknown) => error);
			const { id } = await host.request;
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "current" });

			// When
			await host.emit({
				type: "compaction_end",
				reason: "threshold",
				requestId: "stale",
				result: undefined,
				aborted: false,
				willRetry: false,
			});
			await vi.advanceTimersByTimeAsync(60_000);
			host.peer.write(
				serializeJsonLine({
					type: "response",
					command: "prompt",
					id,
					success: true,
					data: { disposition: "queued" },
				}),
			);

			// Then
			expect(await prompt).toBe("queued");
		} finally {
			await host.close();
		}
	});

	test.each(["no compaction", "completed compaction", "non-prompt request"])(
		"retains the ordinary admission deadline for %s",
		async (scenario) => {
			// Given
			const host = await createHost();
			try {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				let settled = false;
				const operation = (
					scenario === "non-prompt request" ? host.client.getState() : host.client.prompt("request")
				)
					.catch((error: unknown) => error)
					.finally(() => {
						settled = true;
					});
				await host.request;
				if (scenario !== "no compaction") {
					await host.emit({ type: "compaction_start", reason: "threshold", requestId: "current" });
				}
				if (scenario === "completed compaction") {
					await vi.advanceTimersByTimeAsync(60_000);
					expect(settled).toBe(false);
					await host.emit({
						type: "compaction_end",
						reason: "threshold",
						requestId: "current",
						result: undefined,
						aborted: false,
						willRetry: false,
					});
				}

				// When
				await vi.advanceTimersByTimeAsync(30_000);

				// Then
				expect(settled).toBe(true);
				expect(await operation).toBeInstanceOf(Error);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				await host.close();
			}
		},
	);

	test("does not extend admission for a foreign session's compaction", async () => {
		// Given
		const host = await createHost();
		const preflight = vi.fn();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const prompt = host.client.prompt("request", { preflightResult: preflight }).catch((error: unknown) => error);
			await host.request;

			// When: a following frame fences the ignored foreign event's delivery.
			host.peer.write(
				serializeJsonLine({
					type: "compaction_start",
					reason: "threshold",
					requestId: "foreign",
					sessionId: "another-session",
				}),
			);
			await host.emit({ type: "bash_start" });
			await vi.advanceTimersByTimeAsync(30_000);

			// Then
			expect(preflight.mock.calls).toEqual([[false]]);
			expect(await prompt).toBeInstanceOf(Error);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await host.close();
		}
	});

	test.each([true, false])("isolates prior lease deadlines (compacting=%s)", async (firstCompacts) => {
		// Given: one socket can retain several leases and their correlated requests.
		const host = await createHost(true);
		const preflight = vi.fn();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const first = await host.client.openSession({});
			if (firstCompacts) {
				await host.emit({
					type: "compaction_start",
					reason: "threshold",
					requestId: "first-operation",
					sessionId: first.sessionId,
				});
			}
			const prompt = host.client
				.prompt("first-session request", { preflightResult: preflight })
				.catch((error: unknown) => error);
			const { id, sessionId } = await host.request;
			expect(sessionId).toBe(first.sessionId);

			// When: only the new lease emits compaction events.
			const second = await host.client.openSession({});
			await host.emit({
				type: "compaction_start",
				reason: "threshold",
				requestId: "second-operation",
				sessionId: second.sessionId,
			});
			if (!firstCompacts) {
				await vi.advanceTimersByTimeAsync(30_000);

				// Then: an ordinary request keeps its original deadline.
				expect(preflight.mock.calls).toEqual([[false]]);
				expect(await prompt).toBeInstanceOf(Error);
				expect(vi.getTimerCount()).toBe(0);
				return;
			}
			await host.emit({
				type: "compaction_end",
				reason: "threshold",
				requestId: "second-operation",
				sessionId: second.sessionId,
				result: undefined,
				aborted: false,
				willRetry: false,
			});
			await vi.advanceTimersByTimeAsync(60_000);
			expect(preflight).not.toHaveBeenCalled();
			host.peer.write(
				serializeJsonLine({
					type: "response",
					command: "prompt",
					id,
					sessionId: first.sessionId,
					success: true,
					data: { disposition: "started" },
				}),
			);

			// Then: the original session's actual response still admits its outstanding prompt.
			expect(await prompt).toBe("started");
			expect(preflight.mock.calls).toEqual([[true]]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await host.close();
		}
	});

	test("bounds a compaction even if its start event is repeated", async () => {
		// Given
		const host = await createHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const prompt = host.client.prompt("request").catch((error: unknown) => error);
			await host.request;
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "current" });

			// When
			const firstStretch = Math.floor(PROMPT_COMPACTION_DEADLINE_MS / 2);
			await vi.advanceTimersByTimeAsync(firstStretch);
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "current" });
			await vi.advanceTimersByTimeAsync(PROMPT_COMPACTION_DEADLINE_MS - firstStretch - 1);
			let settled = false;
			void prompt.then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);

			// Then
			expect(settled).toBe(true);
			expect(await prompt).toBeInstanceOf(Error);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await host.close();
		}
	});

	test("keeps waiting while another compaction operation is still running after one ends", async () => {
		// Given: two compaction operations overlap while a prompt waits for admission.
		const host = await createHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			let settled = false;
			const prompt = host.client
				.prompt("request")
				.catch((error: unknown) => error)
				.finally(() => {
					settled = true;
				});
			await host.request;
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "first" });
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "second" });

			// When: only the first one ends.
			await host.emit({
				type: "compaction_end",
				reason: "threshold",
				requestId: "first",
				result: undefined,
				aborted: false,
				willRetry: false,
			});
			await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS * 2);

			// Then: the prompt is still waiting, and once the second ends the ordinary deadline returns.
			expect(settled).toBe(false);
			await host.emit({
				type: "compaction_end",
				reason: "threshold",
				requestId: "second",
				result: undefined,
				aborted: false,
				willRetry: false,
			});
			await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
			expect(settled).toBe(true);
			expect(await prompt).toBeInstanceOf(Error);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await host.close();
		}
	});

	test("stops extending later prompts once a compaction whose end never arrived is older than its budget", async () => {
		// Given: a compaction starts and its end is never delivered.
		const host = await createHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "lost-end" });
			await vi.advanceTimersByTimeAsync(PROMPT_COMPACTION_DEADLINE_MS);

			// When: a later prompt is sent.
			let settled = false;
			const prompt = host.client
				.prompt("request")
				.catch((error: unknown) => error)
				.finally(() => {
					settled = true;
				});
			await host.request;
			await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);

			// Then: it gets the ordinary deadline, not the compaction wait.
			expect(settled).toBe(true);
			expect(await prompt).toBeInstanceOf(Error);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await host.close();
		}
	});

	test("never waits past the per-prompt cap, however many compactions start and end", async () => {
		// Given: a prompt is waiting, and compaction operations keep starting and ending.
		const host = await createHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			let settled = false;
			const prompt = host.client
				.prompt("request")
				.catch((error: unknown) => error)
				.finally(() => {
					settled = true;
				});
			await host.request;
			await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS - 1);
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "first" });
			await vi.advanceTimersByTimeAsync(PROMPT_COMPACTION_DEADLINE_MS - REQUEST_DEADLINE_MS);
			await host.emit({
				type: "compaction_end",
				reason: "threshold",
				requestId: "first",
				result: undefined,
				aborted: false,
				willRetry: false,
			});
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "second" });

			// When: time reaches the cap measured from when the prompt was sent.
			await vi.advanceTimersByTimeAsync(PROMPT_ACK_MAX_WAIT_MS - PROMPT_COMPACTION_DEADLINE_MS);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);

			// Then: the prompt fails at the cap instead of starting a second full compaction wait.
			expect(settled).toBe(true);
			expect(await prompt).toBeInstanceOf(Error);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await host.close();
		}
	});

	test("rejects at once and clears the extended deadline when the transport disconnects", async () => {
		// Given
		const host = await createHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const prompt = host.client.prompt("request").catch((error: unknown) => error);
			await host.request;
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "current" });

			// When
			host.peer.destroy();

			// Then
			expect(await prompt).toBeInstanceOf(RpcTransportGoneError);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await host.close();
		}
	});
	test("an acknowledgement received during a compaction never shortens the compaction's wait (senpi#2871)", async () => {
		// Given: a prompt sent while a compaction runs, then acknowledged by the host
		const host = await createHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "current" });
			let settled = false;
			const prompt = host.client
				.prompt("request")
				.catch((error: unknown) => error)
				.finally(() => {
					settled = true;
				});
			const { id } = await host.request;
			await host.emit({ type: "queued", for_request: id, position: 1, in_flight: 0 } as unknown as RpcClientEvent);

			// When: the compaction runs well past the acknowledged-prompt ceiling
			await vi.advanceTimersByTimeAsync(PROMPT_AFTER_QUEUED_DEADLINE_MS + 60_000);

			// Then: the prompt is still waiting, and the host's answer admits it
			expect(settled).toBe(false);
			host.peer.write(
				serializeJsonLine({
					type: "response",
					command: "prompt",
					id,
					success: true,
					data: { disposition: "started" },
				}),
			);
			expect(await prompt).toBe("started");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await host.close();
		}
	});

	test("an acknowledged prompt keeps its own ceiling, not the request deadline, once a compaction ends (senpi#2871)", async () => {
		// Given: an acknowledged prompt whose session then compacts and finishes compacting
		const host = await createHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			let settled = false;
			const prompt = host.client
				.prompt("request")
				.catch((error: unknown) => error)
				.finally(() => {
					settled = true;
				});
			const { id } = await host.request;
			await host.emit({ type: "queued", for_request: id, position: 1, in_flight: 0 } as unknown as RpcClientEvent);
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "current" });
			await host.emit({
				type: "compaction_end",
				reason: "threshold",
				requestId: "current",
				result: undefined,
				aborted: false,
				willRetry: false,
			});

			// When: more than the request deadline passes, then the rest of the acknowledged ceiling
			await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS * 2);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(PROMPT_AFTER_QUEUED_DEADLINE_MS - REQUEST_DEADLINE_MS * 2);

			// Then: it fails at the acknowledged ceiling, saying the host received it
			expect(settled).toBe(true);
			expect(String(await prompt)).toContain("prompt was received by the host but not accepted");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await host.close();
		}
	});
	test("an acknowledged prompt whose session then compacts past its ceiling keeps the compaction's wait (senpi#2871)", async () => {
		// Given: the host acknowledged the prompt, then its session starts compacting
		const host = await createHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			let settled = false;
			const prompt = host.client
				.prompt("request")
				.catch((error: unknown) => error)
				.finally(() => {
					settled = true;
				});
			const { id } = await host.request;
			await host.emit({ type: "queued", for_request: id, position: 1, in_flight: 0 } as unknown as RpcClientEvent);
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "current" });

			// When: the compaction outlasts the acknowledged-prompt ceiling
			await vi.advanceTimersByTimeAsync(PROMPT_AFTER_QUEUED_DEADLINE_MS + 60_000);

			// Then: the prompt is still waiting, and the host's answer admits it
			expect(settled).toBe(false);
			host.peer.write(
				serializeJsonLine({
					type: "response",
					command: "prompt",
					id,
					success: true,
					data: { disposition: "started" },
				}),
			);
			expect(await prompt).toBe("started");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await host.close();
		}
	});
});
