/**
 * The inbox watch arms in the background: registration does not wait for the sentinel's event, and
 * once arming settles one more `inbox` pass runs, so an entry written after the first pass but before
 * the watch could see it is still drained. "Not armed yet" is forced by a watch that delivers nothing
 * until the test opens it, and never delivers the event of an entry written while it was deaf.
 */
import { vi } from "vitest";

const watchSeam = vi.hoisted(() => ({ deaf: false, missed: new Set<string>() }));

vi.mock("../../src/core/extensions/builtin/config-reload/watch-event-source.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../src/core/extensions/builtin/config-reload/watch-event-source.ts")>();
	return {
		...actual,
		createFsWatchEventSource: (...args: Parameters<typeof actual.createFsWatchEventSource>) => {
			const source = actual.createFsWatchEventSource(...args);
			return (...[path, listener, options]: Parameters<typeof source>) =>
				source(
					path,
					(eventType, filename) => {
						if (watchSeam.deaf || (filename !== null && watchSeam.missed.has(filename))) return;
						listener(eventType, filename);
					},
					options,
				);
		},
	};
});

import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionControlDrain, SessionControlWakeEvent } from "../../src/core/extensions/types.ts";
import { INBOX_ENGINE_ENTRY_PREFIX, watchInbox } from "../../src/modes/interactive/session-control-wake.ts";
import { controlData } from "../helpers/session-control-client.ts";
import { type EndpointFixture, startEndpoint } from "../helpers/session-control-fixture.ts";
import { within } from "../helpers/tui-endpoint-seams.ts";
import { createHarness, type Harness } from "./harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	watchSeam.deaf = false;
	watchSeam.missed.clear();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function ownedHarness(): Promise<Harness> {
	const harness = await createHarness({ persistSession: true });
	cleanups.push(() => harness.cleanup());
	return harness;
}

function owned(fixture: EndpointFixture): EndpointFixture {
	cleanups.push(() => fixture.endpoint.dispose());
	return fixture;
}

function deliveries(inboxDir: string): string[] {
	return readdirSync(inboxDir).filter((name) => !name.startsWith(INBOX_ENGINE_ENTRY_PREFIX));
}

describe.skipIf(process.platform === "win32")("tui endpoint: inbox watch arms after registration", () => {
	it("returns the registration and answers a wake while the watch is not armed yet", async () => {
		const harness = await ownedHarness();
		watchSeam.deaf = true;
		const fixture = owned(
			await within(
				startEndpoint({
					harness,
					drain: (event) => ({
						admitted: (event.delivery_ids ?? []).map((id) => ({ delivery_id: id, kind: "started" })),
					}),
				}),
				3_000,
				"registration while the inbox watch is not armed",
			),
		);
		expect(await controlData(fixture.socket, { type: "wake", delivery_ids: ["d-now"] })).toEqual({
			admitted: [{ delivery_id: "d-now", kind: "started" }],
		});
	});

	it("delivers a message that arrived after the first pass and before the watch was armed", async () => {
		const harness = await ownedHarness();
		const inboxDir = join(harness.tempDir, "inbox");
		const passes: string[][] = [];
		const firstPass = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<SessionControlWakeEvent>();
		const drain: SessionControlDrain = (event) => {
			const entries = deliveries(inboxDir);
			passes.push(entries);
			firstPass.resolve();
			if (!entries.includes("d-early")) return undefined;
			unlinkSync(join(inboxDir, "d-early"));
			delivered.resolve(event);
			return { admitted: [{ delivery_id: "d-early", kind: "started" }] };
		};
		watchSeam.deaf = true;
		owned(await within(startEndpoint({ harness, drain }), 10_000, "registration"));
		await within(firstPass.promise, 5_000, "the first inbox pass");

		watchSeam.missed.add("d-early");
		writeFileSync(join(inboxDir, "d-early"), "message");
		watchSeam.deaf = false;

		const event = await within(delivered.promise, 5_000, "the pass that drains the entry written before arming");
		expect(event.reasons).toContain("inbox");
		expect(passes).toEqual([[], ["d-early"]]);
		expect(deliveries(inboxDir)).toEqual([]);
	});

	it("stops arming quietly when the watch is stopped before it was confirmed", async () => {
		const inboxDir = await mkdtemp(join(tmpdir(), "senpi-inbox-arm-"));
		cleanups.push(() => rm(inboxDir, { recursive: true, force: true }));
		const errors: unknown[] = [];
		watchSeam.deaf = true;
		const watch = await watchInbox(
			inboxDir,
			() => undefined,
			(error) => errors.push(error),
		);
		watch.stop();
		await within(watch.armed, 1_000, "arming to settle after stop");
		expect(errors).toEqual([]);
		expect(await readdir(inboxDir)).toEqual([]);
	});
});
