package bridge

// DemuxKind is the top-level classification of a stdout line. The senpi RPC
// stream multiplexes FOUR shapes on stdout; the client routes each by kind
// (rpc-client.ts handleLine + rpc-mode.ts output paths).
type DemuxKind int

const (
	// DemuxEvent is any line that is not one of the three special shapes below.
	// This is the default branch (rpc-client.ts: "else → event").
	DemuxEvent DemuxKind = iota
	// DemuxResponse is a {type:"response", ...} line answering a request.
	DemuxResponse
	// DemuxExtensionUIRequest is a {type:"extension_ui_request", ...} line.
	DemuxExtensionUIRequest
	// DemuxExtensionError is a {type:"extension_error", ...} line
	// (rpc-mode.ts:358-360).
	DemuxExtensionError
)

// String renders the kind for test diagnostics.
func (k DemuxKind) String() string {
	switch k {
	case DemuxResponse:
		return "response"
	case DemuxExtensionUIRequest:
		return "extension_ui_request"
	case DemuxExtensionError:
		return "extension_error"
	case DemuxEvent:
		return "event"
	default:
		return "unknown"
	}
}

// classify maps a top-level "type" discriminant to its DemuxKind. Anything that
// is not response/extension_ui_request/extension_error is an event.
func classify(typ string) DemuxKind {
	switch typ {
	case "response":
		return DemuxResponse
	case "extension_ui_request":
		return DemuxExtensionUIRequest
	case "extension_error":
		return DemuxExtensionError
	default:
		return DemuxEvent
	}
}

// Demux classifies a single stdout line into one of the four top-level shapes
// and returns the decoded Message. A malformed (non-JSON) line returns an error
// so the caller can drop it (rpc-client.ts parity: such lines are ignored).
func Demux(line []byte) (DemuxKind, Message, error) {
	msg, err := DecodeMessage(line)
	if err != nil {
		return DemuxEvent, Message{}, err
	}
	return msg.Kind, msg, nil
}
