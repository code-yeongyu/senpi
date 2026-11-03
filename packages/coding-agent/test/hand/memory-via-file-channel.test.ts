// senpi#5645 (S40, brain/hand split): memory operations reach the device's files only through the hand's file channel.
// A memory-style sequence run through the channel on a split session lands on the hand's files, equals the same sequence
// on a fused session, and passes the hand's own tool_call handlers. A split-local hand shares the brain's disk, so the
// handler record is what tells a channel operation from a direct open: an implementation that opens the file itself
// still produces the right bytes, and fails here because the hand never saw the operation.
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type DeviceFiles, localDeviceFiles } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { InlineExtension } from "../../src/core/extensions/types.ts";
import { cleanupHands, handDirs, openLink, remoteHost, startHand } from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function memorySequence(files: DeviceFiles, root: string) {
	const dir = join(root, "memory");
	await files.mkdir(dir);
	await files.write(join(dir, "lock"), encode("1"), { exclusive: true });
	const secondLock = await files.write(join(dir, "lock"), encode("2"), { exclusive: true }).then(
		() => "written",
		(error: { code?: string }) => error.code,
	);
	await files.write(join(dir, "note.tmp"), encode("remember this"));
	await files.rename(join(dir, "note.tmp"), join(dir, "note.md"));
	const listed = [...(await files.list(dir))].sort();
	const stat = await files.stat(join(dir, "note.md"));
	const text = decode(await files.read(join(dir, "note.md")));
	await files.remove(join(dir, "lock"));
	const after = [...(await files.list(dir))].sort();
	return { secondLock, listed, size: stat.size, kind: stat.kind, text, after };
}

function handlerRecorder(seen: string[], root: () => string): InlineExtension {
	return (pi) => {
		pi.on("tool_call", (event) => {
			const path = (event.input as { path?: unknown }).path;
			seen.push(`${event.toolName} ${typeof path === "string" ? relative(root(), path) : "?"}`);
			return undefined;
		});
	};
}

describe("memory operations go through the hand file channel (senpi#5645)", () => {
	it("lands a memory sequence on the hand's files, equal to fused, through the hand's handlers", async () => {
		const fusedDirs = await handDirs("s40-fused");
		const fused = await memorySequence(localDeviceFiles(), fusedDirs.cwd);

		const seen: string[] = [];
		const dirs = await handDirs("s40-split");
		const link = openLink();
		startHand(link, dirs, [handlerRecorder(seen, () => dirs.cwd)]);
		const files = remoteHost(link).deviceFiles({ id: `scope-${crypto.randomUUID()}`, root: dirs.cwd });
		const split = await memorySequence(files, dirs.cwd);

		expect(split).toEqual(fused);
		expect(fused).toEqual({
			secondLock: "exists",
			listed: ["lock", "note.md"],
			size: 13,
			kind: "file",
			text: "remember this",
			after: ["note.md"],
		});
		expect(await readFile(join(dirs.cwd, "memory", "note.md"), "utf8")).toBe("remember this");
		expect(seen).toEqual(
			expect.arrayContaining([
				"write memory/lock",
				"write memory/note.tmp",
				"write memory/note.md",
				"ls memory",
				"read memory/note.md",
			]),
		);
	});
});
