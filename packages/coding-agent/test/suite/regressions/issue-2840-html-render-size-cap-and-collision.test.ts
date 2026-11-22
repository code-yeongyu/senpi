import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inlineLocalImages } from "../../../src/extensions/html-render/images.ts";
import { writeHtmlPage } from "../../../src/extensions/html-render/tool.ts";

// senpi#2840: the local-image size check and the read were separate steps, so an image that grew
// after its stat was read whole before the cap refused it; and the page filename carried only
// millisecond time, so two same-title pages written in the same millisecond overwrote each other.
// The fs seam is the node:fs/promises module boundary every production caller goes through.

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEN_MIB = 10 * 1024 * 1024;

interface FsScenario {
	/** What a pre-read stat reports for the image; undefined passes stat through to the real fs. */
	statSize: number | undefined;
	/** The bytes the image has grown to by read time; undefined passes reads through to the real fs. */
	grownBytes: Buffer | undefined;
	/** Bytes handed out by an unbounded whole-file readFile. */
	readFileServed: number;
	/** Bytes handed out through the file descriptor read path. */
	fdServed: number;
}

const scenario = vi.hoisted((): FsScenario => ({
	statSize: undefined,
	grownBytes: undefined,
	readFileServed: 0,
	fdServed: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const stat = async (path: string, options?: unknown) => {
		if (scenario.statSize === undefined) return actual.stat(path, options);
		return { isFile: () => true, size: scenario.statSize } as unknown as Awaited<
			ReturnType<typeof actual.stat>
		>;
	};
	const readFile = async (path: string, options?: unknown) => {
		if (scenario.grownBytes === undefined) return actual.readFile(path, options);
		scenario.readFileServed += scenario.grownBytes.byteLength;
		return scenario.grownBytes;
	};
	const open = async (path: string, flags?: unknown, mode?: unknown) => {
		if (scenario.grownBytes === undefined) return actual.open(path, flags, mode);
		const grown = scenario.grownBytes;
		let cursor = 0;
		const handle = {
			async read(buffer: Buffer, offset: number, length: number, position: number | null) {
				const at = position ?? cursor;
				const take = Math.max(0, Math.min(length, grown.byteLength - at));
				grown.copy(buffer, offset, at, at + take);
				if (position === null || position === undefined) cursor = at + take;
				scenario.fdServed += take;
				return { bytesRead: take, buffer };
			},
			async close() {},
		};
		return handle as unknown as Awaited<ReturnType<typeof actual.open>>;
	};
	return { ...actual, stat, readFile, open } as typeof actual;
});

describe("senpi#2840: show_html_page image reads and page writes", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-2840-"));
		scenario.statSize = undefined;
		scenario.grownBytes = undefined;
		scenario.readFileServed = 0;
		scenario.fdServed = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("refuses an image that grows past the size cap without reading it whole", async () => {
		scenario.statSize = 4096;
		scenario.grownBytes = Buffer.concat([PNG_HEAD, Buffer.alloc(TEN_MIB + 512 * 1024, 1)]);
		const grewPath = join(tempDir, "grew.png");

		await expect(inlineLocalImages(`<img src="${grewPath}">`)).rejects.toThrow(/at most 10 MiB/);

		expect(scenario.readFileServed).toBe(0);
		expect(scenario.fdServed).toBeLessThanOrEqual(TEN_MIB + 1);
	});

	it("keeps two same-title pages written in the same millisecond as separate files", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-22T10:00:00.000Z"));

		const [first, second] = await Promise.all([
			writeHtmlPage({ html: "<p>first page</p>", title: "Same title" }, tempDir, false),
			writeHtmlPage({ html: "<p>second page</p>", title: "Same title" }, tempDir, false),
		]);

		expect(first.details.path).not.toBe(second.details.path);
		expect(readFileSync(first.details.path, "utf8")).toContain("<p>first page</p>");
		expect(readFileSync(second.details.path, "utf8")).toContain("<p>second page</p>");
		expect(readdirSync(join(tempDir, ".senpi/html-pages"))).toHaveLength(2);
	});
});
