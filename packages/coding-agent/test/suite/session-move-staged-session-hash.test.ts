/**
 * senpi#6575: the moved-in entry an import appends names the listed session's hash, and a retry trusts a staged file
 * that carries that entry. So the import hashes the session file it staged and refuses when the two differ, before the
 * entry is written. The collision that showed this is refused earlier (session-move-staged-names); this row reaches
 * the same end another way, by changing the bundle's session file after it was verified.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { MoveBundleInvalidError } from "../../src/core/session-move/bundle.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { setMoveStepHook } from "../../src/core/session-move/move-steps.ts";
import { SESSION_MOVED_IN } from "../../src/core/session-move/ownership.ts";
import { customTypes, MOVE, setup } from "./session-move-fixture.ts";

afterEach(() => setMoveStepHook(undefined));

it("#given a bundle whose session file is replaced by another session file after it was verified #then the import is refused and the move is settled failed as an invalid bundle, #and no session lands, #and what was staged carries no moved-in entry", async () => {
	const { source, cwdB, bundleDir, ledger, readIdentity } = await setup();
	const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8")) as { session: { path: string } };
	const listed = join(bundleDir, manifest.session.path);
	setMoveStepHook((step) => {
		if (step === "import:received")
			writeFileSync(listed, readFileSync(listed, "utf8").replace("remember 42", "remember 43"));
	});

	const refused = importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });

	await expect(refused).rejects.toBeInstanceOf(MoveBundleInvalidError);
	expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "failed", reason: "bundle_invalid" });
	const sessionDir = getDefaultSessionDir(cwdB);
	expect(existsSync(join(sessionDir, basename(source)))).toBe(false);
	const staged = join(sessionDir, ".move-staging", encodeURIComponent(MOVE), basename(source));
	expect(existsSync(staged) ? customTypes(staged) : []).not.toContain(SESSION_MOVED_IN);
});

it("#given a bundle whose sidecar is replaced after it was verified #then the import is refused and the move is settled failed as an invalid bundle, #and no session lands", async () => {
	const { source, cwdB, bundleDir, ledger, readIdentity } = await setup();
	const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8")) as {
		sidecars: { path: string }[];
	};
	const sidecar = manifest.sidecars[0];
	if (sidecar === undefined) throw new Error("the fixture's bundle lists no sidecar");
	const listed = join(bundleDir, sidecar.path);
	setMoveStepHook((step) => {
		if (step === "import:received") writeFileSync(listed, '{"goal":"another"}\n');
	});

	const refused = importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });

	await expect(refused).rejects.toBeInstanceOf(MoveBundleInvalidError);
	expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "failed", reason: "bundle_invalid" });
	expect(existsSync(join(getDefaultSessionDir(cwdB), basename(source)))).toBe(false);
});
