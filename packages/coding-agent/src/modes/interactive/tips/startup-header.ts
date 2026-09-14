import type { Component, Container, Text } from "@earendil-works/pi-tui";
import { Spacer } from "@earendil-works/pi-tui";
import { appendTipLine } from "./tip-line.ts";

/**
 * The tip must stay a sibling of the header, never part of its text:
 * `ui.setHeader()` swaps the header component in place (the builtin
 * `prompt-preset` extension does this on every `session_start`), which discards
 * anything embedded inside it.
 */
export function appendStartupHeader(
	container: Container,
	header: Component,
	tipLine: string | undefined,
): Text | undefined {
	container.addChild(new Spacer(1));
	container.addChild(header);

	const tipComponent = tipLine ? appendTipLine(container, tipLine) : undefined;

	container.addChild(new Spacer(1));
	return tipComponent;
}
