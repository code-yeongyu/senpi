/**
 * A bundle whose manifest the parser refuses is an invalid bundle, as one that fails verification is. The import of
 * the second records the move failed at once. The import of the first stopped before it used the move's id, so the
 * receiver went on answering `receiving` until the sender cancelled or the ready window passed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MoveBundleInvalidError } from "../../src/core/session-move/bundle.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MOVE, setup } from "./session-move-fixture.ts";

describe("a bundle whose manifest is refused where it is read", () => {
	it("#given a bundle whose manifest lists a path that leaves the bundle #when it is imported #then the import is refused as an invalid bundle, #and the receiver answers failed, bundle_invalid, as it does for a bundle that fails verification", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		const file = join(bundleDir, "manifest.json");
		const manifest = JSON.parse(readFileSync(file, "utf8")) as { sidecars: { path: string; sha256: string }[] };
		manifest.sidecars = [...manifest.sidecars, { path: "files/../escaped.json", sha256: "0".repeat(64) }];
		writeFileSync(file, JSON.stringify(manifest));

		const refused = importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });

		await expect(refused).rejects.toBeInstanceOf(MoveBundleInvalidError);
		expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({
			state: "failed",
			reason: "bundle_invalid",
		});
	});
});
