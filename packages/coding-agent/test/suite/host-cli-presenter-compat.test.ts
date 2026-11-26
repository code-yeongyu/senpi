import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enrollmentRequest } from "../mcp/fixtures/presenter-enrollment.ts";
import { hostCloses, next, send } from "./host-cli-presenter-support.ts";
import { hostCliSandbox, onlyJsonLine, runHostCli, sweepHostCliSandboxes } from "./host-cli-support.ts";

afterEach(() => sweepHostCliSandboxes(), 120_000);

/** The running test's own signal: waits end on a host or channel event, or with the test (#4652). */
let signal: AbortSignal;

beforeEach((context) => {
	signal = context.signal;
});

// #4254: bootstrap refusal must not take ordinary RPC or the supervisor lifetime channel down.
describe.skipIf(process.platform === "win32")("presenter enrollment compatibility", () => {
	it("keeps an older launcher's host usable without silently enrolling v1", async () => {
		const qa = await hostCliSandbox("pl");
		const result = await runHostCli(
			qa,
			["ensure", "--mcp-presenter-enforcement", "--mcp-presenter-fd", "4"],
			{},
			async (socket) => {
				const unavailable = next(socket, "unavailable", signal);
				send(socket, enrollmentRequest({ version: 1 }));
				expect(await unavailable).toEqual({ type: "unavailable", versions: [2] });
			},
		);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(onlyJsonLine(result)).toMatchObject({ action: "start", reused: false });
		const status = await runHostCli(qa, ["status"]);
		expect(status.exitCode, status.stderr).toBe(0);
		expect(onlyJsonLine(status).instanceId).toBe(onlyJsonLine(result).instanceId);
	}, 120_000);

	it("refuses a replacement permit on an initial ensure route without killing the host", async () => {
		const qa = await hostCliSandbox("pk");
		const frames: string[] = [];
		const result = await runHostCli(
			qa,
			["ensure", "--mcp-presenter-enforcement", "--mcp-presenter-fd", "4"],
			{},
			async (socket) => {
				socket.on("data", (chunk) => frames.push(String(chunk)));
				const closed = hostCloses(socket, "the refused bootstrap channel", signal);
				send(socket, enrollmentRequest({ launchKind: "replacement", predecessorHostInstance: randomUUID() }));
				await closed;
			},
		);
		expect(frames).toEqual([]);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(onlyJsonLine(result)).toMatchObject({ action: "start", reused: false });
	}, 120_000);
});
