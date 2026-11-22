import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { answerProtocolInfo } from "./helpers/rpc-legacy-protocol.ts";

// senpi#3811: a task runner driving a host-session child needs typed client calls for the run controls, so it can
// pause, resume and relay guidance without a raw-command escape hatch.

type Request = { id: string; type: string } & Record<string, unknown>;

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function fakeHost(answer: (request: Request) => Record<string, unknown>) {
	const directory = mkdtempSync(join(tmpdir(), "rpc-run-controls-"));
	const socketPath = join(directory, "rpc.sock");
	const requests: Request[] = [];
	const server = createServer((socket: Socket) => {
		let buffered = "";
		socket.on("data", (chunk) => {
			buffered += chunk.toString();
			for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
				const request = JSON.parse(buffered.slice(0, newline)) as Request;
				buffered = buffered.slice(newline + 1);
				if (answerProtocolInfo(socket, request)) continue;
				requests.push(request);
				socket.write(
					`${JSON.stringify({ type: "response", id: request.id, command: request.type, ...answer(request) })}\n`,
				);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const client = new RpcClient({ socketPath });
	await client.start();
	cleanups.push(() => {
		void client.stop();
		server.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return { client, requests };
}

describe("senpi#3811 RpcClient run controls", () => {
	it("sends pause_for_run, resume_for_run and hold_input with their fields and returns the answers", async () => {
		const { client, requests } = await fakeHost((request) => {
			if (request.type === "pause_for_run") return { success: true, data: { held: true, childSeq: 4 } };
			if (request.type === "resume_for_run") return { success: true, data: { released: true, turnId: "7" } };
			return { success: true, data: { entryId: "e1", duplicate: false } };
		});
		const runRef = { kind: "dag", id: "r1" } as const;

		const paused = await client.pauseForRun({ parentSessionId: "p", parentPauseSeq: 2, runRef });
		const held = await client.holdInput({
			inputId: "g-1",
			revision: 0,
			text: "Use staging",
			parentSessionId: "p",
			origin: "human",
		});
		const resumed = await client.resumeForRun({
			parentSessionId: "p",
			parentPauseSeq: 2,
			resumeId: "rs-1",
			childSeqCutoff: 4,
		});

		expect(paused).toEqual({ held: true, childSeq: 4 });
		expect(held).toEqual({ entryId: "e1", duplicate: false });
		expect(resumed).toEqual({ released: true, turnId: "7" });
		expect(requests.map(({ id: _id, ...rest }) => rest)).toEqual([
			{ type: "pause_for_run", parentSessionId: "p", parentPauseSeq: 2, runRef },
			{
				type: "hold_input",
				inputId: "g-1",
				revision: 0,
				text: "Use staging",
				parentSessionId: "p",
				origin: "human",
			},
			{ type: "resume_for_run", parentSessionId: "p", parentPauseSeq: 2, resumeId: "rs-1", childSeqCutoff: 4 },
		]);
	});

	it("throws the engine's refusal instead of reporting a hold", async () => {
		const { client } = await fakeHost(() => ({
			success: false,
			error: "wrong_parent: this child is paused for another parent session",
		}));

		await expect(
			client.pauseForRun({ parentSessionId: "intruder", parentPauseSeq: 1, runRef: { kind: "dag", id: "r1" } }),
		).rejects.toThrow("wrong_parent");
	});
});
