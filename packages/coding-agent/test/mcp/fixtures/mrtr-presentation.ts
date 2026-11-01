import type { ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import { markMcpFormPresented } from "../../../src/core/mcp-form-types.ts";
import { getMcpMrtrPresentation } from "../../../src/core/mcp-mrtr-presentations.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

export function mrtrTui(
	select: ExtensionUIContext["select"] = async (_title, choices, options) => {
		markMcpFormPresented(options);
		return choices.includes("Submit") ? "Submit" : choices[0];
	},
	input: ExtensionUIContext["input"] = async () => "answer",
	enforcement = false,
) {
	const host = Object.create(InteractiveMode.prototype);
	host.options = { mcpPresenterEnforcement: enforcement };
	const events: unknown[] = [];
	Object.defineProperty(host, "session", {
		configurable: true,
		value: {
			sessionId: "fixture-session",
			admitHumanAnswer() {},
			emitExtensionEvent: (_name: string, data: unknown) => events.push(data),
		},
	});
	host.showExtensionSelector = select;
	host.showExtensionInput = input;
	const ui = host.createExtensionUIContext() as ExtensionUIContext;
	const presentation = getMcpMrtrPresentation(ui);
	if (!presentation) throw new Error("Host did not issue a private presentation");
	return { host, ui, presentation, events, lose: () => host.mcpMrtrPresentationLifetime.abort() };
}
