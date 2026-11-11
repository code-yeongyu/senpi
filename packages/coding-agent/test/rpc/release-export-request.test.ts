/**
 * senpi#6267 (P1): how a `release_session` reads its `export` request. It is read before anything is interrupted,
 * staged or sealed, and by the same rule the `export` op reads `inline` and `inlineMaxBytes`, so the two never
 * disagree about what an export was asked for.
 */
import { describe, expect, it } from "vitest";
import { parseReleaseExport } from "../../src/modes/rpc/session-release-export.ts";
import { MOVE_INLINE_MAX_BYTES } from "../../src/modes/rpc/session-move-wire.ts";

const AGENT_DIR = "/agent";
const moveRelease = (fields: Record<string, unknown>) => ({ reason: "move", target: "device-b", ...fields });

describe("the export request of release_session (senpi#6267 P1)", () => {
	it("#given no export field #then nothing is to be exported", () => {
		expect(parseReleaseExport(moveRelease({}), AGENT_DIR)).toEqual({ kind: "none" });
	});

	it("#given an export on a host that keeps no agent directory #then the request is refused before the release", () => {
		expect(parseReleaseExport(moveRelease({ export: { inline: true } }), undefined)).toMatchObject({
			kind: "invalid",
		});
	});

	it("#given inline with no limit, and inline with a limit over the cap #then both ask for the cap", () => {
		expect(parseReleaseExport(moveRelease({ export: { inline: true } }), AGENT_DIR)).toEqual({
			kind: "export",
			agentDir: AGENT_DIR,
			inlineMaxBytes: MOVE_INLINE_MAX_BYTES,
		});
		expect(
			parseReleaseExport(
				moveRelease({ export: { inline: true, inlineMaxBytes: MOVE_INLINE_MAX_BYTES * 4 } }),
				AGENT_DIR,
			),
		).toEqual({ kind: "export", agentDir: AGENT_DIR, inlineMaxBytes: MOVE_INLINE_MAX_BYTES });
	});

	it("#given inline with a smaller limit #then that limit is asked; #given no inline #then the folder answer is asked", () => {
		expect(parseReleaseExport(moveRelease({ export: { inline: true, inlineMaxBytes: 380_000 } }), AGENT_DIR)).toEqual(
			{
				kind: "export",
				agentDir: AGENT_DIR,
				inlineMaxBytes: 380_000,
			},
		);
		expect(parseReleaseExport(moveRelease({ export: {} }), AGENT_DIR)).toEqual({
			kind: "export",
			agentDir: AGENT_DIR,
			inlineMaxBytes: undefined,
		});
	});
});
