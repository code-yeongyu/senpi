import type { SessionFailureReport } from "../../core/session-failure-report.ts";
import { formatDuration } from "../../utils/duration.ts";
import { theme } from "./theme/theme.ts";

export function formatSessionFailureInfo(report: SessionFailureReport | undefined): string {
	if (!report) return "";
	const failed = report.erroredRequests + report.abortedRequests;
	if (failed === 0) return "";
	const label = (text: string) => theme.fg("dim", text);
	const share = `${(report.failureShare * 100).toFixed(1)}% failed`;
	let info = `\n${theme.bold("Failures")}\n`;
	info += `${label("Requests:")} ${report.requests} ${label(`(${report.erroredRequests} errored, ${report.abortedRequests} aborted, ${share})`)}\n`;
	info += `${label("Time in failed requests:")} ${formatDuration(report.failedDurationMs)}\n`;
	if (report.postFailureRequests > 0) {
		const misses = report.postFailureFullMissRequests;
		const tokens = report.postFailureFullMissInputTokens.toLocaleString();
		info += `${label("Retries after a failure with no cache hit:")} ${misses} of ${report.postFailureRequests} ${label(`(${tokens} uncached input tokens)`)}\n`;
	}
	return info;
}
