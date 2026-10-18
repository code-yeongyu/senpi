import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupMemoryReportHosts,
	memoryReport,
	RESIDENT_ENTRIES,
	reportFiles,
	signalForReport,
	startMemoryReportHost,
	TASK_CHILD_FIGURES,
	waitForExit,
	waitForPath,
} from "./issue-2561-memory-report-host.ts";

// senpi#2561: a running session process answers, on demand and only when SENPI_MEMORY_REPORT=1 is set,
// with a per-layer memory report: main thread, live kernels, resident store, extension reporters.

const MIB = 1024 * 1024;

afterEach(cleanupMemoryReportHosts);

describe("on-demand memory report (#2561)", () => {
	it("Given SENPI_MEMORY_REPORT=1 when the rpc host gets SIGUSR2 then it writes a per-layer report and keeps running", async () => {
		const host = await startMemoryReportHost({ SENPI_MEMORY_REPORT: "1" });
		await host.runCommand("memory-fill");

		const report = await signalForReport(host);

		expect(report.main.jscHeapSize).toBeGreaterThan(0);
		expect(report.main.footprint.bytes).toBeGreaterThan(0);
		expect(report.kernels).toEqual([
			expect.objectContaining({ language: "js", measure: "heap", sessionId: report.sessionId, stale: false }),
		]);
		expect(report.kernels[0]?.lastLiveBytes).toBeGreaterThanOrEqual(80 * MIB);
		expect(report.residentStore.entries).toBe(RESIDENT_ENTRIES);
		expect(report.residentStore.approxBytes).toBeGreaterThanOrEqual(RESIDENT_ENTRIES * 40 * 1024);
		expect(report.taskChildren).toEqual(TASK_CHILD_FIGURES);
		expect(report.tuiRenderCache).toBeUndefined();
		expect(report.heapSnapshot).toBeUndefined();
		await expect(host.request({ type: "get_state" })).resolves.toMatchObject({ success: true });
	}, 120_000);

	it("Given a cell still running when the report is taken then the kernel shows its last reading marked stale", async () => {
		const host = await startMemoryReportHost({ SENPI_MEMORY_REPORT: "1" });
		await host.runCommand("memory-fill");
		await host.runCommand("memory-hold");
		await waitForPath(host.holdMarker, 30_000);

		const report = await signalForReport(host);

		expect(report.kernels).toEqual([expect.objectContaining({ language: "js", stale: true })]);
		expect(report.kernels[0]?.lastLiveBytes).toBeGreaterThanOrEqual(80 * MIB);
	}, 120_000);

	it("Given the rpc memory_report request when the flag is set then it answers with the written report path", async () => {
		const host = await startMemoryReportHost({ SENPI_MEMORY_REPORT: "1" });

		const reply = await host.request({ type: "memory_report" });

		expect(reply).toMatchObject({ success: true, command: "memory_report" });
		const data = memoryReport.parse(
			JSON.parse(readFileSync(String(Reflect.get(Object(reply.data), "path")), "utf8")),
		);
		expect(data.residentStore.entries).toBe(RESIDENT_ENTRIES);
	}, 120_000);

	it("Given SENPI_MEMORY_REPORT_SNAPSHOT=1 when the report is taken then a parseable heap snapshot is written beside it", async () => {
		const host = await startMemoryReportHost({ SENPI_MEMORY_REPORT: "1", SENPI_MEMORY_REPORT_SNAPSHOT: "1" });

		const report = await signalForReport(host);

		expect(report.heapSnapshot).toMatch(/\.heapsnapshot$/);
		const snapshot: unknown = JSON.parse(readFileSync(report.heapSnapshot ?? "", "utf8"));
		expect(snapshot).toHaveProperty("snapshot");
	}, 120_000);

	it("Given an unwritable report directory when the report is requested then the host logs one line and keeps running", async () => {
		const host = await startMemoryReportHost({ SENPI_MEMORY_REPORT: "1" });
		mkdirSync(dirname(host.memoryDir), { recursive: true });
		writeFileSync(host.memoryDir, "not a directory");

		const reply = await host.request({ type: "memory_report" });

		expect(reply).toMatchObject({ success: false, command: "memory_report" });
		await host.waitForStderr("memory report", 10_000);
		await expect(host.request({ type: "get_state" })).resolves.toMatchObject({ success: true });
	}, 120_000);

	it("Given no SENPI_MEMORY_REPORT when the host gets SIGUSR2 then nothing is installed and the signal ends the process", async () => {
		const host = await startMemoryReportHost();
		const pid = host.child.pid ?? 0;

		const reply = await host.request({ type: "memory_report" });
		process.kill(pid, "SIGUSR2");
		const exit = await waitForExit(host.child);

		expect(reply).toMatchObject({ success: false, error: expect.stringContaining("memory_report_disabled") });
		expect(exit).toBe("SIGUSR2");
		expect(reportFiles(host.memoryDir)).toEqual([]);
	}, 120_000);
});
