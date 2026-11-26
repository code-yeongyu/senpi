import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { redactIdentityOutput } from "./identity-output.ts";
import { IdentityOutputStream } from "@code-yeongyu/senpi-machine-ops";

it("filters prefixed tokens anywhere and limits human-record masking to its own object", () => {
	const token = "tvk1:" + randomBytes(45).toString("base64url");
	const age = "AGE-SECRET-KEY-1" + "Q".repeat(58);
	const human = { secretKey: "fixture-password", sealedKey: "fixture-box", kind: "human", v: 1 };
	const other = { ...human, kind: "machine" };
	const clean = redactIdentityOutput({ human, other, text: `note ${token} ${age} end` });
	expect(clean.human.secretKey === "[REDACTED]" && clean.human.sealedKey === "[REDACTED]").toBe(true);
	expect(clean.other === other && clean.text === "note [REDACTED] [REDACTED] end").toBe(true);
	const seed = randomBytes(32).toString("base64url");
	for (const [input, expected] of [
		[`prefix ${token} ${age} suffix`, "prefix [REDACTED] [REDACTED] suffix"],
		[`signing = ${seed}\n`, "signing = [REDACTED]\n"],
		[JSON.stringify(human), JSON.stringify({ ...human, secretKey: "[REDACTED]", sealedKey: "[REDACTED]" })],
		[JSON.stringify(other), JSON.stringify(other)],
	]) {
		for (let cut = 0; cut <= input.length; cut++) {
			const stream = new IdentityOutputStream();
			expect(stream.push(input.slice(0, cut)) + stream.push(input.slice(cut)) + stream.finish() === expected).toBe(
				true,
			);
		}
	}
});

it("keeps public comparisons, unknown fields, IDs, pairs and maps intact", () => {
	const rows = [0, 1].map(() => ({
		ek: randomBytes(32).toString("base64url"),
		sk: randomBytes(32).toString("base64url"),
	}));
	const token = rows[0].ek;
	const value = {
		rows,
		extra: token,
		signing: "f".repeat(40),
		sealing: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
		pairs: [["signing", token]],
		map: new Map([["signing", token]]),
	};
	const clean = redactIdentityOutput(value);
	expect(clean.rows.every((row, i) => row.ek === rows[i].ek && row.sk === rows[i].sk)).toBe(true);
	expect(clean.rows[0].ek !== clean.rows[1].ek && clean.rows[0].sk !== clean.rows[1].sk).toBe(true);
	expect(clean.extra === token && clean.pairs[0][1] === token && clean.map.get("signing") === token).toBe(true);
	expect(
		clean.signing === value.signing && clean.sealing === value.sealing && redactIdentityOutput(token) === token,
	).toBe(true);
});

it("splices only the sensitive span, including in nested serialized text", () => {
	const secret = randomBytes(32).toString("base64url");
	const original = `{\n  "z": 12345678901234567890, "signing": "${secret}",\n  "a":1.0, "2":"x", "1":"y", "a":2\n}\n`;
	for (const value of [
		original,
		JSON.stringify({ stdout: original }),
		JSON.stringify({ out: JSON.stringify({ stdout: original }) }),
	])
		expect(redactIdentityOutput(value) === value.replace(secret, "[REDACTED]")).toBe(true);
});

it("keeps the same typed error and code while masking its stack, output and cause", () => {
	const secret = randomBytes(32).toString("base64url");
	const record = JSON.stringify({ signing: secret });
	class Failure extends Error {
		readonly code = "E_TOOL";
		readonly stdout = record;
	}
	const error = new Failure(`command failed: ${record}`, { cause: new Error(record) });
	const result = redactIdentityOutput(error);
	expect(result === error && result instanceof Failure && result.code === "E_TOOL").toBe(true);
	expect([result.message, result.stdout, result.stack, String(result.cause)].every((v) => !v?.includes(secret))).toBe(
		true,
	);
});

it("masks only the accepted numeric-array and binary encoding lengths", () => {
	const a = randomBytes(32),
		b = randomBytes(48);
	for (const name of ["signing", "SEALING", "signingPrivateKey", "sealing_private_key"]) {
		for (const secret of [
			a.toString("base64"),
			a.toString("base64url"),
			a.toString("hex"),
			b.toString("base64"),
			[...a],
		])
			expect(redactIdentityOutput<Record<string, unknown>>({ [name]: secret })[name] === "[REDACTED]").toBe(true);
		for (const other of ["a".repeat(42), "b".repeat(45), [1, 2, 3], [...a.slice(1), 999]])
			expect(redactIdentityOutput<Record<string, unknown>>({ [name]: other })[name] === other).toBe(true);
	}
});
