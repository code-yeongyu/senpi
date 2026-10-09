import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionControlDrainResult, SessionControlWakeEvent } from "../src/core/extensions/types.ts";
import { type SubmissionTicket, TuiSessionControlHost } from "../src/modes/interactive/session-control-host.ts";
import { resolveTuiSocket } from "../src/modes/interactive/session-control-registry.ts";
import { WakeScheduler } from "../src/modes/interactive/session-control-wake.ts";
import { MAX_SOCKET_PATH_BYTES } from "../src/modes/rpc/socket-ownership.ts";
import { tuiSocketName } from "../src/modes/rpc/tui-socket.ts";
import { type EndpointFixture, startEndpoint } from "./helpers/session-control-fixture.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function owned(fixture: EndpointFixture): Promise<EndpointFixture> {
	cleanups.push(() => fixture.endpoint.dispose());
	return fixture;
}

async function ownedHarness(): Promise<Harness> {
	const harness = await createHarness({ persistSession: true });
	cleanups.push(() => harness.cleanup());
	return harness;
}

describe("WakeScheduler", () => {
	it("coalesces wakes that arrive during a pass into exactly one more pass", async () => {
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const passes: SessionControlWakeEvent[] = [];
		const scheduler = new WakeScheduler(
			async (event): Promise<SessionControlDrainResult> => {
				passes.push(event);
				if (passes.length === 1) {
					entered.resolve();
					await gate.promise;
				}
				return { admitted: [] };
			},
			(error) => {
				throw error;
			},
		);
		const first = scheduler.request("inbox");
		await entered.promise;
		const extra = [scheduler.request("inbox"), scheduler.request("submission"), scheduler.request("inbox")];
		gate.resolve();
		await Promise.all([first, ...extra]);
		expect(passes.map((pass) => pass.reasons)).toEqual([["inbox"], ["submission", "inbox"]]);
		expect(passes[1]?.reason).toBe("submission");
	});

	it("answers pending requests when disposed and runs nothing afterwards", async () => {
		const passes: SessionControlWakeEvent[] = [];
		const scheduler = new WakeScheduler(
			async (event) => {
				passes.push(event);
				return { admitted: [{ delivery_id: "x", kind: "started" }] };
			},
			() => undefined,
		);
		scheduler.dispose();
		expect(await scheduler.request("idle")).toEqual({ admitted: [] });
		expect(passes).toEqual([]);
	});
});

describe("TuiSessionControlHost submission tickets", () => {
	const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

	function host() {
		const control = new TuiSessionControlHost(() => {
			throw new Error("no endpoint in this test");
		});
		const buffered: Array<SubmissionTicket | undefined> = [];
		const received: unknown[][] = [];
		const editor: { onChange?: (text: string) => void; onSubmit?: (text: string, ...details: unknown[]) => void } = {
			onSubmit: (text, ...details) => {
				received.push([text, ...details]);
				if (!text.startsWith("/")) buffered.push(control.claimHandoff());
			},
		};
		control.attachEditor(editor, () => false);
		return { control, editor, buffered, received };
	}

	it("holds until the LAST buffered input is taken, whatever order the others are taken in", async () => {
		const { control, editor, buffered } = host();
		editor.onSubmit?.("first");
		editor.onSubmit?.("second");
		await nextMacrotask();
		expect(control.submissionInFlight()).toBe(true);
		buffered[0]?.release();
		expect(control.submissionInFlight()).toBe(true);
		buffered[1]?.release();
		buffered[1]?.release();
		expect(control.submissionInFlight()).toBe(false);
	});

	it("releases a submission no branch claimed as soon as the handler dispatched it", () => {
		const { control, editor } = host();
		editor.onSubmit?.("/name x");
		expect(control.submissionInFlight()).toBe(false);
	});

	it("forwards every onSubmit argument to the wrapped handler", () => {
		const { editor, received } = host();
		const details = { leadingWhitespace: " " };
		editor.onSubmit?.(" /literal", details);
		expect(received).toEqual([[" /literal", details]]);
	});

	it("holds while input is buffered outside the main loop", () => {
		const { control } = host();
		control.noteBufferedElsewhere(true);
		expect(control.submissionInFlight()).toBe(true);
		control.noteBufferedElsewhere(false);
		expect(control.submissionInFlight()).toBe(false);
	});
});

describe("control endpoint lifecycle", () => {
	it("the drain's own marker deletions cost at most one extra pass each, then silence", async () => {
		const harness = await ownedHarness();
		const fixture = await owned(
			await startEndpoint({
				harness,
				drain: () => {
					for (const name of readdirSync(fixture.inboxDir)) {
						if (name.startsWith("d-")) unlinkSync(join(fixture.inboxDir, name));
					}
					return undefined;
				},
			}),
		);
		for (let round = 0; round < 3; round++) {
			const marker = join(fixture.inboxDir, `d-${round}`);
			const drained = fixture.nextWake("inbox", () => existsSync(marker));
			writeFileSync(marker, "1");
			await drained;
			expect(existsSync(marker)).toBe(false);
			// Directory events arrive in order: the fence's pass comes after (or merges with) the one
			// the deletion caused, so passes between the drain and the fence bound what it costs.
			const before = fixture.wakes.length;
			const fence = join(fixture.inboxDir, `fence-${round}`);
			const fenced = fixture.nextWake("inbox", () => existsSync(fence));
			writeFileSync(fence, "1");
			await fenced;
			expect(fixture.wakes.length - before).toBeLessThanOrEqual(2);
		}
	});

	it("keeps a referenced header-only session file and removes an unreferenced one", async () => {
		for (const referenced of [true, false]) {
			const harness = await ownedHarness();
			const fixture = await startEndpoint({ harness, isSessionReferenced: () => referenced });
			const file = harness.sessionManager.getSessionFile() ?? "";
			expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
			await fixture.endpoint.dispose();
			expect(existsSync(file)).toBe(referenced);
		}
	});

	it("keeps the file after a delivery was applied, even when unreferenced", async () => {
		const harness = await ownedHarness();
		harness.setResponses([]);
		const fixture = await startEndpoint({ harness, isSessionReferenced: () => false });
		harness.sessionManager.appendCustomMessageEntry("session_control_delivery", "m1", true, { delivery_id: "d1" });
		await fixture.endpoint.dispose();
		expect(readFileSync(harness.sessionManager.getSessionFile() ?? "", "utf8")).toContain('"delivery_id":"d1"');
	});

	it("falls back to a private short root when the agent directory is too deep for sun_path", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-tui-deep-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const deep = join(root, "a".repeat(60), "b".repeat(60));
		const socket = await resolveTuiSocket(deep, "instance-1");
		cleanups.push(() => rmSync(join(socket, "..", ".."), { recursive: true, force: true }));
		expect(socket).toMatch(/^\/tmp\/senpi-rpc-[0-9a-f]{8}\/tui\/t-[0-9a-f]{16}\.sock$/);
		expect(socket.endsWith(tuiSocketName("instance-1"))).toBe(true);
		expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
		const shortRoot = mkdtempSync("/tmp/tui-");
		cleanups.push(() => rmSync(shortRoot, { recursive: true, force: true }));
		const shallow = await resolveTuiSocket(join(shortRoot, "agent"), "instance-1");
		expect(shallow).toBe(join(shortRoot, "agent", "rpc", "tui", tuiSocketName("instance-1")));
	});
});
