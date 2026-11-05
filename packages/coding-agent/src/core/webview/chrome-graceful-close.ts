import type { NativeWebView, NativeWebViewClass } from "./native-webview.ts";
import type { AttachDeadline } from "./webview-readiness.ts";

const EXIT_POLL_MS = 25;

// Bun names the profile it creates for its Chrome `<tmpdir>/.<hex>-<n>.bun-chrome`; only a directory
// of exactly that shape, read from the browser's own command line, is ever removed.
const BUN_PROFILE_ARGUMENT = /(?:^|\s)--user-data-dir=(\S+\.bun-chrome)(?=\s|$)/u;

export function bunChromeProfileDir(command: string): string | undefined {
	return BUN_PROFILE_ARGUMENT.exec(command)?.[1];
}

function closeView(view: NativeWebView): void {
	try {
		view.close();
	} catch {
		// The browser already quit under it.
	}
}

/**
 * Asks Bun's running Chrome to quit through Bun's own DevTools pipe: one more target in that browser,
 * then CDP `Browser.close`. Only a graceful quit lets macOS Chrome delete the `code_sign_clone` copy
 * of itself it runs from, and its singleton dir (senpi#4174); a killed Chrome leaves both behind.
 * Resolves false as soon as the request cannot be made or failed, and never resolves once Chrome
 * accepted it (its pipe then closes under the pending reply), so a caller waits on the exit, not on this.
 */
export function requestBrowserClose(webViewClass: NativeWebViewClass): Promise<boolean> {
	let view: NativeWebView;
	try {
		view = new webViewClass({ backend: "chrome" });
	} catch {
		return Promise.resolve(false);
	}
	const cdp = view.cdp;
	if (typeof cdp !== "function") {
		closeView(view);
		return Promise.resolve(false);
	}
	// Bun has no DevTools session for a view before its first navigation.
	const sent = (async () => {
		await view.navigate("about:blank");
		await cdp.call(view, "Browser.close");
	})();
	return sent.then(
		() => {
			closeView(view);
			return new Promise<boolean>(() => {});
		},
		() => {
			closeView(view);
			return false;
		},
	);
}

/** Resolves true once none of `pids` is alive, false when `deadline` came first. */
export async function exitedWithin(
	pids: readonly number[],
	alive: (pid: number) => boolean,
	deadline: AttachDeadline,
): Promise<boolean> {
	let reached = false;
	void deadline.reached.then(() => {
		reached = true;
	});
	for (;;) {
		if (!pids.some(alive)) return true;
		if (reached) return false;
		let tick: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([deadline.reached, new Promise((resolve) => (tick = setTimeout(resolve, EXIT_POLL_MS)))]);
		clearTimeout(tick);
	}
}
