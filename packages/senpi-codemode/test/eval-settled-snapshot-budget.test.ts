import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalDetachedCellSnapshot } from "../src/tool/detached-cell-contract.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createDetachedControlResult } from "../src/tool/detached-eval-result.ts";
import { TerminalSnapshotStore } from "../src/tool/terminal-snapshot-store.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { FakeKernel } from "./eval/fakes.ts";

const MIB = 1024 * 1024;
const TWO_MIB_IMAGE = "A".repeat(2 * MIB);
const SMALL_IMAGE = "B".repeat(64 * 1024);

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function artifactsDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-settled-spill-"));
	roots.push(root);
	return root;
}

function spillFiles(root: string): string[] {
	const dir = join(root, "settled-images");
	return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function imageResult(index: number, image: string, jsonOutputs?: readonly unknown[]): AgentToolResult<EvalToolDetails> {
	return {
		content: [
			{ type: "text", text: `output-${index}` },
			{ type: "image", mimeType: "image/png", data: image },
		],
		details: {
			language: "js",
			languages: ["js"],
			summary: `cell ${index}`,
			durationMs: 1,
			toolCalls: [],
			truncated: false,
			...(jsonOutputs === undefined ? {} : { jsonOutputs }),
			cells: [
				{
					index: 0,
					summary: `cell ${index}`,
					code: String(index),
					language: "js",
					output: `output-${index}`,
					status: "complete",
					durationMs: 1,
				},
			],
		},
	};
}

function settleForeground(manager: EvalDetachedCellManager, id: string, result: AgentToolResult<EvalToolDetails>) {
	const cell = manager.create(id, { language: "js", code: id, summary: id });
	manager.markRunning(cell);
	manager.complete(cell, result);
}

function settleDetached(manager: EvalDetachedCellManager, id: string, result: AgentToolResult<EvalToolDetails>) {
	const cell = manager.create(id, { language: "js", code: id, summary: id });
	manager.markRunning(cell);
	manager.bindKernel(cell, new FakeKernel([]), () => result);
	expect(manager.detach(cell)).toBe(true);
	manager.complete(cell, result);
}

function imageData(snapshot: EvalDetachedCellSnapshot): string[] {
	return snapshot.result.content.flatMap((part) => (part.type === "image" ? [part.data] : []));
}

// senpi#2259: settled-cell images live on disk, not the session heap, and are rebuilt on peek.
describe("settled-cell image spill (#2259)", () => {
	it("returns a settled foreground cell's full result, images included, while memory holds none", async () => {
		const root = await artifactsDir();
		const manager = new EvalDetachedCellManager({ artifactsDir: root });
		settleForeground(manager, "fg", imageResult(1, TWO_MIB_IMAGE, [{ answer: 42 }]));

		expect(imageData(manager.peek("fg"))).toEqual([TWO_MIB_IMAGE]);
		expect(manager.peek("fg").result.details.jsonOutputs).toEqual([{ answer: 42 }]);
		expect(
			createDetachedControlResult(manager.peek("fg")).content.filter((part) => part.type === "image"),
		).toHaveLength(1);
		expect(manager.list().recent.flatMap(imageData)).toEqual([]);
		expect(spillFiles(root)).toHaveLength(1);
		await manager.dispose();
	});

	it("returns a settled detached cell's images from the spill", async () => {
		const root = await artifactsDir();
		const manager = new EvalDetachedCellManager({ artifactsDir: root });
		settleDetached(manager, "bg", imageResult(1, TWO_MIB_IMAGE));

		expect(imageData(manager.peek("bg"))).toEqual([TWO_MIB_IMAGE]);
		await manager.dispose();
	});

	it("deletes an evicted snapshot's spill files and removes the directory on dispose", async () => {
		const root = await artifactsDir();
		const manager = new EvalDetachedCellManager({ artifactsDir: root });
		for (let i = 0; i < 40; i++) settleForeground(manager, `fg-${i}`, imageResult(i, SMALL_IMAGE));

		expect(manager.list().recent).toHaveLength(32);
		expect(spillFiles(root)).toHaveLength(32);
		expect(spillFiles(root).some((name) => name.startsWith("fg-7-"))).toBe(false);
		expect(imageData(manager.peek("fg-39"))).toEqual([SMALL_IMAGE]);

		await manager.dispose();
		expect(existsSync(join(root, "settled-images"))).toBe(false);
	});

	it("deletes the oldest spill files beyond the disk budget and notes the lost image on peek", async () => {
		const root = await artifactsDir();
		const manager = new EvalDetachedCellManager({ artifactsDir: root, retainedImagesBytes: 5 * MIB });
		for (let i = 0; i < 4; i++) settleForeground(manager, `fg-${i}`, imageResult(i, TWO_MIB_IMAGE));

		expect(spillFiles(root).map((name) => name.replace(/-\d+\.b64$/u, ""))).toEqual(["fg-2", "fg-3"]);
		const oldest = manager.peek("fg-0");
		expect(imageData(oldest)).toEqual([]);
		expect(oldest.result.content).toEqual([
			{ type: "text", text: "output-0" },
			{
				type: "text",
				text: expect.stringMatching(/^\[image\/png image \(2097152 base64 bytes\) .* \(ENOENT\)\]$/u),
			},
		]);
		expect(imageData(manager.peek("fg-3"))).toEqual([TWO_MIB_IMAGE]);
		await manager.dispose();
	});

	it("answers peek with the text and a one-line note when a spill file disappeared", async () => {
		const root = await artifactsDir();
		const manager = new EvalDetachedCellManager({ artifactsDir: root });
		settleForeground(manager, "fg", imageResult(1, SMALL_IMAGE));
		for (const name of spillFiles(root)) rmSync(join(root, "settled-images", name));

		const text = createDetachedControlResult(manager.peek("fg")).content;
		expect(text).toHaveLength(1);
		expect(text[0]).toMatchObject({ type: "text", text: expect.stringContaining("output-1\n[image/png image") });
		await manager.dispose();
	});

	it("keeps images in memory under the byte budget when no artifacts dir is configured", async () => {
		const manager = new EvalDetachedCellManager({ retainedResultsBytes: 5 * MIB });
		for (let i = 0; i < 4; i++) settleForeground(manager, `fg-${i}`, imageResult(i, TWO_MIB_IMAGE));

		expect(manager.list().recent.map((snapshot) => snapshot.cellId)).toEqual(["fg-2", "fg-3"]);
		expect(imageData(manager.peek("fg-3"))).toEqual([TWO_MIB_IMAGE]);
		await manager.dispose();
	});

	it("never exceeds the in-memory byte budget except for a single newest snapshot, and 0 keeps only the count cap", () => {
		const snapshot = (cellId: string, image: string): EvalDetachedCellSnapshot => ({
			cellId,
			language: "js",
			startedAtMs: 0,
			state: "completed",
			outputTail: "",
			result: imageResult(0, image),
			stateRetained: true,
		});
		const budgeted = new TerminalSnapshotStore({ byteBudget: 3 * MIB });
		for (let i = 0; i < 6; i++) {
			budgeted.remember(snapshot(`s-${i}`, TWO_MIB_IMAGE.slice(0, MIB)));
			expect(budgeted.bytes).toBeLessThanOrEqual(3 * MIB);
		}
		budgeted.remember(snapshot("huge", `${TWO_MIB_IMAGE}${TWO_MIB_IMAGE}`));
		expect(budgeted.list().map((entry) => entry.cellId)).toEqual(["huge"]);

		const countOnly = new TerminalSnapshotStore({ cap: 3, byteBudget: 0 });
		for (let i = 0; i < 5; i++) countOnly.remember(snapshot(`c-${i}`, TWO_MIB_IMAGE));
		expect(countOnly.list().map((entry) => entry.cellId)).toEqual(["c-2", "c-3", "c-4"]);
	});
});
