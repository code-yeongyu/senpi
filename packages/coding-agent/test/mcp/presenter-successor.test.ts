import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { isRecord } from "../../src/core/extensions/builtin/mcp/modern/form-schema.ts";
import { parsePresenterEnrollment, McpPresenterEnrollment } from "../../src/modes/rpc/mcp-presenter-enrollment.ts";
import { McpPresenterSuccessors } from "../../src/modes/rpc/mcp-presenter-successor.ts";
import { enrollmentKey, enrollmentProof, enrollmentRequest } from "./fixtures/presenter-enrollment.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";

afterEach(() => vi.useRealTimers());

function successorFixture() {
	const predecessor = randomUUID();
	const original = parsePresenterEnrollment(enrollmentRequest());
	if (!original) throw new Error("Invalid test enrollment");
	const stream = new PassThrough();
	const frames: Record<string, unknown>[] = [];
	attachJsonlLineReader(stream, (line) => {
		const value: unknown = JSON.parse(line);
		if (!isRecord(value)) throw new Error("Invalid private frame");
		frames.push(value);
	});
	const owner = {
		stream,
		backendGeneration: original.backendGeneration,
		principal: { id: randomUUID(), key: enrollmentKey.publicKey, enrollment: original },
	};
	const successors = new McpPresenterSuccessors(predecessor, new Set([original.launchRequestNonce]));
	return {
		predecessor,
		original,
		owner,
		frames,
		successors,
		close: () => {
			successors.dispose();
			stream.destroy();
		},
	};
}

// #4254: deferred operations obtain a new permit before starting, never copy the original enrollment.
it.each(["nonce", "predecessor", "backend", "realm", "environment", "kind"])(
	"refuses a substituted or reused successor %s before launch",
	async (field) => {
		const fixture = successorFixture();
		try {
			const pending = fixture.successors.prepare(fixture.owner);
			const prepare = fixture.frames[0];
			expect(prepare).toMatchObject({
				type: "mcp_presenter_successor_prepare",
				predecessorHostInstance: fixture.predecessor,
			});
			const request = enrollmentRequest({
				launchKind: "replacement",
				predecessorHostInstance: fixture.predecessor,
				...(field === "nonce" ? { launchRequestNonce: fixture.original.launchRequestNonce } : {}),
				...(field === "predecessor" ? { predecessorHostInstance: randomUUID() } : {}),
				...(field === "backend" ? { backendGeneration: "other" } : {}),
				...(field === "realm" ? { executionRealm: ["wsl", "distro", "epoch"] } : {}),
				...(field === "environment" ? { environmentId: "other" } : {}),
				...(field === "kind" ? { launchKind: "initial", predecessorHostInstance: null } : {}),
			});
			fixture.successors.receive(fixture.owner.stream, {
				type: "mcp_presenter_successor_authorize",
				id: prepare?.id,
				enrollment: request,
			});
			expect(await pending).toBeUndefined();
			expect(fixture.frames).toHaveLength(1);
		} finally {
			fixture.close();
		}
	},
);

it("expires a pending launch permit instead of retaining it throughout draining", async () => {
	vi.useFakeTimers();
	const fixture = successorFixture();
	try {
		const pending = fixture.successors.prepare(fixture.owner);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(await pending).toBeUndefined();
		expect(fixture.frames).toHaveLength(1);
	} finally {
		fixture.close();
	}
});

it("revokes a prepared launch when its authenticated owner disconnects", async () => {
	const fixture = successorFixture();
	try {
		const pending = fixture.successors.prepare(fixture.owner);
		fixture.successors.revoke(fixture.owner.stream);
		expect(await pending).toBeUndefined();
	} finally {
		fixture.close();
	}
});

it("relays a fresh successor proof once and matches the acknowledgement to its permit", async () => {
	const fixture = successorFixture();
	const hostInstance = randomUUID();
	const child = new McpPresenterEnrollment(hostInstance, "successor-endpoint");
	try {
		const pending = fixture.successors.prepare(fixture.owner);
		expect(await fixture.successors.prepare(fixture.owner)).toBeUndefined();
		const request = enrollmentRequest({ launchKind: "replacement", predecessorHostInstance: fixture.predecessor });
		const id = fixture.frames[0]?.id;
		fixture.successors.receive(fixture.owner.stream, {
			type: "mcp_presenter_successor_authorize",
			id,
			enrollment: request,
		});
		const endpoint = await pending;
		if (!endpoint) throw new Error("Missing authorized endpoint");
		const acknowledged = Promise.withResolvers<void>();
		const observed: Record<string, unknown>[] = [];
		attachJsonlLineReader(fixture.owner.stream, (line) => {
			const value: unknown = JSON.parse(line);
			if (!isRecord(value)) throw new Error("Invalid frame");
			observed.push(value);
			if (value.type === "mcp_presenter_successor_challenge" && isRecord(value.challenge)) {
				const proof = enrollmentProof(value.challenge.transcript);
				fixture.successors.receive(fixture.owner.stream, {
					type: "mcp_presenter_successor_proof",
					id,
					signature: proof.signature,
				});
			} else if (value.type === "mcp_presenter_successor_enrolled") acknowledged.resolve();
		});
		child.bootstrap(endpoint, () => {});
		await acknowledged.promise;
		expect(observed.at(-1)).toMatchObject({
			type: "mcp_presenter_successor_enrolled",
			enrollment: { version: 2, hostInstance, launchRequestNonce: request.launchRequestNonce },
		});
		const replay = fixture.successors.prepare(fixture.owner);
		fixture.successors.receive(fixture.owner.stream, {
			type: "mcp_presenter_successor_authorize",
			id: fixture.frames.at(-1)?.id,
			enrollment: request,
		});
		expect(await replay).toBeUndefined();
	} finally {
		child.dispose();
		fixture.close();
	}
});
