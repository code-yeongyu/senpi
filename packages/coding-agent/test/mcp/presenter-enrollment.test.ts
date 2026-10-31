import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { enrollmentFixture, enrollmentProof, enrollmentRequest } from "./fixtures/presenter-enrollment.ts";

afterEach(() => vi.restoreAllMocks());

// #4254: signatures must bind the fixed v2 tuple, not unsigned envelope fields.
it.each([
	{ launchRequestNonce: undefined },
	{ launchRequestNonce: "A".repeat(64) },
	{ purpose: "management" },
	{ installationKeyId: "0".repeat(64) },
	{ launchKind: "reconnect" },
	{ launchKind: "replacement", predecessorHostInstance: null },
	{ predecessorHostInstance: randomUUID() },
	{ executionRealm: ["native", "extra"] },
	{ environmentId: "" },
	{ extraSignedField: "immediate" },
])("refuses invalid v2 authorization fields: %j", async (override) => {
	const fixture = await enrollmentFixture();
	try {
		const peer = fixture.open();
		peer.send(enrollmentRequest(override));
		expect(await peer.next()).toBeUndefined();
	} finally {
		await fixture.close();
	}
});

it.each(["initial", "replacement"])("signs the fixed %s tuple and echoes nonce and incarnation", async (kind) => {
	const fixture = await enrollmentFixture();
	try {
		const peer = fixture.open();
		const request = enrollmentRequest({
			launchKind: kind,
			predecessorHostInstance: kind === "initial" ? null : randomUUID(),
		});
		peer.send(request);
		const challenge = await peer.next();
		expect(challenge).toMatchObject({ type: "challenge", version: 2 });
		const tuple = JSON.parse(String(challenge?.transcript));
		expect(tuple).toEqual([
			"mcp-presenter-enroll-v2",
			"mcp_form",
			request.installationKeyId,
			request.backendGeneration,
			request.launchRequestNonce,
			kind,
			request.predecessorHostInstance,
			["native"],
			request.environmentId,
			challenge?.hostInstance,
			expect.stringMatching(/^[a-f0-9]{64}$/),
			30000,
		]);
		expect(challenge?.transcript).toBe(JSON.stringify(tuple));
		peer.send(enrollmentProof(challenge?.transcript));
		expect(await peer.next()).toMatchObject({
			type: "enrolled",
			version: 2,
			launchRequestNonce: request.launchRequestNonce,
			hostInstance: challenge?.hostInstance,
			backendGeneration: request.backendGeneration,
		});
	} finally {
		await fixture.close();
	}
});

it("refuses a signature over a substituted nonce and burns the launch transaction", async () => {
	const fixture = await enrollmentFixture();
	try {
		const peer = fixture.open();
		const request = enrollmentRequest();
		peer.send(request);
		const challenge = await peer.next();
		const substituted = String(challenge?.transcript).replace(request.launchRequestNonce, "f".repeat(64));
		peer.send(enrollmentProof(substituted));
		expect(await peer.next()).toBeUndefined();
		const replay = fixture.open();
		replay.send(request);
		expect(await replay.next()).toBeUndefined();
	} finally {
		await fixture.close();
	}
});

it("refuses duplicate proof attempts and re-enrollment on the same host", async () => {
	const fixture = await enrollmentFixture();
	try {
		const peer = fixture.open();
		const request = enrollmentRequest();
		peer.send(request);
		const challenge = await peer.next();
		const proof = enrollmentProof(challenge?.transcript);
		peer.send(proof);
		peer.send(proof);
		expect(await peer.next()).toMatchObject({ type: "enrolled" });
		expect(await peer.next()).toBeUndefined();
		const replay = fixture.open();
		replay.send(request);
		expect(await replay.next()).toBeUndefined();
	} finally {
		await fixture.close();
	}
});

it("expires a challenge exactly at its monotonic deadline", async () => {
	const fixture = await enrollmentFixture();
	let now = 100;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	try {
		const peer = fixture.open();
		peer.send(enrollmentRequest());
		const challenge = await peer.next();
		now += 30000;
		peer.send(enrollmentProof(challenge?.transcript));
		expect(await peer.next()).toBeUndefined();
	} finally {
		await fixture.close();
	}
});

it.each([undefined, 1, 3])("keeps unsupported enrollment version %s ordinary-only", async (version) => {
	const fixture = await enrollmentFixture();
	try {
		const peer = fixture.open();
		peer.send(enrollmentRequest({ version }));
		expect(await peer.next()).toEqual({ type: "unavailable", versions: [2] });
		expect(await peer.next()).toBeUndefined();
	} finally {
		await fixture.close();
	}
});
