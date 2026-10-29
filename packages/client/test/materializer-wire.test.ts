import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseMaterializerFrame } from "../src/materializer-wire.ts";
import { MemoryMaterializerAdapter } from "../src/materializer-memory.ts";
import { MaterializerConsumer } from "../src/materializer.ts";

it("R85.Q7 actual S15a answers, baselines and pre-answer frames still parse unchanged", async () => {
	const fixture = async (name: string) =>
		JSON.parse(
			await readFile(
				new URL(`../../coding-agent/docs/engine-socket/fixtures/admission-routes/${name}.json`, import.meta.url),
				"utf8",
			),
		);
	const answer = await fixture("b-answer");
	const baseline = await fixture("c-baseline");
	const before = await fixture("d-before-answer");
	for (const frame of [answer.answer, baseline.baseline, baseline.page, ...before.frames])
		expect(parseMaterializerFrame(frame)).toEqual({ kind: "legacy", frame });
});

it("R66 N routed envelopes load one payload and apply each effect once", async () => {
	const adapter = new MemoryMaterializerAdapter<string>();
	const consumer = new MaterializerConsumer(adapter);
	let loads = 0;
	for (const admissionId of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
		const parsed = parseMaterializerFrame({
			type: "message_update",
			sessionId: "session",
			admissionId,
			generation: 1,
			materializer: {
				sessionEpoch: "epoch",
				generation: 1,
				sequence: 7,
				controls: [],
				payload: {
					kind: "event",
					id: "payload",
					admissionId: "a",
					sessionEpoch: "epoch",
					sequence: 7,
					componentRef: "record",
					length: 2,
					digest: "0".repeat(64),
				},
			},
		});
		if (parsed.kind !== "unit") throw new Error("expected unit");
		await consumer.acceptEnvelope(parsed.envelope, async () => {
			loads++;
			return "delta";
		});
	}
	expect(loads).toBe(1);
	expect(adapter.snapshot({ sessionId: "session", sessionEpoch: "epoch", generation: 1 })).toEqual({
		frontier: 7,
		effects: ["delta"],
	});
});

it.each([
	{
		controls: [
			{ kind: "seed", token: "cut", sequence: 7 },
			{ kind: "seed", token: "cut", sequence: 7 },
		],
	},
	{ generation: 2 },
	{ sequence: -1 },
])("R66 malformed bounded materializer headers are typed refusals: %j", (patch) => {
	expect(() =>
		parseMaterializerFrame({
			type: "message_update",
			sessionId: "session",
			admissionId: "a",
			generation: 1,
			materializer: { sessionEpoch: "epoch", generation: 1, sequence: 7, controls: [], payload: {}, ...patch },
		}),
	).toThrowError(expect.objectContaining({ code: "invalid_unit" }));
});
