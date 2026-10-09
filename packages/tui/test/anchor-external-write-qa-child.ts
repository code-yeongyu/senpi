import { MouseRegion } from "../src/components/mouse-region.ts";
import { Text } from "../src/components/text.ts";
import { ProcessTerminal } from "../src/terminal.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";

class ProbeTerminal extends ProcessTerminal {
	override queryCursorPosition() {
		const query = super.queryCursorPosition();
		void query.then((position) => this.setTitle(`QA_CPR_${JSON.stringify(position)}`));
		return query;
	}
}
const terminal = new ProbeTerminal();
terminal.write("\r\n".repeat(14));
class ProbeTui extends TuiMainScreen {
	state() {
		return {
			anchor: this.anchor,
			epoch: this.placementEpoch,
			lines: this.previousLines.length,
			hw: this.hardwareCursorRow,
			mapped: this.resolveFrameLine(24),
		};
	}
}
const tui = new ProbeTui(terminal);
let clicks = 0;
tui.addChild(new Text("one\ntwo\nthree\nfour", 0, 0));
tui.addChild(
	new MouseRegion(new Text("OPTION", 0, 0), (event) => {
		if (event.type === "click") clicks++;
		return event.type === "press" || event.type === "click" ? { handled: true } : undefined;
	}),
);
tui.addInputListener((data) => {
	if (data === "e") {
		process.stderr.write("\n");
		tui.renderNow();
		void terminal.queryCursorPosition().then(() => terminal.setTitle("QA_AFTER_STDERR"));
		return { consume: true };
	}
	if (data === "s") {
		terminal.setTitle(`QA_STATE_${JSON.stringify(tui.state())}`);
		terminal.setTitle(`QA_RESULT_${clicks}`);
		return { consume: true };
	}
	if (data === "q") {
		tui.stop();
		process.exit(0);
	}
	return undefined;
});
tui.start();
tui.acquireMouseCapture("pending-question");
tui.renderNow();
await terminal.queryCursorPosition();
terminal.setTitle("QA_READY");
