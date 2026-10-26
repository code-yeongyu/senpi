import { describe, expect, it } from "vitest";
import { pauseFooterText, resumeCommandTarget } from "../../../src/modes/interactive/pause-footer.ts";

describe("senpi#3811 TUI pause footer and /resume", () => {
	it("shows nothing while nothing is held", () => {
		expect(pauseFooterText({ paused: false, pausedNoticeCount: 0, runPaused: false })).toBeUndefined();
		expect(resumeCommandTarget({ paused: false, pausedNoticeCount: 0, runPaused: false })).toBe("session_picker");
	});

	it("names the held updates and how to continue after a Stop", () => {
		expect(pauseFooterText({ paused: true, pausedNoticeCount: 1, runPaused: false })).toBe(
			"Paused · 1 update held · type to continue, /resume to resume",
		);
		expect(resumeCommandTarget({ paused: true, pausedNoticeCount: 0, runPaused: false })).toBe("resume_session");
	});

	it("says the run is paused when a Stop paused the run this session started", () => {
		expect(pauseFooterText({ paused: true, pausedNoticeCount: 3, runPaused: true })).toBe(
			"Run paused · 3 updates held · type to continue, /resume to resume the run",
		);
		expect(resumeCommandTarget({ paused: false, pausedNoticeCount: 0, runPaused: true })).toBe("resume_session");
	});

	it("shows interrupted recovery controls without claiming zero held updates", () => {
		expect(
			pauseFooterText({
				paused: true,
				pausedNoticeCount: 0,
				runPaused: false,
				pauseView: { records: [{ key: "interrupted-run" }] },
			}),
		).toBe("Interrupted · type to continue, /resume to resume");
	});
});
