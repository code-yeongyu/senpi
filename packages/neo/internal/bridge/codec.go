package bridge

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// ErrEmptyLine is returned by DecodeMessage for a blank/whitespace-only line.
var ErrEmptyLine = errors.New("bridge: empty line")

// Message is a decoded protocol line. It preserves the original JSON bytes so
// re-encoding is byte-identical (the round-trip fidelity gate), while exposing
// the discriminants the demux and client need. Kind is the top-level shape.
type Message struct {
	// Type is the top-level "type" discriminant (response|extension_ui_request|
	// extension_error|<event type>).
	Type string
	// Command is set for response lines (RpcResponse.command).
	Command string
	// Method is set for extension_ui_request lines.
	Method string
	// ID is the correlation id (responses and extension_ui_request lines carry one).
	ID string

	raw []byte // original bytes, minus the framing newline

	// Kind is the top-level shape (event / response / extension_ui_request /
	// extension_error).
	Kind DemuxKind
}

// Raw returns the original JSON bytes of the message (no trailing newline).
func (m Message) Raw() []byte { return m.raw }

// AsResponse materializes the typed RpcResponse view. Valid only when
// m.Kind == DemuxResponse.
func (m Message) AsResponse() (Response, error) {
	var r Response
	if err := json.Unmarshal(m.raw, &r); err != nil {
		return Response{}, err
	}
	return r, nil
}

// AsEvent materializes the typed event view, preserving the full payload.
func (m Message) AsEvent() (Event, error) {
	var e Event
	if err := json.Unmarshal(m.raw, &e); err != nil {
		return Event{}, err
	}
	e.Payload = append(json.RawMessage(nil), m.raw...)
	return e, nil
}

// AsExtensionUIRequest materializes the typed extension_ui_request view with all
// per-method fields captured in Fields. Valid only when
// m.Kind == DemuxExtensionUIRequest.
func (m Message) AsExtensionUIRequest() (ExtensionUIRequest, error) {
	var r ExtensionUIRequest
	if err := json.Unmarshal(m.raw, &r); err != nil {
		return ExtensionUIRequest{}, err
	}
	fields := map[string]any{}
	if err := json.Unmarshal(m.raw, &fields); err != nil {
		return ExtensionUIRequest{}, err
	}
	delete(fields, "type")
	delete(fields, "id")
	delete(fields, "method")
	r.Fields = fields
	return r, nil
}

// discriminants is the shallow envelope parsed from every line to classify it
// without fully materializing the payload.
type discriminants struct {
	Type    string `json:"type"`
	Command string `json:"command"`
	Method  string `json:"method"`
	ID      string `json:"id"`
}

// DecodeMessage parses a single JSONL record (without the trailing newline) into
// a typed Message, preserving the raw bytes for byte-equal re-encoding.
func DecodeMessage(line []byte) (Message, error) {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 {
		return Message{}, ErrEmptyLine
	}
	var d discriminants
	if err := json.Unmarshal(line, &d); err != nil {
		return Message{}, err
	}
	// Copy so callers reusing the input buffer (bufio.Scanner) cannot corrupt us.
	cp := make([]byte, len(line))
	copy(cp, line)

	kind := classify(d.Type)
	return Message{
		Kind:    kind,
		Type:    d.Type,
		Command: d.Command,
		Method:  d.Method,
		ID:      d.ID,
		raw:     cp,
	}, nil
}

// EncodeMessage returns the message's original bytes verbatim, guaranteeing a
// byte-equal round-trip.
func EncodeMessage(m Message) ([]byte, error) {
	if m.raw == nil {
		return nil, errors.New("bridge: message has no raw bytes")
	}
	out := make([]byte, len(m.raw))
	copy(out, m.raw)
	return out, nil
}

// SerializeLine encodes a message as a strict JSONL record: its bytes followed
// by a single LF (matching jsonl.ts serializeJsonLine framing).
func SerializeLine(m Message) ([]byte, error) {
	body, err := EncodeMessage(m)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(body)+1)
	out = append(out, body...)
	out = append(out, '\n')
	return out, nil
}

// serializeValue encodes an arbitrary value as a strict JSONL record (bytes +
// LF), used when writing commands to the transport.
func serializeValue(v any) ([]byte, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(body)+1)
	out = append(out, body...)
	out = append(out, '\n')
	return out, nil
}

// LineReader reads strict LF-framed JSONL records from a stream. It mirrors
// jsonl.ts attachJsonlLineReader: split on LF only (never other Unicode
// separators), trimming a trailing CR so CRLF streams are handled.
type LineReader struct {
	sc *bufio.Scanner
}

// NewLineReader wraps r in a JSONL line reader.
func NewLineReader(r io.Reader) *LineReader {
	sc := bufio.NewScanner(r)
	// Allow long lines (event payloads can be large).
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	sc.Split(scanLFLines)
	return &LineReader{sc: sc}
}

// ReadLine returns the next record (CR-trimmed, no LF). io.EOF at end of stream.
func (lr *LineReader) ReadLine() ([]byte, error) {
	if !lr.sc.Scan() {
		if err := lr.sc.Err(); err != nil {
			return nil, err
		}
		return nil, io.EOF
	}
	line := lr.sc.Bytes()
	line = bytes.TrimSuffix(line, []byte("\r"))
	out := make([]byte, len(line))
	copy(out, line)
	return out, nil
}

// scanLFLines is a bufio.SplitFunc that splits ONLY on '\n', so U+2028/U+2029
// inside JSON strings are never treated as record boundaries (jsonl.ts parity).
func scanLFLines(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	if i := bytes.IndexByte(data, '\n'); i >= 0 {
		return i + 1, data[:i], nil
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}
