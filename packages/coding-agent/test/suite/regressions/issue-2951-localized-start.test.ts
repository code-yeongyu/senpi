import { afterEach, expect, it, vi } from "vitest";
import { processMatchesPidFile, processStartTimeMs } from "../../../src/modes/app-server/daemon/process.ts";

afterEach(() => vi.unstubAllEnvs());

it.each([
	{
		locale: "ko_KR",
		identity: "2026\uB144 10\uC6D4  9\uC77C \uAE08\uC694\uC77C 07\uC2DC 36\uBD84 42\uCD08",
	},
	{ locale: "ja_JP", identity: "\u91D1 10/ 9 07:36:42 2026" },
])("parses stored $locale lstart into the same instant as C-locale identity", async ({ identity }) => {
	vi.stubEnv("TZ", "Asia/Seoul");
	const started = Date.parse("2026-10-08T22:36:42.000Z");
	expect(processStartTimeMs(identity)).toBe(started);
	await expect(
		processMatchesPidFile(
			{ pid: process.pid, processStartTime: identity },
			async () => "Fri Oct  9 07:36:42 2026",
			() => true,
			{ attempts: 1 },
		),
	).resolves.toBe(true);
});

it.each([
	"2026\uB144 2\uC6D4 31\uC77C \uAE08\uC694\uC77C 07\uC2DC 36\uBD84 42\uCD08",
	"\u91D1 13/ 9 07:36:42 2026",
	"\u91D1 2/31 07:36:42 2026",
	"\u91D1 10/ 9 24:36:42 2026",
	"legacy timestamp unavailable",
])("does not infer an identity from invalid stored start %s", (identity) => {
	expect(processStartTimeMs(identity)).toBeUndefined();
});
