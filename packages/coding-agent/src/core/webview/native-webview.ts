import { isMainThread } from "node:worker_threads";

/** The slice of Bun's `Bun.WebView` the main-thread service drives (Bun ships no Node types for it). */
export interface NativeWebView extends EventTarget {
	readonly url: string;
	readonly title: string;
	readonly loading: boolean;
	onNavigated: ((url: string, title: string) => void) | null;
	onNavigationFailed: ((error: Error) => void) | null;
	navigate(url: string): Promise<void>;
	close(): void;
}

export interface NativeWebViewClass {
	new (options: Readonly<Record<string, unknown>>): NativeWebView;
	closeAll(): void;
}

function isNativeWebViewClass(value: unknown): value is NativeWebViewClass {
	return typeof value === "function" && typeof Reflect.get(value, "closeAll") === "function";
}

/** `Bun.WebView` when this thread may construct Chrome-backed views: Bun runtime, process main thread. */
export function mainThreadWebViewClass(): NativeWebViewClass | undefined {
	if (!isMainThread) return undefined;
	const bun: unknown = Reflect.get(globalThis, "Bun");
	if (typeof bun !== "object" || bun === null) return undefined;
	const webView: unknown = Reflect.get(bun, "WebView");
	return isNativeWebViewClass(webView) ? webView : undefined;
}
