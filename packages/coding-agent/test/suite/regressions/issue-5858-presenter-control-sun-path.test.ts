/**
 * senpi#5858: `startMcpPresenterControl` must not fail silently when the default control socket
 * path exceeds the platform `sun_path` limit. The start picks a temp root whose worst-case
 * control path fits (the OS temp directory, then /tmp - the same roots the host's internal hop
 * uses since senpi#3487), and any remaining failure logs a typed `presenter_control_unavailable:`
 * diagnostic on the host log, so an unavailable endpoint is never indistinguishable from
 * "no control was requested".
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PresenterAccountAuthority } from "../../../src/modes/rpc/mcp-presenter-account.ts";
import {
	type McpPresenterControlStart,
	startMcpPresenterControl,
} from "../../../src/modes/rpc/mcp-presenter-control-start.ts";
import { MAX_SOCKET_PATH_BYTES } from "../../../src/modes/rpc/socket-ownership.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";

const account: PresenterAccountAuthority = {
	hostAccount: () => "account",
	verify: async () => {
		throw new Error("the sun_path regression never verifies an attestation");
	},
	onAccountChange: () => () => {},
};

const started: McpPresenterControlStart[] = [];
afterEach(async () => {
	for (const { control, dir } of started.splice(0)) {
		control.dispose();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

async function withTmpdir(root: string, run: () => Promise<void>): Promise<void> {
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = root;
	try {
		await run();
	} finally {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
	}
}

it("a TMPDIR too deep for sun_path still starts the control endpoint on a short root", async () => {
	const deep = await mkdtemp(join(tmpdir(), "issue-5858-deep-"));
	const nested = join(deep, "n".repeat(80));
	await mkdir(nested);
	const tooDeep = join(nested, "senpi-presenter-xxxxxx", "control.sock");
	expect(Buffer.byteLength(tooDeep)).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);
	try {
		await withTmpdir(nested, async () => {
			const sole: string[] = [];
			const writer = new SessionEventWriter((chunk) => {
				sole.push(chunk);
			});
			const result = await startMcpPresenterControl(writer, { enforcement: true, account });
			expect(result).toBeDefined();
			if (!result) return;
			started.push(result);
			expect(Buffer.byteLength(result.control.path)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
			expect(result.control.path.startsWith(nested)).toBe(false);
		});
	} finally {
		await rm(deep, { recursive: true, force: true });
	}
});

it("a start that still fails logs a typed presenter_control_unavailable diagnostic instead of silence", async () => {
	const lines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: Uint8Array | string) => {
		lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return original(chunk);
	}) as typeof process.stderr.write);
	try {
		// /proc fits the length budget but refuses mkdir, so the start fails after root selection.
		await withTmpdir("/proc", async () => {
			const sole: string[] = [];
			const writer = new SessionEventWriter((chunk) => {
				sole.push(chunk);
			});
			const result = await startMcpPresenterControl(writer, { enforcement: true, account });
			expect(result).toBeUndefined();
		});
	} finally {
		stderr.mockRestore();
	}
	const diagnostic = lines.find((line) => line.startsWith("presenter_control_unavailable: "));
	expect(diagnostic).toBeDefined();
	expect(diagnostic).toContain(`limit ${MAX_SOCKET_PATH_BYTES} bytes`);
});
