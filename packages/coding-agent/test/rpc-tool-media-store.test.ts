import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_PLACEHOLDERS_CAPABILITY } from "../src/modes/rpc/custom-capability.ts";
import { type MediaPersister, omitInlineMedia } from "../src/modes/rpc/media-placeholders.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";
import {
	MAX_TOOL_IMAGE_BYTES,
	persistToolImage,
	removeToolMedia,
	type ToolMediaScope,
	toolMediaPersister,
	toolMediaScopeOfSessionFile,
} from "../src/modes/rpc/tool-media-store.ts";

const SESSION_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
let sessionDir: string;
let scope: ToolMediaScope;

beforeEach(() => {
	sessionDir = mkdtempSync(join(tmpdir(), "senpi-tool-media-"));
	scope = { sessionDir, durableSessionId: SESSION_ID };
});

afterEach(() => {
	rmSync(sessionDir, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function png(seed: number, size = 64): { bytes: Buffer; block: { data: string; mimeType: string } } {
	const bytes = Buffer.alloc(size, seed);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
	return { bytes, block: { data: bytes.toString("base64"), mimeType: "image/png" } };
}

function toolEnd(toolCallId: string, blocks: readonly object[]): object {
	return { type: "tool_execution_end", toolCallId, result: { content: [{ type: "text", text: "shot" }, ...blocks] } };
}

type Placeholder = { type: string; path?: string; unavailableReason?: string; ref: { contentIndex: number } };
const placeholders = (record: object): Placeholder[] =>
	(record as { result: { content: Placeholder[] } }).result.content.filter((block) => block.type === "image_ref");

describe("tool image persistence", () => {
	it("stores the original bytes before the placeholder naming them exists", () => {
		const { bytes, block } = png(7);
		let existedWhenReported = false;
		const persist: MediaPersister = (ref, image) => {
			const outcome = toolMediaPersister(() => scope)(ref, image);
			existedWhenReported = outcome !== undefined && "path" in outcome && existsSync(outcome.path);
			return outcome;
		};

		const [placeholder] = placeholders(omitInlineMedia(toolEnd("call_1", [{ type: "image", ...block }]), persist));

		expect(existedWhenReported).toBe(true);
		expect(placeholder?.path).toBeDefined();
		expect(sha256(readFileSync(placeholder?.path ?? ""))).toBe(sha256(bytes));
		expect(placeholder?.path?.startsWith(join(sessionDir, "media", SESSION_ID))).toBe(true);
		expect(placeholder?.path?.endsWith(".png")).toBe(true);
	});

	it("keeps each image of one result and writes a re-emitted image once", () => {
		const first = png(1);
		const second = png(2);
		const record = toolEnd("call_2", [
			{ type: "image", ...first.block },
			{ type: "image", ...second.block },
		]);
		const persist = toolMediaPersister(() => scope);

		const [one, two] = placeholders(omitInlineMedia(record, persist));
		const again = placeholders(omitInlineMedia(record, persist));

		expect(one?.path).not.toBe(two?.path);
		expect(again.map((block) => block.path)).toEqual([one?.path, two?.path]);
		const files = readdirSync(join(sessionDir, "media", SESSION_ID), { recursive: true, withFileTypes: true }).filter(
			(entry) => entry.isFile(),
		);
		expect(files).toHaveLength(2);
	});

	it("makes the stored file read-only and its directories private", () => {
		const { block } = png(3);
		const outcome = persistToolImage(scope, { toolCallId: "call_3", contentIndex: 0 }, block);

		const path = "path" in outcome ? outcome.path : "";
		expect(statSync(path).mode & 0o777).toBe(0o400);
		expect(statSync(join(path, "..")).mode & 0o077).toBe(0);
	});

	it("reports an image over the per-image limit as too large and stores nothing", () => {
		const huge = Buffer.alloc(MAX_TOOL_IMAGE_BYTES + 1024, 9);
		const record = toolEnd("call_4", [{ type: "image", data: huge.toString("base64"), mimeType: "image/png" }]);

		const [placeholder] = placeholders(
			omitInlineMedia(
				record,
				toolMediaPersister(() => scope),
			),
		);

		expect(placeholder).toMatchObject({ unavailableReason: "image_too_large" });
		expect(placeholder?.path).toBeUndefined();
		expect(existsSync(join(sessionDir, "media"))).toBe(false);
	});

	it("rejects new storage once the session quota is reserved and never evicts what is stored", () => {
		const limits = { perImage: 1024, perSession: 150 };
		const kept = persistToolImage(scope, { toolCallId: "a", contentIndex: 0 }, png(1, 100).block, limits);
		const refused = persistToolImage(scope, { toolCallId: "b", contentIndex: 0 }, png(2, 100).block, limits);

		expect(refused).toEqual({ unavailableReason: "session_limit" });
		expect("path" in kept && existsSync(kept.path)).toBe(true);
		const small = persistToolImage(scope, { toolCallId: "c", contentIndex: 0 }, png(3, 40).block, limits);
		expect("path" in small).toBe(true);
	});

	it("still counts stored images after the host restarts", async () => {
		const limits = { perImage: 1024, perSession: 150 };
		persistToolImage(scope, { toolCallId: "a", contentIndex: 0 }, png(1, 100).block, limits);
		vi.resetModules();
		const restarted = await import("../src/modes/rpc/tool-media-store.ts");

		const refused = restarted.persistToolImage(
			scope,
			{ toolCallId: "b", contentIndex: 0 },
			png(2, 100).block,
			limits,
		);
		const again = restarted.persistToolImage(scope, { toolCallId: "a", contentIndex: 0 }, png(1, 100).block, limits);

		expect(refused).toEqual({ unavailableReason: "session_limit" });
		expect("path" in again && existsSync(again.path)).toBe(true);
	});

	it("reports a storage error, and frees the reservation, when the directory cannot be written", () => {
		const blocked = join(sessionDir, "blocked");
		writeFileSync(blocked, "not a directory");
		const brokenScope = { sessionDir: blocked, durableSessionId: SESSION_ID };
		const limits = { perImage: 1024, perSession: 150 };

		const failed = persistToolImage(brokenScope, { toolCallId: "a", contentIndex: 0 }, png(1, 100).block, limits);
		const healthy = persistToolImage(scope, { toolCallId: "a", contentIndex: 0 }, png(1, 100).block, limits);

		expect(failed).toEqual({ unavailableReason: "storage_error" });
		expect("path" in healthy).toBe(true);
	});

	it("reports a storage error for a format it will not write", () => {
		const outcome = persistToolImage(
			scope,
			{ toolCallId: "a", contentIndex: 0 },
			{ data: "AAAA", mimeType: "text/html" },
		);

		expect(outcome).toEqual({ unavailableReason: "storage_error" });
		expect(existsSync(join(sessionDir, "media"))).toBe(false);
	});

	it("leaves the placeholder as it was for a session with nowhere durable to keep images", () => {
		const { block } = png(5);
		const [placeholder] = placeholders(
			omitInlineMedia(
				toolEnd("call_5", [{ type: "image", ...block }]),
				toolMediaPersister(() => undefined),
			),
		);

		expect(placeholder?.path).toBeUndefined();
		expect(placeholder?.unavailableReason).toBeUndefined();
	});

	it("removes the images with the session, and only that session's", async () => {
		const { block } = png(6);
		persistToolImage(scope, { toolCallId: "call_6", contentIndex: 0 }, block);
		const other = { sessionDir, durableSessionId: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002" };
		persistToolImage(other, { toolCallId: "call_6", contentIndex: 0 }, png(8).block);
		const sessionFile = join(sessionDir, `2026-10-03T00-00-00-000Z_${SESSION_ID}.jsonl`);
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: SESSION_ID })}\n`);

		const found = await toolMediaScopeOfSessionFile(sessionFile);
		if (found) removeToolMedia(found);

		expect(existsSync(join(sessionDir, "media", SESSION_ID))).toBe(false);
		expect(existsSync(join(sessionDir, "media", other.durableSessionId))).toBe(true);
	});

	it("deletes nothing for a session file with no readable header", async () => {
		const broken = join(sessionDir, "broken.jsonl");
		writeFileSync(broken, "not json\n");
		mkdirSync(join(sessionDir, "media", SESSION_ID), { recursive: true });

		expect(await toolMediaScopeOfSessionFile(broken)).toBeUndefined();
		expect(existsSync(join(sessionDir, "media", SESSION_ID))).toBe(true);
	});

	it("gives a capable client the path through the event writer while a plain client keeps the bytes", async () => {
		const writer = new SessionEventWriter(() => {});
		const lines: Record<string, string[]> = { capable: [], plain: [] };
		for (const id of ["capable", "plain"]) {
			writer.registerConnection(id, {
				writeRaw: (chunk) => void lines[id]?.push(chunk),
				waitForBackpressure: async () => {},
			});
			writer.setConnectionCapabilities(id, id === "capable" ? [MEDIA_PLACEHOLDERS_CAPABILITY] : []);
			writer.attachConnectionToSession(id, "rpc-1");
		}
		writer.setSessionMedia(
			"rpc-1",
			toolMediaPersister(() => scope),
		);
		const { bytes, block } = png(4);

		writer.enqueue("rpc-1", toolEnd("call_7", [{ type: "image", ...block }]));
		await writer.flush();

		const capable = JSON.parse(lines.capable?.join("").trim() ?? "{}") as object;
		const plain = JSON.parse(lines.plain?.join("").trim() ?? "{}") as {
			result: { content: Array<{ data?: string }> };
		};
		const [placeholder] = placeholders(capable);
		expect(sha256(readFileSync(placeholder?.path ?? ""))).toBe(sha256(bytes));
		expect(plain.result.content[1]?.data).toBe(block.data);
	});

	it("refuses bytes that are not the image format the tool claimed, instead of filing HTML as a png", () => {
		const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");

		const outcome = persistToolImage(
			scope,
			{ toolCallId: "call_html", contentIndex: 0 },
			{ data: html, mimeType: "image/png" },
		);

		expect(outcome).toEqual({ unavailableReason: "storage_error" });
		expect(existsSync(join(sessionDir, "media"))).toBe(false);
	});

	it("stores each supported format that carries its own signature", () => {
		const formats = [
			["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])],
			["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])],
			["image/gif", Buffer.from("GIF89a-----")],
			["image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")])],
		] as const;

		for (const [mimeType, bytes] of formats) {
			const outcome = persistToolImage(
				scope,
				{ toolCallId: `call_${mimeType}`, contentIndex: 0 },
				{ data: bytes.toString("base64"), mimeType },
			);
			expect("path" in outcome && readFileSync(outcome.path).equals(bytes)).toBe(true);
		}
	});

	it("never follows a symlink planted where one tool call's images go, inside an otherwise real media folder", () => {
		const outside = mkdtempSync(join(tmpdir(), "senpi-outside-"));
		try {
			persistToolImage(scope, { toolCallId: "call_first", contentIndex: 0 }, png(1).block);
			const callFolder = createHash("sha256").update("call_planted").digest("hex");
			symlinkSync(outside, join(sessionDir, "media", SESSION_ID, callFolder));

			const outcome = persistToolImage(scope, { toolCallId: "call_planted", contentIndex: 0 }, png(2).block);

			expect(outcome).toEqual({ unavailableReason: "storage_error" });
			expect(readdirSync(outside)).toEqual([]);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("never follows a symlink planted where the session's media directory goes", () => {
		const outside = mkdtempSync(join(tmpdir(), "senpi-outside-"));
		try {
			mkdirSync(join(sessionDir, "media"));
			symlinkSync(outside, join(sessionDir, "media", SESSION_ID));

			const outcome = persistToolImage(scope, { toolCallId: "call_link", contentIndex: 0 }, png(1).block);

			expect(outcome).toEqual({ unavailableReason: "storage_error" });
			expect(readdirSync(outside)).toEqual([]);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	describe("removing a session's images never touches what a symlink points at", () => {
		let outside: string;
		beforeEach(() => {
			outside = mkdtempSync(join(tmpdir(), "senpi-outside-target-"));
			chmodSync(outside, 0o755);
			writeFileSync(join(outside, "keep.txt"), "keep");
			chmodSync(join(outside, "keep.txt"), 0o644);
		});
		afterEach(() => {
			rmSync(outside, { recursive: true, force: true });
		});

		const modeOf = (path: string) => statSync(path).mode & 0o777;

		it("removes a link to an outside folder found inside the media folder and leaves that folder as it was", () => {
			persistToolImage(scope, { toolCallId: "call_a", contentIndex: 0 }, png(1).block);
			symlinkSync(outside, join(sessionDir, "media", SESSION_ID, "link-to-folder"));

			removeToolMedia(scope);

			expect(existsSync(join(sessionDir, "media", SESSION_ID))).toBe(false);
			expect(modeOf(outside)).toBe(0o755);
			expect(modeOf(join(outside, "keep.txt"))).toBe(0o644);
			expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
		});

		it("removes a link to an outside file and leaves that file's mode alone", () => {
			persistToolImage(scope, { toolCallId: "call_b", contentIndex: 0 }, png(2).block);
			symlinkSync(join(outside, "keep.txt"), join(sessionDir, "media", SESSION_ID, "link-to-file"));

			removeToolMedia(scope);

			expect(existsSync(join(sessionDir, "media", SESSION_ID))).toBe(false);
			expect(modeOf(join(outside, "keep.txt"))).toBe(0o644);
			expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
		});

		it("removes the media folder itself when it is a link, without touching the folder it names", () => {
			mkdirSync(join(sessionDir, "media"));
			symlinkSync(outside, join(sessionDir, "media", SESSION_ID));

			removeToolMedia(scope);

			expect(existsSync(join(sessionDir, "media", SESSION_ID))).toBe(false);
			expect(modeOf(outside)).toBe(0o755);
			expect(modeOf(join(outside, "keep.txt"))).toBe(0o644);
			expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
		});
	});
});
