import { describe, expect, it } from "vitest";
import {
	AllowlistValidationError,
	assertClassifiedDiff,
	diffTranscripts,
	parseAllowlist,
	UnclassifiedDifferenceError,
} from "../../scripts/qa-app-server/differential/diff.mjs";
import type { TranscriptRecord } from "../../scripts/qa-app-server/differential/normalize.mjs";
import { normalizeTranscript } from "../../scripts/qa-app-server/differential/normalize.mjs";
import { diffSequenceFixture, sequenceCases } from "../qa/app-server/differential/sequence-fixtures.ts";

describe("app-server differential transcript normalization", () => {
	it("maps server IDs stably while preserving JSON-RPC request-response pairing", () => {
		// Given: generated IDs repeated across payloads and a server-request response pair.
		const transcript: TranscriptRecord[] = [
			{
				seq: 1,
				direction: "client->server" as const,
				target: "codex",
				frame: { id: "rpc-7", method: "thread/start", params: {} },
			},
			{
				seq: 2,
				direction: "server->client" as const,
				target: "codex",
				frame: { id: "rpc-7", result: { thread: { id: "01999999-aaaa-7bbb-8ccc-123456789abc" } } },
			},
			{
				seq: 3,
				direction: "server->client" as const,
				target: "codex",
				frame: { method: "thread/started", params: { threadId: "01999999-aaaa-7bbb-8ccc-123456789abc" } },
			},
			{
				seq: 4,
				direction: "server->client" as const,
				target: "codex",
				frame: { id: "server-call-99", method: "item/approval/request", params: {} },
			},
			{
				seq: 5,
				direction: "client->server" as const,
				target: "codex",
				frame: { id: "server-call-99", result: { decision: "accept" } },
			},
		];

		// When: the transcript is normalized.
		const normalized = normalizeTranscript(transcript);

		// Then: the generated ID is stable, but the RPC correlation ID remains unchanged.
		expect(normalized).toEqual([
			{
				seq: 1,
				direction: "client->server",
				target: "codex",
				frame: { id: "rpc-7", method: "thread/start", params: {} },
			},
			{
				seq: 2,
				direction: "server->client",
				target: "codex",
				frame: { id: "rpc-7", result: { thread: { id: "<server-id:1>" } } },
			},
			{
				seq: 3,
				direction: "server->client",
				target: "codex",
				frame: { method: "thread/started", params: { threadId: "<server-id:1>" } },
			},
			{
				seq: 4,
				direction: "server->client",
				target: "codex",
				frame: { id: "<server-id:2>", method: "item/approval/request", params: {} },
			},
			{
				seq: 5,
				direction: "client->server",
				target: "codex",
				frame: { id: "<server-id:2>", result: { decision: "accept" } },
			},
		]);
	});

	it("canonicalizes object keys without reordering frames or arrays", () => {
		// Given: deliberately non-canonical keys and order-sensitive frames/items.
		const transcript: TranscriptRecord[] = [
			{
				seq: 1,
				direction: "server->client" as const,
				target: "senpi",
				frame: {
					z: 1,
					a: { z: 2, a: 3 },
					items: [
						{ z: "first", a: 1 },
						{ z: "second", a: 2 },
					],
				},
			},
			{ seq: 2, direction: "server->client" as const, target: "senpi", frame: { marker: "second-frame" } },
		];

		// When: keys are canonicalized.
		const normalized = normalizeTranscript(transcript);

		// Then: key order is canonical, while frame and array positions are untouched.
		expect(JSON.stringify(normalized[0]?.frame)).toBe(
			'{"a":{"a":3,"z":2},"items":[{"a":1,"z":"first"},{"a":2,"z":"second"}],"z":1}',
		);
		expect(normalized.map((record) => record.seq)).toEqual([1, 2]);
		expect(normalized[1]?.frame).toEqual({ marker: "second-frame" });
	});

	it("normalizes tokens, temp paths, and timestamps without erasing ordinary values", () => {
		// Given: volatile values mixed with stable payload data.
		const transcript = [
			{
				seq: 1,
				direction: "server->client" as const,
				target: "codex",
				frame: {
					result: {
						createdAt: 1_900_000_000,
						emittedAtMs: 1_900_000_001,
						path: "/private/tmp/senpi-cell-a/home/file.txt",
						message: "bearer secret-token at /tmp/senpi-cell-a/work",
						limit: 25,
					},
				},
			},
		];

		// When: explicit cell paths and secrets are normalized.
		const normalized = normalizeTranscript(transcript, {
			tempPaths: ["/tmp/senpi-cell-a"],
			tokens: ["secret-token"],
		});

		// Then: only volatile values change, including macOS's /private/tmp alias.
		expect(normalized[0]?.frame).toEqual({
			result: {
				createdAt: "<timestamp:1>",
				emittedAtMs: "<timestamp:2>",
				limit: 25,
				message: "bearer <token> at <temp:1>/work",
				path: "<temp:1>/home/file.txt",
			},
		});
	});
});

describe("app-server differential classification", () => {
	it.each([
		{
			name: "audience target",
			oracle: { seq: 1, direction: "server->client", target: "codex:subscriber", frame: { method: "event" } },
			candidate: { seq: 1, direction: "server->client", target: "senpi:non-subscriber", frame: { method: "event" } },
			expected: { path: "target", kind: "audience", classification: "parity-regression" },
		},
		{
			name: "direction",
			oracle: { seq: 1, direction: "server->client", target: "codex", frame: { method: "event" } },
			candidate: { seq: 1, direction: "client->server", target: "senpi", frame: { method: "event" } },
			expected: { path: "frame", kind: "frame-order", classification: "parity-regression" },
		},
	] as const)("keeps $name mismatches non-allowlistable", ({ oracle, candidate, expected }) => {
		// Given: an allowlist rule attempts to suppress one structural transcript mismatch.
		const allowlist = parseAllowlist({
			rules: [{ id: "x", scenario: "unit", classification: "known-gap", path: expected.path, rationale: "probe" }],
		});

		// When: the otherwise-identical transcript records are compared.
		const result = diffTranscripts({ scenario: "unit", oracle: [oracle], candidate: [candidate], allowlist });

		// Then: the structural mismatch keeps its automatic blocking classification and no rule ID.
		const structural = result.differences.find((difference) => difference.path === expected.path);
		expect(structural).toEqual(expect.objectContaining(expected));
		expect(structural).not.toHaveProperty("ruleId");
	});

	it.each(sequenceCases)("classifies $name without an allowlist escape", (fixture) => {
		const { expected, invalidCount } = fixture;
		const result = diffSequenceFixture(fixture);
		const structural = result.differences.find((difference) => difference.index === expected.index);
		expect(structural).toEqual(expect.objectContaining(expected));
		expect(structural).not.toHaveProperty("ruleId");
		expect(result.differences.filter(({ kind }) => kind === "invalid-record")).toHaveLength(invalidCount);
	});

	it("assigns each allowlisted difference exactly one of the four classifications", () => {
		// Given: four field differences and one specific, rationalized rule per field.
		const oracle = [
			{
				seq: 1,
				direction: "server->client" as const,
				target: "codex",
				frame: { id: "classify", result: { a: 1, b: 1, c: 1, d: 1 } },
			},
		];
		const candidate = [
			{
				seq: 1,
				direction: "server->client" as const,
				target: "senpi",
				frame: { id: "classify", result: { a: 2, b: 2, c: 2, d: 2 } },
			},
		];
		const classifications = ["parity-regression", "known-gap", "allowlisted-delta", "harness-defect"] as const;
		const allowlist = parseAllowlist({
			rules: classifications.map((classification, index) => ({
				id: `rule-${classification}`,
				scenario: "unit",
				classification,
				path: `frame.result.${String.fromCharCode(97 + index)}`,
				rationale: `The unit fixture exercises ${classification}.`,
				responseId: "classify",
			})),
		});

		// When: the transcripts are diffed.
		const result = diffTranscripts({ scenario: "unit", oracle, candidate, allowlist });

		// Then: every difference receives the intended single classification.
		expect(result.unclassified).toEqual([]);
		expect(result.differences.map((difference) => difference.classification)).toEqual(classifications);
		expect(result.differences.every((difference) => Boolean(difference.rationale))).toBe(true);
	});

	it("fails closed when a difference is not classified", () => {
		// Given: a value difference with no matching rule.
		const oracle = [
			{ seq: 1, direction: "server->client" as const, target: "codex", frame: { id: 1, result: { value: 1 } } },
		];
		const candidate = [
			{ seq: 1, direction: "server->client" as const, target: "senpi", frame: { id: 1, result: { value: 2 } } },
		];
		const result = diffTranscripts({ scenario: "unit", oracle, candidate, allowlist: parseAllowlist({ rules: [] }) });

		// When/Then: the assertion reports an unclassified-difference failure.
		expect(() => assertClassifiedDiff(result)).toThrow(UnclassifiedDifferenceError);
		expect(result.unclassified).toHaveLength(1);
	});

	it("rejects allowlist entries without a nonempty rationale", () => {
		// Given: an allowlist entry whose rationale is whitespace only.
		const invalid = {
			rules: [
				{
					id: "blank-rationale",
					scenario: "unit",
					classification: "known-gap",
					path: "frame.result.value",
					rationale: "   ",
				},
			],
		};

		// When/Then: parsing the checked-in boundary fails before diffing.
		expect(() => parseAllowlist(invalid)).toThrow(AllowlistValidationError);
	});

	it("reports stale scenario rules as harness defects", () => {
		// Given: identical transcripts and a scenario-specific rule that no longer matches anything.
		const transcript = [
			{ seq: 1, direction: "server->client" as const, target: "codex", frame: { id: 1, result: {} } },
		];
		const allowlist = parseAllowlist({
			rules: [
				{
					id: "resolved-gap",
					scenario: "unit",
					classification: "known-gap",
					path: "frame.result.value",
					rationale: "The fixture proves resolved gaps cannot silently leave stale exceptions.",
				},
			],
		});

		// When: the scenario is diffed after the gap has disappeared.
		const result = diffTranscripts({ scenario: "unit", oracle: transcript, candidate: transcript, allowlist });

		// Then: the obsolete rule fails the harness closed as a classified defect.
		expect(result.unclassified).toEqual([]);
		expect(result.differences).toEqual([
			expect.objectContaining({
				path: "allowlist.resolved-gap",
				kind: "stale-allowlist",
				classification: "harness-defect",
			}),
		]);
	});
});
