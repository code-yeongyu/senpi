package builtinext

import (
	"encoding/json"
	"strings"
)

// transcript_decode.go holds the message-payload decoding for the transcript
// renderer, split from transcript.go to stay within the pure-LOC ceiling. Ported
// from the SessionMessageEntry / content shapes in session-manager.ts consumed by
// session-observer/loader.ts + transcript.ts.

// TranscriptMessage is the decoded message payload for transcript rendering.
type TranscriptMessage struct {
	Role            string
	Content         json.RawMessage
	CustomType      string
	Command         string // bashExecution
	Output          string // bashExecution
	ToolCallID      string
	ToolName        string
	IsError         bool
	ErrorMessage    string
	Model           string
	ResponseModel   string
	Blocks          []TranscriptBlock
	ContentIsString bool
	ContentString   string
}

// TranscriptBlock is one assistant content block (thinking/text/toolCall) or a
// toolResult content part.
type TranscriptBlock struct {
	Type      string
	Thinking  string
	Text      string
	ToolName  string
	ToolID    string
	Arguments map[string]json.RawMessage
}

// decodeTranscriptMessage decodes a `type:"message"` line's payload.
func decodeTranscriptMessage(raw json.RawMessage) (TranscriptMessage, bool) {
	var env struct {
		Message json.RawMessage `json:"message"`
	}
	if err := json.Unmarshal(raw, &env); err != nil || len(env.Message) == 0 {
		return TranscriptMessage{}, false
	}
	var base struct {
		Role          string          `json:"role"`
		Content       json.RawMessage `json:"content"`
		CustomType    string          `json:"customType"`
		Command       string          `json:"command"`
		Output        string          `json:"output"`
		ToolCallID    string          `json:"toolCallId"`
		ToolName      string          `json:"toolName"`
		IsError       bool            `json:"isError"`
		ErrorMessage  string          `json:"errorMessage"`
		Model         string          `json:"model"`
		ResponseModel string          `json:"responseModel"`
	}
	if err := json.Unmarshal(env.Message, &base); err != nil || base.Role == "" {
		return TranscriptMessage{}, false
	}
	msg := TranscriptMessage{
		Role: base.Role, Content: base.Content, CustomType: base.CustomType,
		Command: base.Command, Output: base.Output, ToolCallID: base.ToolCallID,
		ToolName: base.ToolName, IsError: base.IsError, ErrorMessage: base.ErrorMessage,
		Model: base.Model, ResponseModel: base.ResponseModel,
	}
	// content may be a string or an array of blocks.
	if len(base.Content) > 0 {
		if base.Content[0] == '"' {
			var s string
			if json.Unmarshal(base.Content, &s) == nil {
				msg.ContentIsString = true
				msg.ContentString = s
			}
		} else if base.Content[0] == '[' {
			msg.Blocks = decodeBlocks(base.Content)
		}
	}
	return msg, true
}

func decodeBlocks(raw json.RawMessage) []TranscriptBlock {
	var blocks []struct {
		Type      string                     `json:"type"`
		Thinking  string                     `json:"thinking"`
		Text      string                     `json:"text"`
		Name      string                     `json:"name"`
		ID        string                     `json:"id"`
		Arguments map[string]json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return nil
	}
	out := make([]TranscriptBlock, len(blocks))
	for i, b := range blocks {
		out[i] = TranscriptBlock{Type: b.Type, Thinking: b.Thinking, Text: b.Text, ToolName: b.Name, ToolID: b.ID, Arguments: b.Arguments}
	}
	return out
}

// getTextContentStr mirrors text.ts getTextContent: a string content is
// returned directly; an array yields the newline-joined text of its type:"text"
// parts.
func getTextContentStr(content json.RawMessage) string {
	if len(content) == 0 {
		return ""
	}
	if content[0] == '"' {
		var s string
		if json.Unmarshal(content, &s) == nil {
			return s
		}
		return ""
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(content, &parts); err != nil {
		return ""
	}
	texts := make([]string, 0, len(parts))
	for _, p := range parts {
		if p.Type == "text" {
			texts = append(texts, p.Text)
		}
	}
	return strings.Join(texts, "\n")
}
