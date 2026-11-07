// node --test .agents/skills/senpi-qa/scripts/lib/owner-receipt.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { ownerCommand, ownerCoverage, soakOwner } from "./owner-receipt.mjs";

const row = (manifestId, exit) =>
	ownerCommand({ manifestId, kind: manifestId === "QA.live" ? "live" : "soak", argv: ["node", "x.mjs"], childRuntime: "bun", exit });

for (const id of ["QA.live", "QA.soak"]) {
	test(`${id}: a receipt without a commands[].manifest_id row is not coverage`, () => {
		const shapes = [
			{},
			{ commands: [] },
			{ manifest_id: id, kind: "soak", exit: 0 },
			{ commands: [{ kind: "live", exit: 0 }] },
			{ commands: [row(id === "QA.live" ? "QA.soak" : "QA.live", 0)] },
		];
		for (const receipt of shapes) assert.deepEqual(ownerCoverage(receipt, id), { covered: false, code: "OWNER_RECEIPT_MISSING" });
	});

	test(`${id}: the harness row covers the entry only when the run exited 0`, () => {
		assert.deepEqual(ownerCoverage({ commands: [row(id, 0)] }, id), { covered: true, code: null });
		for (const exit of [1, 2, null])
			assert.deepEqual(ownerCoverage({ commands: [row(id, exit)] }, id), { covered: false, code: "OWNER_RECEIPT_FAILED" });
	});
}

const soakRun = (writeBaseline, smoke = false) =>
	soakOwner({ writeBaseline, smoke, argv: ["node", "soak-qa.mjs"], childRuntime: "bun", exit: 0 });

test("a --write-baseline soak run writes a QA.soak.B0 row", () => {
	const owner = soakRun(true);
	assert.equal(owner.manifestId, "QA.soak.B0");
	assert.deepEqual(
		owner.commands.map((command) => command.manifest_id),
		["QA.soak.B0"],
	);
});

test("a compare soak run writes a QA.soak row", () => {
	const owner = soakRun(false);
	assert.equal(owner.manifestId, "QA.soak");
	assert.deepEqual(
		owner.commands.map((command) => command.manifest_id),
		["QA.soak"],
	);
});

test("a smoke soak run writes no coverage row in either mode", () => {
	for (const writeBaseline of [true, false]) assert.deepEqual(soakRun(writeBaseline, true).commands, []);
});

test("a B0 receipt does not cover QA.soak, and a compare receipt does not cover QA.soak.B0", () => {
	const b0 = { commands: soakRun(true).commands };
	const compare = { commands: soakRun(false).commands };
	assert.deepEqual(ownerCoverage(b0, "QA.soak.B0"), { covered: true, code: null });
	assert.deepEqual(ownerCoverage(b0, "QA.soak"), { covered: false, code: "OWNER_RECEIPT_MISSING" });
	assert.deepEqual(ownerCoverage(compare, "QA.soak"), { covered: true, code: null });
	assert.deepEqual(ownerCoverage(compare, "QA.soak.B0"), { covered: false, code: "OWNER_RECEIPT_MISSING" });
});

test("ownerCommand writes the row fields the coverage lookup and the receipt checker read", () => {
	assert.deepEqual(row("QA.soak", 0), {
		manifest_id: "QA.soak",
		kind: "soak",
		argv: ["node", "x.mjs"],
		cwd: "senpi:.",
		child_runtime: "bun",
		exit: 0,
	});
});
