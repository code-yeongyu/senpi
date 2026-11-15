// senpi#6756: a hand loads its extensions with the placement the host built it for, the loader's `runs` filter follows
// that placement, and an extension reads it as `pi.placement`. A hosted hand (`twoSidedHome: "hand"`) is its
// extensions' home, so it keeps their `runs: "brain"` loop handlers; a split-local hand leaves them to the loop.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../../src/core/extensions/loader.ts";
import type { ExtensionPlacement } from "../../src/core/extensions/types.ts";
import type { TwoSidedHome } from "../../src/modes/rpc/loopless-tool-handlers.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { cleanupHands, handConfiguration, handDirs } from "./remote-hand-fixture.ts";

/** A user extension file: records its placement at compose time and every handler that fires, by declared side. */
const PLACEMENT_EXTENSION = `export default (pi) => {
	const record = (entry) => (globalThis.placementSeen ??= []).push(entry);
	record("placement " + pi.placement);
	pi.on("input", (event) => record("input(brain) " + event.text), { runs: "brain" });
	pi.on("tool_call", (event) => record("tool_call(brain) " + event.toolName), { runs: "brain" });
	pi.on("tool_call", (event) => record("tool_call(hand) " + event.toolName), { runs: "hand" });
};`;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	await cleanupHands();
	Reflect.deleteProperty(globalThis, "placementSeen");
});

const seen = (): string[] => (globalThis as { placementSeen?: string[] }).placementSeen ?? [];

async function startPlacementHand(twoSidedHome: TwoSidedHome) {
	const dirs = await handDirs(`placement-${twoSidedHome}`);
	const extension = join(dirs.scratch, "placement-ext.ts");
	writeFileSync(extension, PLACEMENT_EXTENSION);
	writeFileSync(join(dirs.cwd, "a.txt"), "x");
	const hand = createLooplessHand(handConfiguration(dirs, ["-e", extension]), { twoSidedHome });
	closers.push(() => hand.close());
	const readOnce = async () => {
		const scope = await hand.openScope({ id: "scope", root: dirs.cwd });
		await scope.run({
			name: "read",
			toolCallId: "t1",
			arguments: { path: join(dirs.cwd, "a.txt") },
			signal: new AbortController().signal,
			nested: () => Promise.reject(new Error("this loop serves no planes")),
		});
	};
	return { dirs, hand, readOnce };
}

describe("extension placement on a hand (senpi#6756)", () => {
	it("a hosted hand loads as hosted-hand and runs a runs: brain input handler for a forwarded input loop hook", async () => {
		// Given a hand built as its extensions' home, with a user extension whose input handler is declared for the loop.
		const { dirs, hand } = await startPlacementHand("hand");

		// When the hosted loop forwards an input loop hook to it.
		await hand.loopHooks("input", {
			inputId: "i1",
			text: "hello",
			source: "interactive",
			attribution: "user",
			idle: true,
			sessionId: "loop-session",
			scope: { id: "scope", root: dirs.cwd },
		});

		// Then the extension read its placement, and the loop-side handler ran here, where its home is.
		expect(seen()).toEqual(["placement hosted-hand", "input(brain) hello"]);
	});

	it("a hosted hand keeps both sides' tool_call handlers; a split-local hand drops the runs: brain one", async () => {
		const hosted = await startPlacementHand("hand");
		await hosted.readOnce();
		expect(seen()).toEqual(["placement hosted-hand", "tool_call(brain) read", "tool_call(hand) read"]);

		Reflect.deleteProperty(globalThis, "placementSeen");
		const splitLocal = await startPlacementHand("loop");
		await splitLocal.readOnce();
		expect(seen()).toEqual(["placement hand", "tool_call(hand) read"]);
	});

	it("an extension loaded with no placement named reads fused, and a named one reads it back", async () => {
		const read = async (placement: ExtensionPlacement | undefined): Promise<ExtensionPlacement> => {
			const placements: ExtensionPlacement[] = [];
			const result = await loadExtensions(["<placement-fixture>"], process.cwd(), undefined, undefined, {
				...(placement === undefined ? {} : { placement }),
				factoryResolver: () => (pi) => void placements.push(pi.placement),
			});
			expect(result.errors).toEqual([]);
			const [only] = placements;
			if (only === undefined || placements.length !== 1) throw new Error("expected one factory run");
			return only;
		};

		expect(await read(undefined)).toBe("fused");
		for (const placement of ["fused", "hand", "hosted-hand"] as const) expect(await read(placement)).toBe(placement);
	});
});
