package bridge

import (
	"testing"
)

// TestDemuxFourShapes asserts the stdout demux classifies each of the FOUR
// top-level shapes correctly (rpc-client.ts parity: response is matched by
// {type:"response"}, then extension_ui_request, then extension_error, else it
// is an event).
func TestDemuxFourShapes(t *testing.T) {
	cases := []struct {
		name string
		line string
		want DemuxKind
	}{
		{
			name: "response",
			line: `{"id":"req_1","type":"response","command":"get_state","success":true,"data":{"thinkingLevel":"off","isStreaming":false,"isCompacting":false,"steeringMode":"all","followUpMode":"all","sessionId":"s","autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}`,
			want: DemuxResponse,
		},
		{
			name: "extension_ui_request",
			line: `{"type":"extension_ui_request","id":"ext-1","method":"confirm","title":"Proceed?","message":"go?"}`,
			want: DemuxExtensionUIRequest,
		},
		{
			name: "extension_error",
			line: `{"type":"extension_error","extensionPath":"/x/e.ts","event":"PostToolUse","error":"boom"}`,
			want: DemuxExtensionError,
		},
		{
			name: "event",
			line: `{"type":"agent_start"}`,
			want: DemuxEvent,
		},
	}

	seen := map[DemuxKind]bool{}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			kind, _, err := Demux([]byte(tc.line))
			if err != nil {
				t.Fatalf("demux %s: %v", tc.name, err)
			}
			if kind != tc.want {
				t.Fatalf("demux %s: kind=%v want=%v", tc.name, kind, tc.want)
			}
			seen[kind] = true
		})
	}

	for _, k := range []DemuxKind{DemuxResponse, DemuxExtensionUIRequest, DemuxExtensionError, DemuxEvent} {
		if !seen[k] {
			t.Fatalf("demux kind %v never exercised", k)
		}
	}
}

// TestDemuxMixedFixture drives the demux over the demux_mixed.jsonl golden,
// which contains exactly one line of each top-level shape.
func TestDemuxMixedFixture(t *testing.T) {
	lines := readFixtureLines(t, "demux_mixed.jsonl")
	if len(lines) != 4 {
		t.Fatalf("demux_mixed.jsonl should have 4 lines, got %d", len(lines))
	}
	want := []DemuxKind{DemuxResponse, DemuxExtensionUIRequest, DemuxExtensionError, DemuxEvent}
	for i, line := range lines {
		kind, _, err := Demux(line)
		if err != nil {
			t.Fatalf("line %d: %v", i, err)
		}
		if kind != want[i] {
			t.Fatalf("line %d: kind=%v want=%v\n  line: %s", i, kind, want[i], line)
		}
	}
}
