// VER-E19-RAW: E19's raw-hash compare. Each blob the Cursor run request names must hash, raw, to the id it was named
// by, and the root prompt blobs' content reaches the normalized compare, so a dropped prompt segment fails E19.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { blobObservation, fetchRunRequestBlobs, HASH_MATCH, NOT_SERVED, runRequestBlobIds } from "./equivalence-cursor-blobs.mjs";
import { createNormalizer, diffNormalized } from "./equivalence-normalize.mjs";

const SANDBOX = "/var/folders/eq-e19-AbC123";
const bytes = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
const blobId = (data) => createHash("sha256").update(data).digest().toString("base64");
const systemBlob = (lines) => bytes({ role: "system", content: lines.join("\n") });
const userBlob = (cwd) => bytes({ role: "user", content: `<environment_context><cwd>${cwd}/work</cwd></environment_context>` });
const FULL = ["Route by true intent:", "- Judgment asks (what do you think, review): propose.", "- Change asks: build."];
const DROPPED = [FULL[0], FULL[2]];

/** One E19-shaped run: the decoded runRequest naming its blobs, and the blobs the client serves for them. */
function run(systemLines, cwd = SANDBOX) {
	const blobs = [systemBlob(systemLines), userBlob(cwd), bytes("\u0008\u0001turn-structure")];
	const [root0, root1, turn] = blobs.map(blobId);
	const decoded = { runRequest: { conversationState: { rootPromptMessagesJson: [root0, root1], turns: [turn] } } };
	return { decoded, served: new Map(blobs.map((data) => [blobId(data), data])) };
}

const normalizeFor = (cwd) => createNormalizer({ roots: [{ prefix: cwd, token: "<sandbox>" }] });
/** O1 as E19 observes it: the run request (ids tokenized) plus the raw-hash `blobs` observation. */
const observeO1 = ({ decoded, served }, cwd = SANDBOX) =>
	normalizeFor(cwd)({ decoded, blobs: blobObservation(runRequestBlobIds(decoded), served) });

test("the run request's blob ids are listed raw, in field order", () => {
	const { decoded } = run(FULL);
	const named = runRequestBlobIds(decoded);
	assert.deepEqual(
		named.map(({ field, index }) => `${field}[${index}]`),
		["rootPromptMessagesJson[0]", "rootPromptMessagesJson[1]", "turns[0]"],
	);
	assert.equal(named[0].id, decoded.runRequest.conversationState.rootPromptMessagesJson[0]);
	assert.deepEqual(runRequestBlobIds({ runRequest: {} }), []);
});

test("a served blob whose sha256 is its raw id matches; root prompt blobs keep their content, turn blobs only the hash", () => {
	const { decoded, served } = run(FULL);
	const observed = blobObservation(runRequestBlobIds(decoded), served);
	assert.deepEqual(
		observed.map((b) => b.hash),
		[HASH_MATCH, HASH_MATCH, HASH_MATCH],
	);
	assert.equal(observed[0].content.content, FULL.join("\n"));
	assert.equal("content" in observed[2], false);
});

test("a blob whose bytes do not hash to its raw id, or that the client does not serve, fails the raw-hash compare", () => {
	const { decoded, served } = run(FULL);
	const [root0, root1] = decoded.runRequest.conversationState.rootPromptMessagesJson;
	const tampered = new Map(served);
	tampered.set(root0, systemBlob(DROPPED));
	tampered.set(root1, new Uint8Array());
	const observed = blobObservation(runRequestBlobIds(decoded), tampered);
	assert.match(observed[0].hash, /^mismatch: sha256\(blob\)=/);
	assert.equal(observed[1].hash, NOT_SERVED);
	const rows = diffNormalized(observeO1({ decoded, served }), normalizeFor(SANDBOX)({ decoded, blobs: observed }));
	assert.ok(rows.some((r) => r.path === "$.blobs[0].hash" && r.golden === HASH_MATCH));
	assert.ok(rows.some((r) => r.path === "$.blobs[1].hash" && r.actual === NOT_SERVED));
});

test("a dropped prompt segment fails E19: invisible to the tokenized ids, visible to the raw-hash blobs", () => {
	const golden = run(FULL);
	const mutated = run(DROPPED);
	// Without the blobs, the one-to-one id tokens hide the changed prompt (the hole VER-E19-RAW closes).
	const idsOnly = (r) => normalizeFor(SANDBOX)({ decoded: r.decoded });
	assert.deepEqual(diffNormalized(idsOnly(golden), idsOnly(mutated)), []);
	const rows = diffNormalized(observeO1(golden), observeO1(mutated));
	assert.deepEqual(rows, [
		{ path: "$.blobs[0].content.content", golden: FULL.join("\n"), actual: DROPPED.join("\n") },
	]);
});

test("run-scoped values in the hashed bytes do not fail the compare: another sandbox, same prompt, equal O1", () => {
	const other = "/private/tmp/eq-e19-XyZ789";
	const a = run(FULL, SANDBOX);
	const b = run(FULL, other);
	// The raw ids differ (the bytes carry the sandbox path), which is why they are never compared against a golden...
	assert.notEqual(
		a.decoded.runRequest.conversationState.rootPromptMessagesJson[1],
		b.decoded.runRequest.conversationState.rootPromptMessagesJson[1],
	);
	// ...while each id matches its own bytes raw and the normalized content agrees.
	assert.deepEqual(diffNormalized(observeO1(a, SANDBOX), observeO1(b, other)), []);
});

test("fetchRunRequestBlobs asks for each named blob once over getBlobArgs and observes the client's replies", async () => {
	const { decoded, served } = run(FULL);
	const entries = [{ case: "runRequest", decoded }];
	const sent = [];
	const server = {
		waitForRun: async () => {},
		waitFor: async (pred) => {
			const hit = entries.find(pred);
			if (!hit) throw new Error("no matching frame");
			return hit;
		},
		send: async (frame) => {
			sent.push(frame);
			const data = served.get(Buffer.from(frame.blobId).toString("base64"));
			entries.push({
				case: "kvClientMessage",
				decoded: { kvClientMessage: { id: frame.id, getBlobResult: { blobData: data.toString("base64") } } },
			});
		},
	};
	const wire = { kvGetBlobFrame: (args) => args };
	const observed = await fetchRunRequestBlobs(server, wire);
	assert.deepEqual(
		sent.map((f) => f.id),
		[1, 2, 3],
	);
	assert.deepEqual(observed, blobObservation(runRequestBlobIds(decoded), served));
});
