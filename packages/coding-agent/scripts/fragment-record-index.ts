import { FRAGMENT_LIMITS } from "./fragment-record-source.ts";

export function buildFragmentFixtureIndex(cases: readonly { caseId: string; kind: "valid" | "receiver" }[]) {
	return {
		contract: "CONTRACT-r6",
		section: "B3",
		digestAlgorithm: "sha256",
		digestRulingPending: "S09-Q1",
		digestRule:
			"digest is lowercase hex SHA-256 over the exact raw bytes of one fragment; sourceDigest and binding.digest cover the whole value. Pending the S09-Q1 ruling; a different ruling regenerates every file.",
		limits: FRAGMENT_LIMITS,
		recordRules: [
			"Each record is {offset, length, digest, next, complete, data?}; length <= D raw bytes; data is base64 of those bytes.",
			"Fragments are full D-byte slices except the last; an empty value is one record with length 0.",
			"next is the byte offset of the following record (offset + length) while complete is false, and null on the single final record; an engine's opaque cursor must resolve to that offset.",
			"A D-byte record encodes to 174,764 base64 bytes; with framing <= H it stays <= F.",
		],
		generatorRules: [
			"source.base64 is the whole value. source.generator = { kind: 'segments', params: { segments: [...] } } concatenates source.generator.params.segments in order.",
			"Segment { kind: 'bytes', base64 }: the base64-decoded bytes. Segment { kind: 'repeat', patternBase64, length }: the base64-decoded patternBase64 repeated and cut to length bytes. Segment { kind: 'xorshift32', seed, length }: see the xorshift32 rule.",
			"Segment 'xorshift32': state = seed (uint32); for every 4 output bytes, state ^= state << 13; state ^= state >>> 17; state ^= state << 5 (all uint32), then emit state little-endian, cut to length bytes.",
			"Records of generator cases carry no data: their bytes are source bytes [offset, offset + length). Small cases (source.base64) carry data inline.",
		],
		receiverRules: [
			"kind 'receiver' cases feed input records in order; the receiver must end in expectedOutcome and must not complete, stage as complete, or deliver the value or any other bytes.",
			"fault names the first record or field that must trigger the outcome.",
		],
		regenerate: "node packages/coding-agent/scripts/fragment-record-fixtures.ts --write (senpi repository)",
		cases: cases.map((fixture) => ({ caseId: fixture.caseId, file: `${fixture.caseId}.json`, kind: fixture.kind })),
	};
}
