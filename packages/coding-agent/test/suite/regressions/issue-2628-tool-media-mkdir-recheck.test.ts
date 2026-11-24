import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { persistToolImage, toolMediaRoot } from "../../../src/modes/rpc/tool-media-store.ts";

// senpi#2628: the first check cannot see a link introduced after mkdir.
it("refuses to write a tool image through a symlink introduced after mkdir", () => {
	const fixture = mkdtempSync(join(tmpdir(), "senpi-media-mkdir-recheck-"));
	try {
		const scope = { sessionDir: join(fixture, "session"), durableSessionId: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001" };
		const ref = { toolCallId: "call_1", contentIndex: 0 };
		const callDirectory = join(toolMediaRoot(scope), createHash("sha256").update(ref.toolCallId).digest("hex"));
		const outside = join(fixture, "outside");
		mkdirSync(outside);
		const swapAfterMkdir = (directory: string) => {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			if (directory !== callDirectory) return;
			rmdirSync(directory);
			symlinkSync(outside, directory, "junction");
		};

		const outcome = persistToolImage(
			scope,
			ref,
			{ data: "iVBORw0KGgo=", mimeType: "image/png" },
			undefined,
			swapAfterMkdir,
		);

		expect(readlinkSync(callDirectory)).toBe(outside);
		expect(readdirSync(outside)).toEqual([]);
		expect(outcome).toEqual({ unavailableReason: "storage_error" });
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
