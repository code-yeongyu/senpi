import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentFingerprint, PendingInputAttachments } from "../../src/core/pending-input-attachments.ts";
import { SessionPendingInputJournal } from "../../src/core/pending-input-journal.ts";
import type { RecoveredInput } from "../../src/core/pending-input-recovery.ts";
import { SessionPendingInputs } from "../../src/core/pending-input-session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

// senpi#3549 P2c: the store is the single source on reopen, attachments included (duty's checks 1-4).

const IMAGE: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

function sessionDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pending-attachments-"));
	dirs.push(dir);
	return dir;
}

function blobDir(manager: SessionManager): string {
	return `${manager.getSessionFile() ?? ""}.attachments`;
}

function blobs(manager: SessionManager): string[] {
	const dir = blobDir(manager);
	return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".blob")) : [];
}

async function reopen(file: string, dir: string) {
	const recovered: RecoveredInput[] = [];
	let queuedIds = 100;
	const inputs = new SessionPendingInputs({
		sessionManager: SessionManager.open(file, dir),
		nextQueuedId: () => `q_${++queuedIds}`,
		requeue: (input) => recovered.push(input),
	});
	await inputs.snapshot();
	return { inputs, recovered };
}

describe("pending-input attachments", () => {
	it("makes the image durable before the record that names it (check 1)", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		const journal = new SessionPendingInputJournal(manager);
		const blobsAtAppend: string[][] = [];
		let queuedIds = 0;
		const inputs = new SessionPendingInputs({
			sessionManager: manager,
			nextQueuedId: () => `q_${++queuedIds}`,
			journal: {
				append: async (record) => {
					blobsAtAppend.push(blobs(manager));
					await journal.append(record);
				},
				read: () => journal.read(),
			},
		});

		await inputs.admit({ clientMessageId: "c-1", text: "look", images: [IMAGE], mode: "followUp" }, () => undefined);

		expect(blobsAtAppend[0]).toHaveLength(1);
	});

	it("keeps the image while its input waits and removes it once the input is removed (check 2)", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		let queuedIds = 0;
		const inputs = new SessionPendingInputs({ sessionManager: manager, nextQueuedId: () => `q_${++queuedIds}` });
		await inputs.admit({ clientMessageId: "c-1", text: "look", images: [IMAGE], mode: "followUp" }, () => undefined);
		await inputs.admit({ clientMessageId: "c-2", text: "other", mode: "followUp" }, () => undefined);
		await inputs.recordCleared(["c-2"]);

		expect(blobs(manager)).toHaveLength(1);

		await inputs.recordCleared(["c-1"]);

		expect(blobs(manager)).toEqual([]);
	});

	it("requeues every queued input from the store on reopen, images read back (single source)", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		let queuedIds = 0;
		const inputs = new SessionPendingInputs({ sessionManager: manager, nextQueuedId: () => `q_${++queuedIds}` });
		await inputs.admit({ clientMessageId: "c-1", text: "look", images: [IMAGE], mode: "followUp" }, () => undefined);
		await inputs.admit({ clientMessageId: "c-2", text: "then", mode: "steer" }, () => undefined);

		const { recovered } = await reopen(manager.getSessionFile() ?? "", dir);

		expect(
			recovered.map((input) => [input.clientMessageId, input.text, input.mode, input.missingAttachments]),
		).toEqual([
			["c-1", "look", "followUp", 0],
			["c-2", "then", "steer", 0],
		]);
		expect(recovered[0]?.images.map(attachmentFingerprint)).toEqual([attachmentFingerprint(IMAGE)]);
	});

	it("requeues the text and reports the loss when an image is missing on reopen (check 3)", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		let queuedIds = 0;
		const inputs = new SessionPendingInputs({ sessionManager: manager, nextQueuedId: () => `q_${++queuedIds}` });
		await inputs.admit({ clientMessageId: "c-1", text: "look", images: [IMAGE], mode: "followUp" }, () => undefined);
		rmSync(blobDir(manager), { recursive: true, force: true });

		const { recovered } = await reopen(manager.getSessionFile() ?? "", dir);

		expect(recovered).toHaveLength(1);
		expect(recovered[0]).toMatchObject({ clientMessageId: "c-1", text: "look", missingAttachments: 1 });
		expect(recovered[0]?.images).toEqual([]);
	});

	it("requeues once per reopen, and a ledger restore of a requeued input is skipped (check 4)", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		let queuedIds = 0;
		const inputs = new SessionPendingInputs({ sessionManager: manager, nextQueuedId: () => `q_${++queuedIds}` });
		await inputs.admit({ clientMessageId: "c-1", text: "look", mode: "followUp" }, () => undefined);
		const file = manager.getSessionFile() ?? "";

		const first = await reopen(file, dir);
		const second = await reopen(file, dir);

		expect(first.recovered.map((input) => input.clientMessageId)).toEqual(["c-1"]);
		expect(second.recovered.map((input) => input.clientMessageId)).toEqual(["c-1"]);
		expect(await second.inputs.restoreHandle("c-1")).toBe("held");
	});

	it("keeps an attachment store with nothing to write untouched", () => {
		const dir = sessionDir();
		const attachments = new PendingInputAttachments({ dir: () => join(dir, "blobs") });

		attachments.save([]);

		expect(existsSync(join(dir, "blobs"))).toBe(false);
	});
});
