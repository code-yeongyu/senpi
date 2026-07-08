package bridge

import (
	"encoding/json"
	"testing"
	"time"
)

// TestClientSendRawWritesLine asserts SendRaw serializes the value as one JSONL
// line to the transport verbatim — no req_N id is injected — so an
// extension_ui_response keeps its ORIGINAL id.
func TestClientSendRawWritesLine(t *testing.T) {
	ft := newFakeTransport()
	client := NewClient(ft)
	t.Cleanup(func() { _ = client.Close() })

	resp := ExtensionUIResponse{Type: "extension_ui_response", ID: "orig-42", Value: "hello"}
	if err := client.SendRaw(resp); err != nil {
		t.Fatalf("SendRaw: %v", err)
	}

	select {
	case raw := <-ft.fromCli:
		var got ExtensionUIResponse
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("decode written line: %v (%q)", err, raw)
		}
		if got.ID != "orig-42" || got.Value != "hello" || got.Type != "extension_ui_response" {
			t.Fatalf("written line mismatch: %+v", got)
		}
		// The correlation path would inject a req_N id; SendRaw must not.
		var probe map[string]any
		if err := json.Unmarshal(raw, &probe); err != nil {
			t.Fatalf("probe decode: %v", err)
		}
		if idStr, _ := probe["id"].(string); idStr != "orig-42" {
			t.Fatalf("id was rewritten to %q, want the original orig-42", idStr)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("SendRaw wrote nothing to the transport")
	}
}

// TestClientSendRawClosedReturnsError asserts a write on a closed client returns
// the close error rather than panicking on a broken pipe.
func TestClientSendRawClosedReturnsError(t *testing.T) {
	ft := newFakeTransport()
	client := NewClient(ft)
	_ = ft.Close()
	<-client.Done() // let the read loop observe the close and mark the client closed

	if err := client.SendRaw(ExtensionUIResponse{Type: "extension_ui_response", ID: "x"}); err == nil {
		t.Fatalf("SendRaw on a closed client should error")
	}
}
