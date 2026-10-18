import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_MEMORY_GC_WATERMARK_MB,
	DEFAULT_MEMORY_NOTICE_MB,
	DEFAULT_RETAINED_IMAGES_MB,
	DEFAULT_RETAINED_RESULTS_MB,
	defaultMemoryCeilingMb,
	resolveKernelMemoryThresholds,
} from "../src/config/memory-settings.ts";
import { loadCodemodeSettings } from "../src/config/settings.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

async function loadFile(contents: unknown): Promise<Awaited<ReturnType<typeof loadCodemodeSettings>>> {
	const root = await mkdtemp(join(tmpdir(), "senpi-codemode-memory-"));
	try {
		await mkdir(join(root, ".senpi"));
		await writeFile(join(root, ".senpi", "codemode.json"), JSON.stringify(contents));
		return await loadCodemodeSettings({ cwd: root, homeDir: root });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("codemode memory settings", () => {
	it.each([
		{ totalBytes: 4 * GIB, ceilingMb: 2048 },
		{ totalBytes: 16 * GIB, ceilingMb: 4096 },
		{ totalBytes: 128 * GIB, ceilingMb: 8192 },
	])("defaults the ceiling to a quarter of $totalBytes bytes kept within 2-8 GiB", ({ totalBytes, ceilingMb }) => {
		expect(defaultMemoryCeilingMb(totalBytes)).toBe(ceilingMb);
	});

	it("Given no settings file when thresholds resolve then the defaults apply in bytes", async () => {
		const thresholds = resolveKernelMemoryThresholds(undefined, {});

		expect(thresholds).toEqual({
			gcWatermarkBytes: DEFAULT_MEMORY_GC_WATERMARK_MB * MIB,
			noticeBytes: DEFAULT_MEMORY_NOTICE_MB * MIB,
			ceilingBytes: defaultMemoryCeilingMb() * MIB,
		});
	});

	it("Given file thresholds and environment overrides when thresholds resolve then the environment wins and 0 disables", async () => {
		const loaded = await loadFile({ memory: { gcWatermarkMb: 100, noticeMb: 500, ceilingMb: 3000 } });

		const fromFile = resolveKernelMemoryThresholds(loaded.settings.memory, {});
		const overridden = resolveKernelMemoryThresholds(loaded.settings.memory, {
			SENPI_CODEMODE_MEMORY_NOTICE_MB: "0",
			SENPI_CODEMODE_MEMORY_CEILING_MB: "1024",
			SENPI_CODEMODE_MEMORY_GC_WATERMARK_MB: "bad",
		});

		expect(loaded.warnings).toEqual([]);
		expect(fromFile).toEqual({ gcWatermarkBytes: 100 * MIB, noticeBytes: 500 * MIB, ceilingBytes: 3000 * MIB });
		expect(overridden).toEqual({ gcWatermarkBytes: 100 * MIB, noticeBytes: 0, ceilingBytes: 1024 * MIB });
	});

	it("Given thresholds out of order in the file when settings load then a warning is returned and the defaults apply", async () => {
		const loaded = await loadFile({ memory: { noticeMb: 4096, ceilingMb: 2048 } });

		expect(loaded.warnings).toHaveLength(1);
		expect(loaded.settings.memory).toEqual({
			gcWatermarkMb: DEFAULT_MEMORY_GC_WATERMARK_MB,
			noticeMb: DEFAULT_MEMORY_NOTICE_MB,
			ceilingMb: defaultMemoryCeilingMb(),
			retainedResultsMb: DEFAULT_RETAINED_RESULTS_MB,
			retainedImagesMb: DEFAULT_RETAINED_IMAGES_MB,
		});
	});

	it("Given environment overrides out of order when thresholds resolve then the defaults apply", () => {
		const thresholds = resolveKernelMemoryThresholds(undefined, { SENPI_CODEMODE_MEMORY_GC_WATERMARK_MB: "2048" });

		expect(thresholds.gcWatermarkBytes).toBe(DEFAULT_MEMORY_GC_WATERMARK_MB * MIB);
	});

	it("Given a negative threshold in the file when settings load then the file is rejected", async () => {
		const loaded = await loadFile({ memory: { ceilingMb: -1 } });

		expect(loaded.warnings).toHaveLength(1);
		expect(loaded.settings.memory.ceilingMb).toBe(defaultMemoryCeilingMb());
	});

	it("Given no idle-park setting when settings load then kernels are never parked", async () => {
		const loaded = await loadFile({ memory: { noticeMb: 512 } });

		expect(loaded.warnings).toEqual([]);
		expect(loaded.settings.memory.idleParkMinutes).toBeUndefined();
	});

	it("Given an idle-park time in the file when settings load then it is kept", async () => {
		const loaded = await loadFile({ memory: { idleParkMinutes: 5 } });

		expect(loaded.warnings).toEqual([]);
		expect(loaded.settings.memory.idleParkMinutes).toBe(5);
	});

	it("Given the longest idle-park time a timer can wait when settings load then it is kept, and one minute more is rejected", async () => {
		const longest = await loadFile({ memory: { idleParkMinutes: 35_791 } });
		const tooLong = await loadFile({ memory: { idleParkMinutes: 35_792 } });

		expect(longest.warnings).toEqual([]);
		expect(longest.settings.memory.idleParkMinutes).toBe(35_791);
		expect(tooLong.warnings).toHaveLength(1);
		expect(tooLong.settings.memory.idleParkMinutes).toBeUndefined();
	});

	it("Given a negative idle-park time in the file when settings load then the file is rejected with a warning and parking stays off", async () => {
		const loaded = await loadFile({ memory: { idleParkMinutes: -1 } });

		expect(loaded.warnings).toHaveLength(1);
		expect(loaded.settings.memory.idleParkMinutes).toBeUndefined();
	});
});
