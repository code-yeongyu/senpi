import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputSink, resolveSessionArtifactsDir, TailBuffer } from "../../src/output/streaming-output.ts";

const cleanupPaths: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-codemode-output-test-"));
	cleanupPaths.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("TailBuffer", () => {
	it("keeps the trailing byte window across chunk boundaries", () => {
		// Given
		const tail = new TailBuffer(5);

		// When
		tail.append("abc");
		tail.append("def");

		// Then
		expect(tail.text()).toBe("bcdef");
		expect(tail.bytes()).toBe(5);
	});

	it("drops an incomplete multibyte prefix", () => {
		// Given
		const tail = new TailBuffer(4);

		// When
		tail.append("😀");
		tail.append("x");

		// Then
		expect(tail.text()).toBe("x");
		expect(tail.bytes()).toBe(1);
	});
});

describe("OutputSink", () => {
	it("reports tail truncation and exact summary totals", async () => {
		// Given
		const sink = new OutputSink({ spillThreshold: 5 });

		// When
		sink.push("abc");
		sink.push("def");
		const summary = await sink.dump();

		// Then
		expect(summary.output).toBe("bcdef");
		expect(summary.truncated).toBe(true);
		expect(summary.totalLines).toBe(1);
		expect(summary.totalBytes).toBe(6);
		expect(summary.outputLines).toBe(1);
		expect(summary.outputBytes).toBe(5);
	});

	it("keeps head and tail windows with one gap notice", async () => {
		// Given
		const sink = new OutputSink({ spillThreshold: 6, headBytes: 6 });
		const input = Array.from({ length: 12 }, (_, index) => `L${index}`).join("\n");

		// When
		sink.push(input);
		const summary = await sink.dump();

		// Then
		expect(summary.output.startsWith("L0\n")).toBe(true);
		expect(summary.output.endsWith("L11")).toBe(true);
		expect(summary.output.match(/elided/gu)).toHaveLength(1);
		expect(summary.elidedBytes).toBeGreaterThan(0);
		expect(summary.elidedLines).toBeGreaterThan(0);
	});

	it("clamps a line once across split chunks", async () => {
		// Given
		const sink = new OutputSink({ maxColumns: 4, spillThreshold: 100 });

		// When
		sink.push("ab");
		sink.push("cdefgh\nnext");
		const summary = await sink.dump();

		// Then
		expect(summary.output).toBe("abcd…\nnext");
		expect(summary.columnTruncatedLines).toBe(1);
		expect(summary.columnDroppedBytes).toBe(4);
		expect(summary.totalBytes).toBe(Buffer.byteLength("abcdefgh\nnext", "utf8"));
	});

	it("mirrors raw output when a column cap truncates before spill", async () => {
		// Given
		const dir = await createTempDir();
		const artifactPath = join(dir, "column-cap.log");
		const input = `${"x".repeat(50)}\n`;
		const sink = new OutputSink({
			artifactPath,
			spillThreshold: 50 * 1024,
			maxColumns: 8,
		});

		// When
		sink.push(input);
		const summary = await sink.dump();

		// Then
		expect(summary.output).toBe("xxxxxxxx…\n");
		expect(summary.truncated).toBe(true);
		expect(summary.columnTruncatedLines).toBe(1);
		expect(summary.columnDroppedBytes).toBe(42);
		expect(summary.artifactId).toBe(artifactPath);
		expect(await readFile(artifactPath, "utf8")).toBe(input);
	});

	it("preserves split UTF-8 output in the column-cap artifact", async () => {
		// Given
		const dir = await createTempDir();
		const artifactPath = join(dir, "column-cap-utf8.log");
		const input = `${"가".repeat(20)}\n`;
		const sink = new OutputSink({
			artifactPath,
			spillThreshold: 50 * 1024,
			maxColumns: 8,
		});

		// When
		sink.push(input.slice(0, 7));
		sink.push(input.slice(7));
		const summary = await sink.dump();

		// Then
		expect(summary.truncated).toBe(true);
		expect(summary.columnTruncatedLines).toBe(1);
		expect(summary.columnDroppedBytes).toBeGreaterThan(0);
		expect(summary.output).not.toContain("\ufffd");
		expect(await readFile(artifactPath, "utf8")).toBe(input);
	});

	it("mirrors a narrow column-cap loss below the ellipsis size", async () => {
		// Given
		const dir = await createTempDir();
		const artifactPath = join(dir, "column-cap-narrow-gap.log");
		const input = `${"x".repeat(770)}\n`;
		const sink = new OutputSink({
			artifactPath,
			spillThreshold: 50 * 1024,
			maxColumns: 768,
		});

		// When
		sink.push(input);
		const summary = await sink.dump();

		// Then
		expect(summary.truncated).toBe(true);
		expect(summary.columnDroppedBytes).toBe(2);
		expect(summary.artifactId).toBe(artifactPath);
		expect(await readFile(artifactPath, "utf8")).toBe(input);
	});

	it("flushes throttled chunks without dropping preview data", async () => {
		// Given
		vi.spyOn(Date, "now").mockReturnValue(100_000);
		const chunks: string[] = [];
		const sink = new OutputSink({
			onChunk: (chunk) => chunks.push(chunk),
			chunkThrottleMs: 60_000,
		});

		// When
		sink.push("a");
		sink.push("b");
		sink.push("c");
		const summary = await sink.dump();

		// Then
		expect(chunks).toEqual(["a", "bc"]);
		expect(summary.output).toBe("abc");
	});

	it("spills the complete stream only after the threshold", async () => {
		// Given
		const dir = await createTempDir();
		const artifactPath = join(dir, "spill.log");
		const sink = new OutputSink({ artifactPath, spillThreshold: 5 });

		// When
		sink.push("abc");
		sink.push("def");
		const summary = await sink.dump();

		// Then
		expect(await readFile(artifactPath, "utf8")).toBe("abcdef");
		expect(summary.artifactId).toBe(artifactPath);
		expect(summary.truncated).toBe(true);
	});

	it("does not create an artifact when output stays at the threshold", async () => {
		// Given
		const dir = await createTempDir();
		const artifactPath = join(dir, "small.log");
		const sink = new OutputSink({ artifactPath, spillThreshold: 5 });

		// When
		sink.push("abcde");
		const summary = await sink.dump();

		// Then
		expect(existsSync(artifactPath)).toBe(false);
		expect(summary.artifactId).toBeUndefined();
		expect(summary.truncated).toBe(false);
	});

	it("returns the same summary when dump is called twice", async () => {
		// Given
		const dir = await createTempDir();
		const artifactPath = join(dir, "idempotent.log");
		const sink = new OutputSink({ artifactPath, spillThreshold: 3 });
		sink.push("abcdef");

		// When
		const first = await sink.dump();
		const second = await sink.dump();

		// Then
		expect(second).toEqual(first);
		expect(await readFile(artifactPath, "utf8")).toBe("abcdef");
	});
});

describe("resolveSessionArtifactsDir", () => {
	it("creates a session-adjacent artifacts directory", async () => {
		// Given
		const root = await createTempDir();
		const sessionFile = join(root, "session.jsonl");

		// When
		const resolved = resolveSessionArtifactsDir(sessionFile);

		// Then
		expect(resolved).toEqual({ dir: join(root, "session-artifacts"), temp: false });
		expect(existsSync(resolved.dir)).toBe(true);
	});

	it("creates a unique temporary artifacts directory without a session", () => {
		// Given
		const prefix = "senpi-codemode-";

		// When
		const resolved = resolveSessionArtifactsDir(undefined);
		cleanupPaths.push(resolved.dir);

		// Then
		expect(resolved.temp).toBe(true);
		expect(basename(resolved.dir).startsWith(prefix)).toBe(true);
		expect(existsSync(resolved.dir)).toBe(true);
	});
});
