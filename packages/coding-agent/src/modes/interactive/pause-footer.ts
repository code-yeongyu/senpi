export const PAUSE_STATUS_KEY = "session-pause";

interface PauseView {
	readonly paused: boolean;
	readonly pausedNoticeCount: number;
	readonly runPaused: boolean;
}

export function pauseFooterText(view: PauseView): string | undefined {
	if (!view.paused && !view.runPaused) return undefined;
	const held = view.pausedNoticeCount === 1 ? "1 update held" : `${view.pausedNoticeCount} updates held`;
	if (view.runPaused) return `Run paused · ${held} · type to continue, /resume to resume the run`;
	return `Paused · ${held} · type to continue, /resume to resume`;
}

export function resumeCommandTarget(view: PauseView): "resume_session" | "session_picker" {
	return view.paused || view.runPaused ? "resume_session" : "session_picker";
}
