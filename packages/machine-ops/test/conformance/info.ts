import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { type ConformanceRunner, type ConformanceTarget, withFixture } from "./harness.ts";

export function defineInfoCases(runner: ConformanceRunner, target: ConformanceTarget): void {
	const { describe, it } = runner;
	describe("info", () => {
		it(
			"processInfo with no arguments describes the runtime's own process",
			withFixture(target, async ({ ops }) => {
				const info = await ops.info.processInfo();
				assert.equal(info.pid, process.pid);
				assert.ok(info.rssBytes > 0);
				assert.ok(info.startedAtMs <= Date.now());
			}),
		);
		it(
			"message seq increments per topic and appends one JSONL line each",
			withFixture(target, async ({ ops, ctx }) => {
				const first = await ops.info.message({ topic: "alpha", body: { n: 1 } }, ctx());
				const second = await ops.info.message({ topic: "alpha", body: { n: 2 } }, ctx());
				const other = await ops.info.message({ topic: "beta", body: "x" }, ctx());
				assert.deepEqual([first.seq, second.seq, other.seq], [1, 2, 1]);
				assert.equal(first.inboxPath, second.inboxPath);
				const lines = (await readFile(first.inboxPath, "utf8")).trimEnd().split("\n");
				assert.equal(lines.length, 2);
				assert.deepEqual(
					lines.map((line) => JSON.parse(line).body),
					[{ n: 1 }, { n: 2 }],
				);
			}),
		);
		it(
			"host reports platform facts",
			withFixture(target, async ({ ops }) => {
				const host = ops.info.host();
				assert.equal(host.os, process.platform);
				assert.ok(host.cores > 0);
			}),
		);
		it(
			"host reports load averages, memory and the home volume",
			withFixture(target, async ({ ops }) => {
				const host = ops.info.host();
				for (const load of [host.load1, host.load5, host.load15]) assert.ok(Number.isFinite(load) && load >= 0);
				assert.ok(host.memTotalBytes > 0);
				assert.ok(host.memFreeBytes >= 0 && host.memFreeBytes <= host.memTotalBytes);
				const { diskTotalBytes, diskFreeBytes } = host;
				assert.ok(diskTotalBytes !== undefined && diskTotalBytes > 0);
				assert.ok(diskFreeBytes !== undefined && diskFreeBytes >= 0 && diskFreeBytes <= diskTotalBytes);
			}),
		);
	});
}
