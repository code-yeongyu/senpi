import { afterEach, describe, expect, it, vi } from "vitest";
import { emit } from "../../../src/cli/host-emit.ts";

const PIPE_BUFFER_BYTES = 65536;

/** fd 1 as a non-blocking pipe with a 64 KiB buffer: a full buffer throws EAGAIN, otherwise a write takes at most 64 KiB. */
const pipe = vi.hoisted(() => ({ received: [] as Buffer[], full: false }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeSync: (fd: number, data: string | Uint8Array, offset?: number, ...rest: unknown[]) => {
			if (fd !== 1) return Reflect.apply(actual.writeSync, undefined, [fd, data, offset, ...rest]);
			if (pipe.full) {
				pipe.full = false;
				throw Object.assign(new Error("EAGAIN: resource temporarily unavailable, write"), { code: "EAGAIN" });
			}
			const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data).subarray(offset ?? 0);
			const taken = bytes.subarray(0, PIPE_BUFFER_BYTES);
			pipe.received.push(Buffer.from(taken));
			pipe.full = true;
			return taken.length;
		},
	};
});

afterEach(() => {
	pipe.received = [];
	pipe.full = false;
});

describe("issue 7096: host CLI answer larger than the pipe buffer", () => {
	it("writes the whole JSON line through short writes and EAGAIN", () => {
		const payload = { action: "read", text: "x".repeat(300_000) };

		emit(payload);

		const written = Buffer.concat(pipe.received).toString("utf8");
		expect(written.length).toBe(JSON.stringify(payload).length + 1);
		expect(JSON.parse(written)).toEqual(payload);
	});
});
