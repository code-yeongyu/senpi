import type { Container } from "@earendil-works/pi-tui";
import { Spacer, Text } from "@earendil-works/pi-tui";

/**
 * A tip is an aside, never a continuation of the block above it: every surface that shows one keeps
 * a blank line between the preceding content and the tip. The spacer is a sibling rather than the
 * `Text` component's own vertical padding, which would also pad the bottom and double up with the
 * trailing spacers these surfaces already own.
 */
export function appendTipLine(container: Container, tipLine: string): Text {
	container.addChild(new Spacer(1));
	const tip = new Text(tipLine, 1, 0);
	container.addChild(tip);
	return tip;
}
