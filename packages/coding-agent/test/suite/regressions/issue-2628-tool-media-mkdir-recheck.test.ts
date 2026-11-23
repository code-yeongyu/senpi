import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { persistToolImage, toolMediaRoot } from "../../../src/modes/rpc/tool-media-store.ts";

const swap = vi.hoisted((): { directory?: string; target?: string } => ({}));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
			const created = fs.mkdirSync(...args);
			const [directory] = args;
			if (typeof directory === "string" && directory === swap.directory && swap.target !== undefined) {
				fs.rmdirSync(directory);
				fs.symlinkSync(swap.target, directory, "junction");
			}
			return created;
		},
	};
});

// senpi#2628: the first check cannot see a link introduced after mkdir.
it("refuses to write a tool image through a symlink introduced after mkdir", () => {
	const fixture = mkdtempSync(join(tmpdir(), "senpi-media-mkdir-recheck-"));
	try {
		const scope = { sessionDir: join(fixture, "session"), durableSessionId: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001" };
		const ref = { toolCallId: "call_1", contentIndex: 0 };
		const callDirectory = join(toolMediaRoot(scope), createHash("sha256").update(ref.toolCallId).digest("hex"));
		const outside = join(fixture, "outside");
		mkdirSync(outside);
		swap.directory = callDirectory;
		swap.target = outside;

		const outcome = persistToolImage(scope, ref, { data: "iVBORw0KGgo=", mimeType: "image/png" });

		expect(readlinkSync(callDirectory)).toBe(outside);
		expect(readdirSync(outside)).toEqual([]);
		expect(outcome).toEqual({ unavailableReason: "storage_error" });
	} finally {
		delete swap.directory;
		delete swap.target;
		rmSync(fixture, { recursive: true, force: true });
	}
});
