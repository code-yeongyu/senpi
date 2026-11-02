import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { COMPACT_RECORD_MAX_BYTES } from "../../../src/modes/rpc/compact-event-leases.ts";
import type { WireRecord } from "../rpc-session-status-support.ts";
import {
	recordsOf,
	type StampHost,
	stalledCompactPeer,
	stampHost,
	stampsOf,
	streamEventOf,
	toolUse,
} from "./5346-stamp-host-support.ts";

// senpi#5346 review LOW (RULING-123): a keyed `toolcall_delta` a stalled compact peer has not read yet is superseded
// by the next delta and goes out in its delta-only form. That form must keep the call stamp whether the queued line was
// inline or an `eventLease` envelope (a record past the compact inline bound).

let run: StampHost | undefined;
afterEach(async () => {
	await run?.host[Symbol.asyncDispose]();
	run = undefined;
	vi.unstubAllEnvs();
});

/** 80,000-token chunks stream the large call's arguments as 320,000-character deltas, past the inline bound. */
const CHUNK_TOKENS = 80_000;
const deltaBytes = (record: WireRecord) => Buffer.byteLength(String(streamEventOf(record).delta));

it("RULING-123 review LOW #5346 a superseded toolcall_delta keeps its call stamp in its delta-only form, inline or leased", async () => {
	run = await stampHost({ min: CHUNK_TOKENS, max: CHUNK_TOKENS });
	const peer = stalledCompactPeer(run, "compact");
	await run.prompt([
		toolUse(
			fauxToolCall("read", { path: "small.txt" }, { id: "small" }),
			fauxToolCall("read", { path: "x".repeat(700_000) }, { id: "large" }),
		),
		fauxAssistantMessage("done", { timestamp: 1 }),
	]);
	peer.open();
	await run.host.writer.flush();
	const demoted = recordsOf(peer.writes, run.routing).filter(
		(record) =>
			record.type === "message_update" && record.message === null && streamEventOf(record).type === "toolcall_delta",
	);
	expect(
		demoted.filter((record) => deltaBytes(record) < 1024).length,
		"an inline delta was superseded",
	).toBeGreaterThan(0);
	expect(
		demoted.filter((record) => deltaBytes(record) >= COMPACT_RECORD_MAX_BYTES).length,
		"a leased delta was superseded",
	).toBeGreaterThan(0);
	for (const record of demoted)
		expect(stampsOf(record), `delta-only toolcall_delta of ${deltaBytes(record)} bytes`).toHaveLength(1);
}, 600_000);
