import { describe, expect, it } from "vitest";
import { SESSION_WORKER_LIMITS } from "./session-worker-protocol.ts";
import { WorkerSecretIds } from "./session-worker-secrets.ts";

const request = (id: string, title = "Credential") => ({
	type: "extension_ui_request",
	id,
	method: "input",
	secret: true,
	title,
});
const settled = (id: string) => ({ type: "secret_input_settled", id, outcome: "answered" });

function requestOfBytes(id: string, bytes: number) {
	return request(id, "x".repeat(bytes - Buffer.byteLength(JSON.stringify(request(id, "")))));
}

describe("WorkerSecretIds admission (senpi#5192)", () => {
	it("admits one request and one settled frame per live id, and nothing after them", () => {
		const ids = new WorkerSecretIds();
		ids.add("a");
		expect(ids.admitFrame("a", request("a"))).toBe(true);
		expect(ids.admitFrame("a", request("a"))).toBe(false);
		expect(ids.admitFrame("a", settled("a"))).toBe(true);
		expect(ids.admitFrame("a", settled("a"))).toBe(false);
		expect(ids.admitFrame("a", request("a"))).toBe(false);
	});

	it("refuses frames for unknown or forgotten ids", () => {
		const ids = new WorkerSecretIds();
		expect(ids.admitFrame("a", request("a"))).toBe(false);
		ids.add("a");
		ids.forget("a");
		expect(ids.admitFrame("a", settled("a"))).toBe(false);
	});

	it("refuses foreign record types without spending a phase", () => {
		const ids = new WorkerSecretIds();
		ids.add("a");
		expect(ids.admitFrame("a", { type: "extension_ui_request_extra", id: "a" })).toBe(false);
		expect(ids.admitFrame("a", { type: "secret_settled", id: "a" })).toBe(false);
		expect(ids.admitFrame("a", { id: "a" })).toBe(false);
		expect(ids.admitFrame("a", request("a"))).toBe(true);
	});

	it("bounds the serialized frame at secretFrameBytes without spending a phase on a refusal", () => {
		const ids = new WorkerSecretIds();
		ids.add("a");
		const limit = SESSION_WORKER_LIMITS.secretFrameBytes;
		expect(ids.admitFrame("a", requestOfBytes("a", limit + 1))).toBe(false);
		expect(ids.admitFrame("a", requestOfBytes("a", limit))).toBe(true);
	});

	it("caps open ids, and settled ids only against the total", () => {
		const ids = new WorkerSecretIds();
		const open = SESSION_WORKER_LIMITS.secretInputs;
		for (let index = 0; index < open; index++) {
			expect(ids.admitsNew()).toBe(true);
			ids.add(`open-${index}`);
		}
		expect(ids.admitsNew()).toBe(false);
		expect(ids.admitFrame("open-0", settled("open-0"))).toBe(true);
		expect(ids.admitsNew()).toBe(true);

		for (let index = 1; index < open; index++) ids.admitFrame(`open-${index}`, settled(`open-${index}`));
		for (let index = open; ids.admitsNew(); index++) {
			ids.add(`open-${index}`);
			ids.admitFrame(`open-${index}`, settled(`open-${index}`));
		}
		expect([...ids.ids()]).toHaveLength(SESSION_WORKER_LIMITS.secretIds);
		ids.forget("open-0");
		expect(ids.admitsNew()).toBe(true);
	});
});
