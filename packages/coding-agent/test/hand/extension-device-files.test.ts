// senpi#5839: an extension reaches the device's files through its context. On a fused session (and on a hand's own
// runtime) that is the local filesystem; on the loop side of a split session it is the hand's file channel, so the
// operation lands on the hand's files through the hand's own tool_call handlers and never opens a file in the loop's
// process. A split-local hand shares the loop's disk, so the hand's handler record is what tells the two apart.
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { isLocalDeviceFiles } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { InlineExtension } from "../../src/core/extensions/types.ts";
import { gatePresence } from "../../src/modes/headless/presence-gates.ts";
import type { HeadlessPresence } from "../../src/modes/headless/presence.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { cleanupHands, handDirs, openLink, remoteHost, startHand } from "./remote-hand-fixture.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await cleanupHands();
});

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function handlerRecorder(seen: string[], root: () => string): InlineExtension {
	return (pi) => {
		pi.on("tool_call", (event) => {
			const path = (event.input as { path?: unknown }).path;
			seen.push(`${event.toolName} ${typeof path === "string" ? relative(root(), path) : "?"}`);
			return undefined;
		});
	};
}

describe("an extension's device files (senpi#5839)", () => {
	it("on a fused session, writes to the local filesystem", async () => {
		const dirs = await handDirs("devfiles-fused");
		const harness = await createHarness();
		harnesses.push(harness);
		const context = harness.getExtensionRunner().createContext();

		await context.deviceFiles?.write(join(dirs.cwd, "note.md"), encode("fused"));

		expect(await readFile(join(dirs.cwd, "note.md"), "utf8")).toBe("fused");
	});

	it("on the loop side of a split session, goes through the hand's file channel and its handlers", async () => {
		const seen: string[] = [];
		const dirs = await handDirs("devfiles-split");
		const link = openLink();
		startHand(link, dirs, [handlerRecorder(seen, () => dirs.cwd)]);
		const harness = await createHarness();
		harnesses.push(harness);
		harness.agent.toolHost = remoteHost(link);
		harness.agent.executionScope = { id: `scope-${crypto.randomUUID()}`, root: dirs.cwd };
		const context = harness.getExtensionRunner().createContext();

		await context.deviceFiles?.write(join(dirs.cwd, "note.md"), encode("split"));
		const text = new TextDecoder().decode(await context.deviceFiles?.read(join(dirs.cwd, "note.md")));

		expect(text).toBe("split");
		expect(await readFile(join(dirs.cwd, "note.md"), "utf8")).toBe("split");
		expect(seen).toEqual(["write note.md", "read note.md"]);
	});

	it("tells the local filesystem of a fused session from a split session's file channel", async () => {
		const dirs = await handDirs("devfiles-brand");
		const link = openLink();
		startHand(link, dirs, []);
		const fused = await createHarness();
		const split = await createHarness();
		harnesses.push(fused, split);
		split.agent.toolHost = remoteHost(link);
		split.agent.executionScope = { id: `scope-${crypto.randomUUID()}`, root: dirs.cwd };

		const fusedFiles = fused.getExtensionRunner().createContext().deviceFiles;
		const splitFiles = split.getExtensionRunner().createContext().deviceFiles;

		expect(fusedFiles !== undefined && isLocalDeviceFiles(fusedFiles)).toBe(true);
		expect(splitFiles !== undefined && isLocalDeviceFiles(splitFiles)).toBe(false);
	});

	it("on a presence-gated split session, still goes through the hand's file channel", async () => {
		const seen: string[] = [];
		const dirs = await handDirs("devfiles-gated");
		const link = openLink();
		startHand(link, dirs, [handlerRecorder(seen, () => dirs.cwd)]);
		const harness = await createHarness();
		harnesses.push(harness);
		harness.agent.toolHost = remoteHost(link);
		harness.agent.executionScope = { id: `scope-${crypto.randomUUID()}`, root: dirs.cwd };
		const online = { ready: async () => {} } as unknown as HeadlessPresence;
		gatePresence(harness.agent, online, "session-gated");
		const context = harness.getExtensionRunner().createContext();

		await context.deviceFiles?.write(join(dirs.cwd, "note.md"), encode("gated"));

		expect(seen).toEqual(["write note.md"]);
	});
});
