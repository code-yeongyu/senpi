// S29 with S40 and S31 (brain/hand split): while a device file operation is pending, the brain admits that operation's
// nested requests only on the planes it lets file operations host (a two-sided extension's forwarded tool events), on
// the operation's own lane. Every other plane under a file operation is still refused, as S31 refuses any request whose
// parent is not a live call; a brain that names no such plane refuses them all.
import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { FILE_CHANNEL } from "../../src/execution/device-files.ts";
import { decodePlaneMessage, encodePlaneMessage, type PlaneHandler } from "../../src/execution/plane.ts";
import { MODEL_PLANE } from "../../src/execution/plane-model.ts";
import { decodeRemoteMessage, encodeRemoteMessage } from "../../src/execution/remote-protocol.ts";
import { createRemoteToolHost } from "../../src/execution/remote-tool-host.ts";
import type { TransportSide } from "../../src/transport/transport.ts";
import { cleanups, link } from "./model-plane-fixture.ts";

const FORWARDED = "extension-events";

/** A hand that announces the file channel and reports each file operation and plane answer it receives. */
function rawHand(transport: TransportSide) {
	const files: Array<{ lane: string; executionId: string }> = [];
	const answers: unknown[] = [];
	const wake: Array<() => void> = [];
	const notify = () => {
		for (const resume of wake.splice(0)) resume();
	};
	transport.onFrame((frame) => {
		const plane = decodePlaneMessage(frame.payload);
		if (plane !== undefined) {
			answers.push(plane);
			return notify();
		}
		const message = decodeRemoteMessage(frame.payload);
		if (message.kind === "file") {
			files.push({ lane: frame.lane, executionId: message.executionId });
			notify();
		}
	});
	const until = (ready: () => boolean): Promise<void> =>
		new Promise((resolve) => {
			const check = (): void => (ready() ? resolve() : void wake.push(check));
			check();
		});
	return {
		files,
		hello: () =>
			transport.send(
				"control",
				encodeRemoteMessage({ kind: "hello", instance: "hand-1", durable: false, ops: [FILE_CHANNEL] }),
			),
		firstFile: async () => {
			await until(() => files.length > 0);
			return files[0];
		},
		answer: async (count: number) => {
			await until(() => answers.length >= count);
			return answers[count - 1];
		},
	};
}

function hostWith(brain: TransportSide, filePlanes?: readonly string[]) {
	const echo: PlaneHandler = async (body) => ({ echoed: body as JsonValue });
	const host = createRemoteToolHost({
		transport: brain,
		placement: "split-local",
		planes: { [FORWARDED]: echo, [MODEL_PLANE]: echo },
		...(filePlanes === undefined ? {} : { filePlanes }),
	});
	cleanups.push(() => host.close());
	return host;
}

async function pendingFileOp(filePlanes?: readonly string[]) {
	const { brain, hand } = link();
	const host = hostWith(brain, filePlanes);
	const raw = rawHand(hand);
	await raw.hello();
	void host
		.deviceFiles({ id: "scope-a", root: "/work" })
		.read("/work/note.md")
		.catch(() => undefined);
	const file = await raw.firstFile();
	const ask = (plane: string, childRequestId: string, lane = file.lane) =>
		hand.send(
			lane,
			encodePlaneMessage({ kind: "plane.request", parent: file.executionId, childRequestId, plane, body: "q" }),
		);
	return { raw, file, ask };
}

describe("a pending device file operation's nested requests (S29 with S40)", () => {
	it("serves a forwarded tool event from that operation's lane", async () => {
		const { raw, file, ask } = await pendingFileOp([FORWARDED]);

		await ask(FORWARDED, "c1");

		expect(await raw.answer(1)).toMatchObject({
			kind: "plane.reply",
			parent: file.executionId,
			childRequestId: "c1",
		});
	});

	it("still refuses every other plane under that operation", async () => {
		const { raw, file, ask } = await pendingFileOp([FORWARDED]);

		await ask(MODEL_PLANE, "c1");

		expect(await raw.answer(1)).toEqual({
			kind: "plane.refused",
			parent: file.executionId,
			childRequestId: "c1",
			reason: "parent_terminal",
		});
	});

	it("refuses a forwarded tool event sent on another lane", async () => {
		const { raw, file, ask } = await pendingFileOp([FORWARDED]);

		await ask(FORWARDED, "c1", "scope-b");

		expect(await raw.answer(1)).toMatchObject({
			kind: "plane.refused",
			parent: file.executionId,
			reason: "scope_lane_mismatch",
		});
	});

	it("refuses them all when the brain lets file operations host no plane", async () => {
		const { raw, file, ask } = await pendingFileOp();

		await ask(FORWARDED, "c1");

		expect(await raw.answer(1)).toMatchObject({
			kind: "plane.refused",
			parent: file.executionId,
			reason: "parent_terminal",
		});
	});
});
