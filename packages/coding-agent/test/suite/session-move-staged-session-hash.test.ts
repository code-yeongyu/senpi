/**
 * senpi#6575 and senpi#6571's review: the moved-in entry an import appends names the listed session's hash, a retry
 * trusts a staged file that carries that entry, and sidecars land with the session. So the import hashes every staged
 * copy of the session file and of a sidecar, and refuses when one is not the listed bytes, before the entry is written.
 * The collision that first showed this is refused earlier (session-move-staged-names); these rows reach the same end
 * another way, by changing a file of the bundle after the bundle was verified.
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

type World = Awaited<ReturnType<typeof setup>>;
interface Listing {
	readonly session: { readonly path: string };
	readonly sidecars: readonly { readonly path: string }[];
}

/** Replaces one listed file of the bundle after the bundle was verified and before it is staged. */
function replaceAfterVerification(
	world: World,
	pick: (listing: Listing) => string | undefined,
	bytes: (listed: string) => string,
): void {
	const path = pick(JSON.parse(readFileSync(join(world.bundleDir, "manifest.json"), "utf8")) as Listing);
	if (path === undefined) throw new Error("the fixture's bundle does not list that file");
	const listed = join(world.bundleDir, path);
	setMoveStepHook((step) => {
		if (step === "import:received") writeFileSync(listed, bytes(readFileSync(listed, "utf8")));
	});
}

/** What a bundle whose staged bytes are not the listed ones is owed. */
async function expectRefusedBeforeTheEntry({ source, cwdB, bundleDir, ledger, readIdentity }: World): Promise<void> {
	const refused = importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });

	await expect(refused).rejects.toBeInstanceOf(MoveBundleInvalidError);
	expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "failed", reason: "bundle_invalid" });
	const sessionDir = getDefaultSessionDir(cwdB);
	expect(existsSync(join(sessionDir, basename(source)))).toBe(false);
	const staged = join(sessionDir, ".move-staging", encodeURIComponent(MOVE), basename(source));
	expect(existsSync(staged) ? customTypes(staged) : []).not.toContain(SESSION_MOVED_IN);
}

it("#given a bundle whose session file is replaced by another session file after it was verified #then the import is refused and the move is settled failed as an invalid bundle, #and no session lands, #and what was staged carries no moved-in entry", async () => {
	const world = await setup();
	replaceAfterVerification(
		world,
		(listing) => listing.session.path,
		(listed) => listed.replace("remember 42", "remember 43"),
	);

	await expectRefusedBeforeTheEntry(world);
});

it("#given a bundle whose sidecar is replaced after it was verified #then the import is refused and the move is settled failed as an invalid bundle, #and no session lands, #and what was staged carries no moved-in entry", async () => {
	const world = await setup();
	replaceAfterVerification(
		world,
		(listing) => listing.sidecars[0]?.path,
		() => '{"goal":"another"}\n',
	);

	await expectRefusedBeforeTheEntry(world);
});
