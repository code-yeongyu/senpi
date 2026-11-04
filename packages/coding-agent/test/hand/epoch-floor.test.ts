// senpi#5729 (S35, R7.e): a session that moved to a new owner on the same hand fences its old owner. The new owner raises
// the hand's floor for the session's scope before it dispatches; afterwards the old owner's delayed turn never runs a
// tool there, while each owner's allowed turns run through the hand's real loopless runtime.
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHandEpochFence, createRemoteToolHost, HAND_SELF_SENDER } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { createLooplessHandScopes } from "../../src/modes/rpc/remote-executor-scope.ts";
import {
	cleanupHands,
	handConfiguration,
	handDirs,
	openLink,
	runTurn,
	startHandOn,
	toolCall,
	toolResultTexts,
} from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

function markerTool(cwd: string) {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "mark",
			label: "Mark",
			description: "Writes a marker file.",
			parameters: Type.Object({ file: Type.String() }),
			async execute(_toolCallId, params) {
				await writeFile(join(cwd, params.file), "ran\n");
				return { content: [{ type: "text", text: `marked ${params.file}` }], details: {} };
			},
		});
	};
}

describe("epoch floor on a hand (S35, R7.e)", () => {
	it("refuses a moved session's old owner: its tool never runs, the new owner's does", async () => {
		const dirs = await handDirs("epoch");
		const openScope = createLooplessHandScopes(handConfiguration(dirs), {
			extensionFactories: [markerTool(dirs.cwd)],
		});
		const fence = createHandEpochFence({ ownerOf: () => HAND_SELF_SENDER });
		const owner = (epoch: number) => {
			const link = openLink();
			startHandOn(link, openScope, fence);
			return createRemoteToolHost({ transport: link.brain, placement: "split-local", epoch });
		};
		const oldOwner = owner(1);
		const newOwner = owner(2);
		const turn = async (toolHost: ReturnType<typeof owner>, file: string) =>
			toolResultTexts(
				(
					await runTurn({
						calls: [toolCall(`call-${file}`, "mark", { file })],
						toolHost,
						root: dirs.cwd,
						scopeId: "scope-moving",
					})
				).agent,
			);

		const before = await turn(oldOwner, "old-before.txt");
		const moved = await turn(newOwner, "new.txt");
		const delayed = await turn(oldOwner, "old-after.txt");

		expect([before, moved, delayed]).toEqual([
			["marked old-before.txt"],
			["marked new.txt"],
			["The hand refused this tool call: epoch_fenced"],
		]);
		expect(["old-before.txt", "new.txt", "old-after.txt"].map((file) => existsSync(join(dirs.cwd, file)))).toEqual([
			true,
			true,
			false,
		]);
	});
});
