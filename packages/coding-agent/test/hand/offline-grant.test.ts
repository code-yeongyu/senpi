// S27b (brain/hand split, R14.b): a hand runs a peer's call only when the peer holds `execute` toward it for the call's
// workspace, checked offline from the installed grant snapshot before anything of the call is recorded, opened or run.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRAIN, grant, grantHarness, HAND, outcome, snapshotOf } from "./offline-grant-fixture.ts";
import { cleanupHands } from "./remote-hand-fixture.ts";

const dirs: string[] = [];
afterEach(async () => {
	await cleanupHands();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspaceDir(): string {
	const scratch = mkdtempSync(join(tmpdir(), "senpi-s27b-"));
	dirs.push(scratch);
	const root = join(scratch, "ws");
	mkdirSync(root);
	return realpathSync(root);
}

async function firstOutcome(snapshot: ReturnType<typeof snapshotOf> | undefined, options: { now?: () => number } = {}) {
	const root = workspaceDir();
	const hand = grantHarness({ workspaces: [{ root }], ...(snapshot ? { snapshot } : {}), ...options });
	await hand.invoke(root);
	const [reply] = await hand.frameCount(1);
	return { hand, reply: outcome(reply) };
}

describe("a hand checks the sender's grant offline before a call runs (S27b)", () => {
	it("runs a call the peer holds execute for", async () => {
		const { hand, reply } = await firstOutcome(snapshotOf([grant()]));

		expect(reply).toBe("settled");
		expect(hand.ran).toHaveLength(1);
	});

	it("refuses a call with no grant before the ledger, the scope or the tool see it", async () => {
		const { hand, reply } = await firstOutcome(snapshotOf([]));

		expect(reply).toBe("refused:grant_missing");
		expect(hand.admitted).toEqual([]);
		expect(hand.opened).toEqual([]);
		expect(hand.ran).toEqual([]);
		expect(hand.executor.accepted()).toEqual([]);
	});

	it.each([
		["another target", grant({ target: "device-other" })],
		["another workspace", grant({ workspace: "other" })],
		["the command capability", grant({ capability: "command" })],
		["another holder", grant({ holder: "device-other" })],
		["the swapped direction", grant({ holder: HAND, target: BRAIN })],
	])("refuses a grant for %s", async (_label, row) => {
		const { reply } = await firstOutcome(snapshotOf([row]));

		expect(reply).toBe("refused:grant_missing");
	});

	it("refuses every call once the snapshot reaches its expiry, and with no snapshot at all", async () => {
		const atExpiry = await firstOutcome(snapshotOf([grant()], 1_000), { now: () => 1_000 });
		const before = await firstOutcome(snapshotOf([grant()], 1_000), { now: () => 999 });
		const none = await firstOutcome(undefined);

		expect(atExpiry.reply).toBe("refused:grant_expired");
		expect(before.reply).toBe("settled");
		expect(none.reply).toBe("refused:grant_expired");
	});

	it("applies a replaced snapshot to the next call, and ignores a rolled-back one", async () => {
		const root = workspaceDir();
		const hand = grantHarness({ workspaces: [{ root }], snapshot: snapshotOf([grant()], undefined, 2) });

		await hand.invoke(root);
		await hand.frameCount(1);
		hand.verifier.install(snapshotOf([], undefined, 3));
		await hand.invoke(root);
		await hand.frameCount(2);
		hand.verifier.install(snapshotOf([grant()], undefined, 1));
		await hand.invoke(root);
		const replies = (await hand.frameCount(3)).map(outcome);

		expect(replies).toEqual(["settled", "refused:grant_missing", "refused:grant_missing"]);
	});

	it("aborts a running call whose grant a replaced snapshot removes", async () => {
		const root = workspaceDir();
		const hand = grantHarness({
			workspaces: [{ root }],
			snapshot: snapshotOf([grant()], undefined, 1),
			body: (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
		});
		const running = hand.runStarted();

		const id = await hand.invoke(root);
		await running;
		hand.verifier.install(snapshotOf([], undefined, 2));
		await hand.frameCount(1);

		expect(hand.aborted).toEqual([id]);
	});

	it("never runs a call whose grant is revoked after admission but before it starts", async () => {
		const root = workspaceDir();
		let open: () => void = () => {};
		const scopeGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const hand = grantHarness({ workspaces: [{ root }], snapshot: snapshotOf([grant()], undefined, 1), scopeGate });
		const opening = hand.scopeOpening();

		await hand.invoke(root);
		await opening;
		hand.verifier.install(snapshotOf([], undefined, 2));
		open();
		const [reply] = await hand.frameCount(1);

		expect(hand.ran).toEqual([]);
		expect(reply?.kind === "settled" && reply.result.isError).toBe(true);
	});

	it("refuses a snapshot whose revision or expiry is not a finite number, keeping the installed one", async () => {
		const root = workspaceDir();
		const hand = grantHarness({ workspaces: [{ root }], snapshot: snapshotOf([], 1_000, 1), now: () => 0 });

		expect(() => hand.verifier.install(snapshotOf([grant()], Number.NaN, 2))).toThrow();
		expect(() => hand.verifier.install(snapshotOf([grant()], undefined, Number.NaN))).toThrow();
		await hand.invoke(root);

		expect((await hand.frameCount(1)).map(outcome)).toEqual(["refused:grant_missing"]);
	});

	it("needs no grant for the hand's own device", async () => {
		const root = workspaceDir();
		const hand = grantHarness({ workspaces: [{ root }], peer: HAND });

		await hand.invoke(root);

		expect((await hand.frameCount(1)).map(outcome)).toEqual(["settled"]);
	});

	it("never takes the session's own word: a sessionRef naming a granted peer does not stand in for a grant", async () => {
		const root = workspaceDir();
		const hand = grantHarness({ workspaces: [{ root }], snapshot: snapshotOf([grant()]), peer: "device-other" });

		await hand.invoke(root, BRAIN);

		expect((await hand.frameCount(1)).map(outcome)).toEqual(["refused:grant_missing"]);
	});

	it("answers each call with exactly one frame: the check adds no round trip", async () => {
		const root = workspaceDir();
		const hand = grantHarness({ workspaces: [{ root }], snapshot: snapshotOf([grant()]) });

		await hand.invoke(root);
		await hand.invoke(root);
		await hand.frameCount(2);
		await hand.invoke(root);
		const frames = await hand.frameCount(3);

		expect(frames.map((frame) => frame.kind)).toEqual(["settled", "settled", "settled"]);
	});
});
