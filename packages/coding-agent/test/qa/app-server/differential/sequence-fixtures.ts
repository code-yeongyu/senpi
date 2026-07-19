import { diffTranscripts, parseAllowlist } from "../../../../scripts/qa-app-server/differential/diff.mjs";

export const sequenceCases = [
	{
		name: "gapped monotonic sequences across transcripts",
		oracleSeq: [1, 3],
		candidateSeq: [1, 2],
		invalidCount: 0,
		expected: { index: 1, path: "seq", kind: "sequence", classification: "parity-regression" },
	},
	{
		name: "duplicate sequence within a transcript",
		oracleSeq: [1, 1],
		candidateSeq: [1, 2],
		invalidCount: 1,
		expected: { index: 1, path: "record", kind: "invalid-record", classification: "harness-defect" },
	},
	{
		name: "decreasing sequence within a transcript",
		oracleSeq: [2, 1],
		candidateSeq: [1, 2],
		invalidCount: 1,
		expected: { index: 1, path: "record", kind: "invalid-record", classification: "harness-defect" },
	},
] as const;

export function diffSequenceFixture(fixture: (typeof sequenceCases)[number]) {
	const records = (target: string, sequences: readonly number[]) =>
		sequences.map((seq, index) => ({
			seq,
			direction: "server->client" as const,
			target,
			frame: { method: `event/${index}` },
		}));
	const allowlist = parseAllowlist({
		rules: [
			{
				id: "sequence",
				scenario: "unit",
				classification: "known-gap",
				path: fixture.expected.path,
				rationale: "probe",
			},
		],
	});
	return diffTranscripts({
		scenario: "unit",
		oracle: records("codex", fixture.oracleSeq),
		candidate: records("senpi", fixture.candidateSeq),
		allowlist,
	});
}
