import { parentPort, workerData } from "node:worker_threads";
import { registerWebViewBroker } from "../../../coding-agent/src/core/webview/webview-broker.ts";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";

// Stands in for an RPC session worker: the eval kernel host runs off the main thread and reaches
// the WebView service only through the broker port the main thread handed it.
const data: unknown = workerData;
registerWebViewBroker(Reflect.get(Object(data), "webviewBroker"));
const url: unknown = Reflect.get(Object(data), "url");

const kernel = new JavaScriptKernel({ sessionId: "webview-worker-fixture", cwd: process.cwd(), parallelPoolWidth: 1 });
const result = await kernel.run({
	cellId: "open-view",
	code: [
		`globalThis.view = new Bun.WebView({ backend: "chrome", width: 320, height: 240 });`,
		`await view.navigate(${JSON.stringify(url)});`,
		`return await view.evaluate("document.getElementById('greeting').textContent");`,
	].join("\n"),
	timeoutMs: 60_000,
});
parentPort?.postMessage(result);
