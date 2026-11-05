// S27a (R16.i, SC-R16 local leg): a hand does not know which session sent a call. Whatever the session says about
// itself (a reference, another one, none), the hand's results are identical, nothing about it reaches the tool, and the
// hand writes no transcript.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { decodeRemoteMessage, type Transport, type TransportSide } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import {
	cleanupHands,
	handDirs,
	openLink,
	remoteHost,
	runTurn,
	startHand,
	toolCall,
	toolResultTexts,
} from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

function echo(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "echo",
		label: "Echo",
		description: "Echoes its value and everything its context says about a session.",
		parameters: Type.Object({ value: Type.Number() }),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const session = "sessionManager" in ctx ? "session-visible" : "no-session";
			return {
				content: [{ type: "text", text: JSON.stringify({ toolCallId, value: params.value, session }) }],
				details: {},
			};
		},
	});
}

async function filesUnder(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
	return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

function tapped(hand: TransportSide, refs: Array<string | undefined>): Transport {
	return {
		send: (lane, payload) => hand.send(lane, payload),
		onFrame: (handler) =>
			hand.onFrame((frame) => {
				const message = decodeRemoteMessage(frame.payload);
				if (message.kind === "invoke") refs.push(message.sessionRef);
				return handler(frame);
			}),
		inFlight: (lane) => hand.inFlight(lane),
		close: () => hand.close(),
	};
}

describe("varied session info (S27a, R16.i)", () => {
	it("gives identical results for any session reference and writes no transcript", async () => {
		const dirs = await handDirs("r16");
		const results: string[][] = [];
		const sent: Array<string | undefined> = [];
		const refs = ["session-A", "session-B", undefined, "opaque:with/odd chars"];
		for (const sessionRef of refs) {
			const link = openLink();
			startHand({ hand: tapped(link.hand, sent) }, dirs, [echo]);
			const { agent } = await runTurn({
				calls: [toolCall("call-1", "echo", { value: 42 })],
				toolHost: remoteHost(link, sessionRef),
				root: dirs.cwd,
			});
			results.push(toolResultTexts(agent));
		}

		expect(sent).toEqual(refs);
		expect(results).toEqual(
			Array.from({ length: 4 }, () => ['{"toolCallId":"call-1","value":42,"session":"no-session"}']),
		);
		const files = [...(await filesUnder(dirs.agentDir)), ...(await filesUnder(dirs.cwd))];
		expect(files.filter((file) => file.endsWith(".jsonl"))).toEqual([]);
	});
});
