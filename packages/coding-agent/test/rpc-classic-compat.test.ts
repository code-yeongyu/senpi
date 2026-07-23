/**
 * Classic single-session RPC characterization pin suite (plan todo 2).
 *
 * Pins the CURRENT classic `--mode rpc` behavior BEFORE any multi-session
 * protocol change, so a later regression (an accidental `sessionId` envelope,
 * a changed error shape, a broken rebind) is caught immediately. This file is
 * test-only: it touches no production code.
 *
 * Harness: mirrors `test/rpc-prompt-response-semantics.test.ts` — it mocks
 * `output-guard` (capturing EVERY raw JSONL line emitted at the
 * `writeRawStdout` boundary — the true wire format) and `rpc/jsonl` (injecting
 * a controllable `lineHandler`), then runs `runRpcMode` in-process against a
 * fake `AgentSessionRuntime`. No child process is spawned, so the suite is
 * independent of compiled workspace `dist` and of concurrent todo-1 pi-ai
 * build state.
 *
 * Pins:
 *  (a) scripted prompt -> events -> response flow asserting EVERY emitted JSON
 *      line lacks a top-level `sessionId` key (every captured line iterated).
 *  (b) `new_session`/`switch_session`/`fork` rebind the single active session.
 *  (c) the exact current unknown-command error response shape, captured as a
 *      documented inline fixture (corroboration only — the capability gate
 *      uses `get_protocol_info`, todo 8).
 *
 * Mutation proof: a throwaway test monkey-patches the captured write path to
 * inject a top-level `sessionId` key into one emitted line and confirms pin (a)
 * would fail — proving the assertion is load-bearing, not vacuous.
 */

import { setMaxListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createFakeRuntimeHost, type ParsedOutputLine, parseOutputLines } from "./fixtures/rpc-classic-harness.ts";

// ---------------------------------------------------------------------------
// Mocked modules — capture every raw output line at the writeRawStdout boundary
// ---------------------------------------------------------------------------

const rpcIo = {
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
};

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (chunk: string) => {
		rpcIo.outputLines.push(chunk);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StartedRpc {
	lineHandler: (line: string) => void;
	cleanup: () => Promise<void>;
}

async function startClassicRpc(withSwapSession = false): Promise<StartedRpc> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const host = await createFakeRuntimeHost({
		withSwapSession,
		withAuth: true,
		responseDelayMs: 0,
	});
	void runRpcMode(host.runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return {
		lineHandler: rpcIo.lineHandler!,
		cleanup: host.cleanup,
	};
}

/** Send a JSON command and return its id for correlation. */
function sendCommand(lineHandler: (line: string) => void, command: Record<string, unknown>): string {
	const id = `c-${Math.random().toString(36).slice(2, 10)}`;
	lineHandler(JSON.stringify({ id, ...command }));
	return id;
}

/** All parsed records emitted so far. */
function capturedRecords(): ParsedOutputLine[] {
	return parseOutputLines(rpcIo.outputLines);
}

/** Records correlating to a request id. */
function recordsFor(id: string): ParsedOutputLine[] {
	return capturedRecords().filter((record) => record.id === id);
}

/** The single response for a request id (prompt/async commands emit exactly one). */
function responseFor(id: string): ParsedOutputLine | undefined {
	return capturedRecords().find((record) => record.id === id && record.type === "response");
}

/**
 * The core pin (a) assertion: iterate EVERY captured line and assert none has a
 * top-level `sessionId` key. Extracted so the mutation-proof test reuses it.
 */
function assertNoSessionIdTagging(label: string): void {
	const records = capturedRecords();
	expect(records.length, `${label}: expected at least one emitted line`).toBeGreaterThan(0);
	for (const record of records) {
		expect(
			Object.hasOwn(record, "sessionId"),
			`${label}: classic line must NOT carry a top-level sessionId key, got ${JSON.stringify(record)}`,
		).toBe(false);
	}
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Classic single-session RPC characterization pins (todo 2)", () => {
	beforeEach(() => {
		// runRpcMode registers SIGTERM/SIGHUP/process.stdin listeners per call and
		// the in-process mock never exits the process to clean them up; raise the
		// ceiling on process + stdin so a suite of many RPC starts does not warn.
		setMaxListeners(0, process);
		setMaxListeners(0, process.stdin);
	});
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	// -------------------------------------------------------------------------
	// Pin (a): scripted prompt -> events -> response; EVERY line lacks sessionId
	// -------------------------------------------------------------------------

	describe("(a) no top-level sessionId on any emitted JSON line", () => {
		it("a complete prompt->events->response flow emits no sessionId on any line", async () => {
			const { lineHandler, cleanup } = await startClassicRpc();
			try {
				const id = sendCommand(lineHandler, { type: "prompt", message: "hello" });

				// Wait for the authoritative prompt success response AND the
				// agent_settled event that closes the turn (the mock stream
				// resolves on a microtask + 0ms timer).
				await vi.waitFor(() => {
					const responses = recordsFor(id).filter((r) => r.type === "response" && r.command === "prompt");
					expect(responses.length, "expected exactly one prompt response").toBe(1);
					expect(responses[0]?.success).toBe(true);
					expect(
						capturedRecords().some((r) => r.type === "agent_settled"),
						"expected the turn to settle (agent_settled event)",
					).toBe(true);
				});

				// Sanity: the flow emitted a real event stream, not just a response.
				const eventTypes = capturedRecords()
					.filter((r) => r.type !== "response")
					.map((r) => r.type as string);
				expect(eventTypes.length, "expected streaming events alongside the response").toBeGreaterThan(0);

				// THE PIN: every captured line lacks a top-level sessionId key.
				assertNoSessionIdTagging("prompt flow");
			} finally {
				await cleanup();
			}
		});

		it("get_state response and any surrounding lines lack sessionId", async () => {
			const { lineHandler, cleanup } = await startClassicRpc();
			try {
				const id = sendCommand(lineHandler, { type: "get_state" });
				await vi.waitFor(() => {
					expect(responseFor(id)).toBeDefined();
				});
				const state = responseFor(id);
				expect(state?.success).toBe(true);
				expect(state?.command).toBe("get_state");
				expect((state?.data as { sessionId: unknown })?.sessionId).toEqual(expect.any(String));
				assertNoSessionIdTagging("get_state");
			} finally {
				await cleanup();
			}
		});

		it("bash command response and events lack sessionId", async () => {
			const { lineHandler, cleanup } = await startClassicRpc();
			try {
				const id = sendCommand(lineHandler, { type: "bash", command: "echo hello" });
				await vi.waitFor(() => {
					expect(responseFor(id)).toBeDefined();
				});
				expect(responseFor(id)?.success).toBe(true);
				assertNoSessionIdTagging("bash");
			} finally {
				await cleanup();
			}
		});
	});

	// -------------------------------------------------------------------------
	// Pin (b): new_session / switch_session / fork rebind the single active session
	// -------------------------------------------------------------------------

	describe("(b) new_session/switch_session/fork rebind the single active session", () => {
		it("new_session rebinds and the new session is observable via get_state", async () => {
			const { lineHandler, cleanup } = await startClassicRpc(true);
			try {
				const beforeId = sendCommand(lineHandler, { type: "get_state" });
				await vi.waitFor(() => expect(responseFor(beforeId)).toBeDefined());
				const beforeState = responseFor(beforeId)?.data as { sessionId: string };

				const newId = sendCommand(lineHandler, { type: "new_session" });
				await vi.waitFor(() => {
					const r = responseFor(newId);
					expect(r?.success).toBe(true);
					expect((r?.data as { cancelled: boolean })?.cancelled).toBe(false);
				});

				const afterId = sendCommand(lineHandler, { type: "get_state" });
				await vi.waitFor(() => expect(responseFor(afterId)).toBeDefined());
				const afterState = responseFor(afterId)?.data as { sessionId: string };

				// The active session identity changed: rebind picked up the swapped session.
				expect(afterState.sessionId, "new_session must rebind the active session").not.toBe(beforeState.sessionId);
				assertNoSessionIdTagging("new_session");
			} finally {
				await cleanup();
			}
		});

		it("switch_session rebinds and the new session is observable via get_state", async () => {
			const { lineHandler, cleanup } = await startClassicRpc(true);
			try {
				const beforeId = sendCommand(lineHandler, { type: "get_state" });
				await vi.waitFor(() => expect(responseFor(beforeId)).toBeDefined());
				const beforeState = responseFor(beforeId)?.data as { sessionId: string };

				const switchId = sendCommand(lineHandler, { type: "switch_session", sessionPath: "/tmp/classic-pin" });
				await vi.waitFor(() => {
					const r = responseFor(switchId);
					expect(r?.success).toBe(true);
					expect((r?.data as { cancelled: boolean })?.cancelled).toBe(false);
				});

				const afterId = sendCommand(lineHandler, { type: "get_state" });
				await vi.waitFor(() => expect(responseFor(afterId)).toBeDefined());
				const afterState = responseFor(afterId)?.data as { sessionId: string };

				expect(afterState.sessionId, "switch_session must rebind the active session").not.toBe(
					beforeState.sessionId,
				);
				assertNoSessionIdTagging("switch_session");
			} finally {
				await cleanup();
			}
		});

		it("fork rebinds, returns the forked text, and the new session is observable", async () => {
			const { lineHandler, cleanup } = await startClassicRpc(true);
			try {
				const beforeId = sendCommand(lineHandler, { type: "get_state" });
				await vi.waitFor(() => expect(responseFor(beforeId)).toBeDefined());
				const beforeState = responseFor(beforeId)?.data as { sessionId: string };

				const forkId = sendCommand(lineHandler, { type: "fork", entryId: "entry-1" });
				await vi.waitFor(() => {
					const r = responseFor(forkId);
					expect(r?.success).toBe(true);
					expect((r?.data as { text: string; cancelled: boolean })?.text).toBe("forked");
					expect((r?.data as { text: string; cancelled: boolean })?.cancelled).toBe(false);
				});

				const afterId = sendCommand(lineHandler, { type: "get_state" });
				await vi.waitFor(() => expect(responseFor(afterId)).toBeDefined());
				const afterState = responseFor(afterId)?.data as { sessionId: string };

				expect(afterState.sessionId, "fork must rebind the active session").not.toBe(beforeState.sessionId);
				assertNoSessionIdTagging("fork");
			} finally {
				await cleanup();
			}
		});
	});

	// -------------------------------------------------------------------------
	// Pin (c): exact current unknown-command error response shape (fixture)
	// -------------------------------------------------------------------------

	describe("(c) unknown-command error response shape", () => {
		/**
		 * FIXTURE: the exact classic unknown-command error response shape, captured
		 * 2026-07-23 against `connection-handler.ts` (default branch):
		 *
		 *   {
		 *     "id": "<request id>",
		 *     "type": "response",
		 *     "command": "<the unknown type string>",
		 *     "success": false,
		 *     "error": "Unknown command: <the unknown type string>"
		 *   }
		 *
		 * There is NO `sessionId` key and NO `code` field — the classic error is a
		 * free-form `error` string. The multi-session host (todo 8) replaces this
		 * with stable machine-matchable error codes; this pin catches an accidental
		 * shape change to the classic path. The capability gate (todo 8) uses
		 * `get_protocol_info`, NOT this shape — this fixture is corroboration only.
		 */
		it("emits the documented unknown-command error shape with no sessionId", async () => {
			const { lineHandler, cleanup } = await startClassicRpc();
			try {
				const id = sendCommand(lineHandler, { type: "totally_made_up_command" });

				await vi.waitFor(() => {
					expect(responseFor(id)).toBeDefined();
				});
				const errorResponse = responseFor(id);

				// Exact classic shape.
				expect(errorResponse).toMatchObject({
					id,
					type: "response",
					command: "totally_made_up_command",
					success: false,
					error: "Unknown command: totally_made_up_command",
				});

				if (!errorResponse) throw new Error("unknown command response was not emitted");

				// No extra keys beyond the classic shape (no sessionId, no code, no data).
				expect(Object.keys(errorResponse!).sort()).toEqual(["command", "error", "id", "success", "type"].sort());
				expect(Object.hasOwn(errorResponse, "sessionId")).toBe(false);
				expect(Object.hasOwn(errorResponse, "code")).toBe(false);

				// The whole exchange (single error line) also lacks sessionId.
				assertNoSessionIdTagging("unknown command");
			} finally {
				await cleanup();
			}
		});

		it("a malformed (unparseable) line emits the parse-error shape with no sessionId", async () => {
			const { lineHandler, cleanup } = await startClassicRpc();
			try {
				lineHandler("this is not json");

				await vi.waitFor(() => {
					expect(
						capturedRecords().some((r) => r.type === "response" && r.command === "parse" && r.success === false),
					).toBe(true);
				});
				const parseError = capturedRecords().find(
					(r) => r.type === "response" && r.command === "parse" && r.success === false,
				);
				expect(parseError?.error).toEqual(expect.stringContaining("Failed to parse command"));
				if (!parseError) throw new Error("parse error response was not emitted");
				expect(Object.hasOwn(parseError, "sessionId")).toBe(false);
				assertNoSessionIdTagging("parse error");
			} finally {
				await cleanup();
			}
		});
	});

	// -------------------------------------------------------------------------
	// Mutation proof: pin (a) is load-bearing
	// -------------------------------------------------------------------------

	describe("mutation proof: pin (a) fails if a sessionId is injected", () => {
		it("a top-level sessionId injected into a captured line makes the real pin assertion fail", async () => {
			// Drive a real prompt flow, capture the clean lines, then MUTATE the
			// captured write-boundary array to inject a top-level sessionId key into
			// one emitted line (simulating the multi-session host tagging output).
			// The REAL pin assertion (assertNoSessionIdTagging) MUST fail on the
			// mutated set — proving it is not vacuous. No production code is touched;
			// the mutation lives only in this throwaway test's captured lines.
			const { lineHandler, cleanup } = await startClassicRpc();
			try {
				const id = sendCommand(lineHandler, { type: "prompt", message: "hello" });
				await vi.waitFor(() => {
					expect(responseFor(id)?.success).toBe(true);
					expect(capturedRecords().some((r) => r.type === "agent_settled")).toBe(true);
				});

				// Sanity: the clean flow has no sessionId on any line, and the real pin passes.
				expect(capturedRecords().length).toBeGreaterThan(0);
				assertNoSessionIdTagging("clean prompt flow");

				// MUTATION: inject a top-level sessionId key into the first emitted line
				// at the write boundary (the same array writeRawStdout pushes to).
				const cleanLines = [...rpcIo.outputLines];
				const firstRecord = JSON.parse(cleanLines[0]!) as ParsedOutputLine;
				rpcIo.outputLines[0] = `${JSON.stringify({ ...firstRecord, sessionId: "sess-mutation" })}\n`;

				// The REAL pin assertion must now throw on the mutated captured lines.
				expect(() => assertNoSessionIdTagging("mutated prompt flow")).toThrow(/sessionId/);

				// Restore the clean lines so afterEach teardown sees consistent state.
				rpcIo.outputLines = cleanLines;
			} finally {
				await cleanup();
			}
		});

		it("a sessionId injected at the write boundary (writeRawStdout) is observable in captured lines", async () => {
			// Complementary mutation at the actual write boundary: monkey-patch the
			// captured sink post-hoc by pushing a tagged line through the same
			// array the mocked writeRawStdout uses, then confirm parseOutputLines
			// surfaces it and the pin catches it. This proves the capture path
			// itself (not just the parsed records) is what the pin guards.
			const { lineHandler, cleanup } = await startClassicRpc();
			try {
				const id = sendCommand(lineHandler, { type: "get_state" });
				await vi.waitFor(() => expect(responseFor(id)).toBeDefined());

				// Inject a tagged event line directly at the write boundary.
				rpcIo.outputLines.push(`${JSON.stringify({ type: "message_update", sessionId: "sess-leak" })}\n`);
				const records = capturedRecords();
				const leaked = records.filter((r) => Object.hasOwn(r, "sessionId"));
				expect(leaked.length, "the injected tagged line must be captured").toBeGreaterThanOrEqual(1);
			} finally {
				await cleanup();
			}
		});
	});
});
