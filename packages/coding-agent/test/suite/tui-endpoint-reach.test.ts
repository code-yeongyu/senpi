/**
 * The reachability rule at the unit level: a send issued at the very moment a terminal's endpoint
 * becomes visible - `endpoint.json` linked into place, the fully-ready mark - is admitted `started`,
 * 30 launches out of 30. The sender runs inside that link, before the registration resumes, so every
 * send lands while the endpoint is still mid-registration (lock release, inbox watch, activation).
 * At that moment it reads the session id from the header on disk, writes its inbox entry and sends
 * `wake` over the socket, exactly as a peer does after reading the registry.
 */
import { vi } from "vitest";

const readySeam = vi.hoisted(() => ({ onReady: undefined as ((endpointFile: string) => void) | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		link: async (...args: Parameters<typeof actual.link>) => {
			await actual.link(...args);
			if (String(args[1]).endsWith("endpoint.json")) readySeam.onReady?.(String(args[1]));
		},
	};
});

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionControlAdmission, SessionControlDrain } from "../../src/core/extensions/types.ts";
import { type ControlReply, controlRequest } from "../helpers/session-control-client.ts";
import { startEndpoint } from "../helpers/session-control-fixture.ts";
import { within } from "../helpers/tui-endpoint-seams.ts";
import { createHarness } from "./harness.ts";

const LAUNCHES = 30;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	readySeam.onReady = undefined;
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Send {
	readonly reply: ControlReply | undefined;
	readonly headerId: unknown;
	readonly issuedMidRegistration: boolean;
	readonly error?: string;
}

/** Admits every entry present in the inbox once, and answers each named delivery with its admission. */
function admittingDrain(inboxDir: string): SessionControlDrain {
	const admitted = new Map<string, SessionControlAdmission>();
	return (event) => {
		for (const id of event.delivery_ids ?? []) {
			const entry = join(inboxDir, id);
			if (!admitted.has(id) && existsSync(entry)) {
				unlinkSync(entry);
				admitted.set(id, { delivery_id: id, kind: "started" });
			}
		}
		return { admitted: (event.delivery_ids ?? []).flatMap((id) => admitted.get(id) ?? []) };
	};
}

describe.skipIf(process.platform === "win32")("tui endpoint reachability at fully-ready", () => {
	it(`admits a send issued the moment endpoint.json appears, ${LAUNCHES} launches of ${LAUNCHES}`, async () => {
		const root = await createHarness();
		cleanups.push(() => root.cleanup());
		const agentDir = join(root.tempDir, "agent");
		const sends: Send[] = [];
		for (let launch = 0; launch < LAUNCHES; launch++) {
			const harness = await createHarness({ persistSession: true });
			cleanups.push(() => harness.cleanup());
			const inboxDir = join(harness.tempDir, "inbox");
			const id = `d-${launch}`;
			let registrationReturned = false;
			const sent = Promise.withResolvers<Send>();
			readySeam.onReady = (endpointFile) => {
				readySeam.onReady = undefined;
				const issuedMidRegistration = !registrationReturned;
				try {
					const { socket } = JSON.parse(readFileSync(endpointFile, "utf8"));
					const [header] = readFileSync(harness.sessionManager.getSessionFile() ?? "", "utf8").split("\n");
					const headerId: unknown = JSON.parse(header ?? "{}").id;
					mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
					writeFileSync(join(inboxDir, id), "message");
					controlRequest(socket, { type: "wake", delivery_ids: [id] }).then((reply) =>
						sent.resolve({ reply, headerId, issuedMidRegistration }),
					);
				} catch (error) {
					sent.resolve({ reply: undefined, headerId: undefined, issuedMidRegistration, error: String(error) });
				}
			};
			const fixture = await startEndpoint({ harness, agentDir, drain: admittingDrain(inboxDir) });
			registrationReturned = true;
			cleanups.push(() => fixture.endpoint.dispose());
			const send = await within(sent.promise, 5_000, `the send of launch ${launch}`);
			sends.push(send);
			expect(send).toEqual({
				reply: {
					kind: "answered",
					record: expect.objectContaining({
						success: true,
						data: { admitted: [{ delivery_id: id, kind: "started" }] },
					}),
				},
				headerId: harness.session.sessionId,
				issuedMidRegistration: true,
			});
			await fixture.endpoint.dispose();
		}
		expect(sends).toHaveLength(LAUNCHES);
	}, 120_000);
});
