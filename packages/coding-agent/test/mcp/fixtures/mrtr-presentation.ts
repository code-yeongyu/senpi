import type { ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import { getMcpMrtrPresentation } from "../../../src/core/mcp-mrtr-presentations.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

export function mrtrTui(
	select: ExtensionUIContext["select"] = async (_title, choices) =>
		choices.includes("Submit") ? "Submit" : choices[0],
	input: ExtensionUIContext["input"] = async () => "answer",
) {
	const host = Object.create(InteractiveMode.prototype);
	const events: unknown[] = [];
	Object.defineProperty(host, "session", {
		configurable: true,
		value: { emitExtensionEvent: (_name: string, data: unknown) => events.push(data) },
	});
	host.showExtensionSelector = select;
	host.showExtensionInput = input;
	const ui = host.createExtensionUIContext() as ExtensionUIContext;
	const presentation = getMcpMrtrPresentation(ui);
	if (!presentation) throw new Error("Host did not issue a private presentation");
	return { host, ui, presentation, events, lose: () => host.mcpMrtrPresentationLifetime.abort() };
}
