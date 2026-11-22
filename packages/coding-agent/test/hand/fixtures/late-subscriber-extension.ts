// A user extension that subscribes to `message_update` only once its session starts and drops the subscription when
// the stream ends, as `pi.on` allows at any time (senpi#5898 review M1).
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

export default function lateSubscriber(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const stop = pi.on("message_update", (event, ctx) => {
			ctx.ui.notify(`update ${event.assistantMessageEvent.type}`);
			if (event.assistantMessageEvent.type === "done") stop();
		});
	});
}
