import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SessionEventFanout } from "../../../src/modes/rpc/session-event-fanout.ts";
import { SOCKET_CLOSING_CODES } from "../../../src/modes/rpc/socket-closing.ts";

// RULING-124 (#5322): every engine-initiated close of a peer goes through the one helper that announces it, and every
// code it can carry is documented with its `retryable` meaning. A new close site cannot skip it: a registered
// connection's transport has no close, and the registration's own close takes a classified code.

it("RULING-124 (d) a registered transport cannot be closed directly; the registration's close takes a code", () => {
	const fanout = new SessionEventFanout();
	let closed = 0;
	fanout.registerConnection("peer", {
		writeRaw: () => {},
		waitForBackpressure: async () => {},
		close: () => void closed++,
	});
	const registered = fanout.get("peer") ?? expect.unreachable("the connection is registered");
	expect(Object.keys(registered.connection).sort(), "no close reachable at runtime either").toEqual([
		"waitForBackpressure",
		"writeRaw",
	]);
	const skipping = () => {
		// @ts-expect-error RULING-124: a close that skips `socket_closing` does not compile.
		registered.connection.close?.();
		// @ts-expect-error RULING-124: an engine close names one of the documented codes.
		registered.close("unclassified");
	};
	expect(typeof skipping).toBe("function");
	registered.close("event_queue_failed");
	expect(closed, "a peer without compact events is still closed, with no record").toBe(1);
});

it("RULING-124 (c) docs/rpc.md lists exactly the socket_closing codes, each with its retryable value", () => {
	const docs = readFileSync(new URL("../../../docs/rpc.md", import.meta.url), "utf8");
	const start = docs.indexOf("(senpi#5322, RULING-124)");
	expect(start, "the socket_closing section exists").toBeGreaterThan(0);
	const section = docs.slice(start, docs.indexOf("\n#### ", start));
	const documented = Object.fromEntries(
		[...section.matchAll(/^\| `([a-z_]+)` \| `(true|false)` \|/gm)].map(([, code, retryable]) => [
			code,
			retryable === "true",
		]),
	);
	const registry = Object.fromEntries(
		Object.entries(SOCKET_CLOSING_CODES).map(([code, { retryable }]) => [code, retryable]),
	);
	expect(documented).toEqual(registry);
});
