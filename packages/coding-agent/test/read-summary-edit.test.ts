import { describe, it } from "vitest";
import { summaryRereadEdit, syntheticEditRefusal } from "./support/read-summary-edit-cases.ts";

describe("summary to exact edit (#1639)", () => {
	it("rereads elided LF/CRLF source and edits only intended bytes with both actual tool pairs", summaryRereadEdit);
	it("rejects fabricated view anchors without forbidding a real source ellipsis", syntheticEditRefusal);
});
