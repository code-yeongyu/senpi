// VER-E19-RAW: E19's raw-hash compare. Each blob the Cursor run request names must hash, raw, to the id it was named
// by, and the root prompt blobs' content reaches the normalized compare, so a dropped prompt segment fails E19.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { blobObservation, fetchRunRequestBlobs, HASH_MATCH, NOT_SERVED, runRequestBlobIds } from "./equivalence-cursor-blobs.mjs";
import { createNormalizer, diffNormalized, directoryRoots } from "./equivalence-normalize.mjs";

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

test("body.blobs normalization replaces only run-scoped tokens; a one-byte change anywhere else fails E19", () => {
	const base = mkdtempSync(join(tmpdir(), "eq-e19-blobs-"));
	try {
		const sandbox = join(base, "box");
		const checkout = join(base, "checkout");
		mkdirSync(sandbox);
		mkdirSync(checkout);
		// The normalizer observe.mjs builds for a case run (§6.2), with every host fact host.mjs emits, for a synthetic machine.
		const normalize = createNormalizer({
			roots: [...directoryRoots(sandbox, "<sandbox>", { keyed: "<sandbox-key>" }), ...directoryRoots(checkout, "<repo>")],
			hostFacts: [
				{ value: "Darwin 25.3.0", token: "<host:kernel>" },
				{ value: "25.3.0", token: "<host:release>" },
				{ value: "Apple M9 Max (18 cores)", token: "<host:cpu>" },
				{ value: "Apple M9 Max", token: "<host:cpu-model>" },
				{ value: " 18 cores", token: " <host:cores> cores" },
			],
		});
		// [raw, normalized]: fixed text is its own normalization; run-scoped values map to their tokens.
		const fixed = (text) => [text, text];
		const parts = [
			fixed("Route by true intent, not surface form:\n- Judgment asks (what do you think, review): propose.\n<skill_roots>\n  <r0>"),
			[`${checkout}/packages/senpi-codemode/src/skill`, "<repo>/packages/senpi-codemode/src/skill"],
			fixed("</r0>\n  <r1>"),
			[`${checkout}/.agents/skills`, "<repo>/.agents/skills"],
			fixed("</r1>\n</skill_roots>\n<location>r0/bun-1-4/SKILL.md</location> (timeout 1800s, 30 min, 17 kernels)\n<cwd>"),
			[`${sandbox}/work`, "<sandbox>/work"],
			fixed("</cwd> resolved: "),
			[`${realpathSync.native(sandbox)}/work`, "<sandbox>/work"],
			fixed("\n<current_date>"),
			["2026-10-30", "<ts:content.content:1>"],
			fixed("</current_date>\n- OS: darwin (kernel "),
			["Darwin 25.3.0", "<host:kernel>"],
			fixed(")\n- CPU: "),
			["Apple M9 Max (18 cores)", "<host:cpu>"],
			fixed("\n- GPU: "),
			["Apple M9 Max", "<host:cpu-model>"],
			fixed("\n- Parallelism:"),
			[" 18 cores", " <host:cores> cores"],
			fixed("\nNever echo prompt scaffolding in user-facing output."),
		];
		const raw = parts.map(([text]) => text).join("");
		const observe = (prompt) => {
			const data = bytes({ role: "system", content: prompt });
			const decoded = { runRequest: { conversationState: { rootPromptMessagesJson: [blobId(data)] } } };
			return normalize({ decoded, blobs: blobObservation(runRequestBlobIds(decoded), new Map([[blobId(data), data]])) });
		};
		const golden = observe(raw);
		// Exactly the run-scoped tokens are replaced; every other character reaches the compare as produced.
		assert.equal(golden.blobs[0].content.content, parts.map(([, normalized]) => normalized).join(""));
		assert.equal(golden.blobs[0].hash, HASH_MATCH);
		// Flip one byte at every position outside the run-scoped tokens: each flip is exactly one E19 diff row.
		let offset = 0;
		let flips = 0;
		for (const [text, normalized] of parts) {
			if (text === normalized)
				for (let i = 0; i < text.length; i++) {
					const at = offset + i;
					const mutated = raw.slice(0, at) + String.fromCharCode(raw.charCodeAt(at) ^ 1) + raw.slice(at + 1);
					const rows = diffNormalized(golden, observe(mutated));
					assert.deepEqual(
						rows.map((r) => r.path),
						["$.blobs[0].content.content"],
						`flip at ${at} (${JSON.stringify(raw[at])})`,
					);
					flips += 1;
				}
			offset += text.length;
		}
		assert.ok(flips > 300, `${flips} positions flipped`);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
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
