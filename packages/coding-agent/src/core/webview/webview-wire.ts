/**
 * Messages on one kernel client's MessagePort to the main-thread WebView service. The eval
 * kernel's worker side (`senpi-codemode/src/kernels/js/worker-webview-client.js`) is plain
 * JavaScript and mirrors these shapes; keep the two in sync.
 */

export const WEBVIEW_METHODS = [
	"navigate",
	"evaluate",
	"screenshot",
	"click",
	"type",
	"press",
	"scroll",
	"scrollTo",
	"resize",
	"back",
	"forward",
	"reload",
	"cdp",
] as const;

export type WebViewMethod = (typeof WEBVIEW_METHODS)[number];

export interface WebViewState {
	readonly url: string;
	readonly title: string;
	readonly loading: boolean;
}

export interface WebViewWireError {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
}

export type ClientToService =
	| {
			readonly kind: "create";
			readonly id: number;
			readonly viewId: string;
			readonly options: Readonly<Record<string, unknown>>;
			readonly captureConsole: boolean;
	  }
	| {
			readonly kind: "call";
			readonly id: number;
			readonly viewId: string;
			readonly method: WebViewMethod;
			readonly args: readonly unknown[];
	  }
	| { readonly kind: "close"; readonly viewId: string }
	| { readonly kind: "listen"; readonly viewId: string; readonly event: string }
	| { readonly kind: "close-all"; readonly id: number };

export type WebViewEvent =
	| { readonly type: "console"; readonly args: readonly unknown[] }
	| { readonly type: "navigated"; readonly url: string; readonly title: string }
	| { readonly type: "navigation-failed"; readonly error: WebViewWireError }
	| { readonly type: "dom"; readonly name: string; readonly data: unknown };

export type ServiceToClient =
	| {
			readonly kind: "reply";
			readonly id: number;
			readonly ok: true;
			readonly value: unknown;
			readonly state?: WebViewState;
	  }
	| {
			readonly kind: "reply";
			readonly id: number;
			readonly ok: false;
			readonly error: WebViewWireError;
			readonly state?: WebViewState;
	  }
	| { readonly kind: "event"; readonly viewId: string; readonly event: WebViewEvent };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}

function isMethod(value: unknown): value is WebViewMethod {
	return WEBVIEW_METHODS.some((method) => method === value);
}

/** Parses one message from a kernel worker; anything else is dropped at this boundary. */
export function parseClientMessage(value: unknown): ClientToService | undefined {
	if (!isRecord(value)) return undefined;
	const { kind, id, viewId } = value;
	if (kind === "close-all") return typeof id === "number" ? { kind, id } : undefined;
	if (typeof viewId !== "string") return undefined;
	if (kind === "close") return { kind, viewId };
	if (kind === "listen") return typeof value.event === "string" ? { kind, viewId, event: value.event } : undefined;
	if (typeof id !== "number") return undefined;
	if (kind === "create") {
		const options = isRecord(value.options) ? value.options : {};
		return { kind, id, viewId, options, captureConsole: value.captureConsole === true };
	}
	if (kind === "call" && isMethod(value.method) && Array.isArray(value.args)) {
		return { kind, id, viewId, method: value.method, args: value.args };
	}
	return undefined;
}

export function wireError(error: unknown): WebViewWireError {
	if (!(error instanceof Error)) return { name: "Error", message: String(error) };
	const code = Reflect.get(error, "code");
	return { name: error.name, message: error.message, ...(typeof code === "string" ? { code } : {}) };
}
