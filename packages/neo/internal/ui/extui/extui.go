// Package extui renders the extension-UI bridge natively (plan task 13). The RPC
// stream carries extension_ui_request lines with one of ten methods; this package
// turns each into either an interactive Dialog (select / confirm / input /
// editor) that produces an ExtensionUIResponse, or a fire-and-forget Directive
// (notify / setStatus / setWidget / setTitle / set_editor_text) the app shell
// applies to the footer, widget area, terminal title, or editor. The additive
// custom_unsupported notice (task 14) is handled by internal/ui/builtinext.
//
// Every dialog resolves keys through internal/ui/keybindings and colors only
// through internal/theme — no hardcoded key comparisons, no approximated colors.
// The timeout semantics from the RPC types are the caller's concern: the app
// shell arms a timer and, on expiry, sends the default response (cancel / false /
// empty) exactly as the TS bridge does — the dialog itself is timeout-agnostic.
package extui

import (
	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// Deps carries the theme and keybindings every dialog needs.
type Deps struct {
	Theme       *theme.Theme
	Keybindings *keybindings.Manager
}

// Response is the outcome the app shell sends back as an extension_ui_response.
// It carries the request ID so the correlation matches the TS pending map.
type Response struct {
	// Confirmed is set for confirm dialogs (nil otherwise).
	Confirmed *bool
	ID        string
	// Value is the selected/typed text for select/input/editor (empty on cancel).
	Value string
	// Cancelled is true when the user escaped or the request timed out.
	Cancelled bool
}

// Dialog is an interactive extension-UI request awaiting a user response.
type Dialog interface {
	// RequestID returns the originating extension_ui_request id.
	RequestID() string
	// HandleInput feeds one key. done=true means the dialog is finished and resp
	// is the response to send (RequestID already populated).
	HandleInput(data string) (resp Response, done bool)
	// Render lays out the dialog at the given width.
	Render(width int) []string
}

// DirectiveKind classifies a fire-and-forget extension_ui_request.
type DirectiveKind int

const (
	// DirectiveNotify shows a transient notice (info/warning/error).
	DirectiveNotify DirectiveKind = iota
	// DirectiveSetStatus updates a keyed footer status segment.
	DirectiveSetStatus
	// DirectiveSetWidget sets or clears a keyed widget line block.
	DirectiveSetWidget
	// DirectiveSetTitle sets the terminal title.
	DirectiveSetTitle
	// DirectiveSetEditorText replaces the editor text.
	DirectiveSetEditorText
)

// Directive is a decoded fire-and-forget extension_ui_request the app shell
// applies to the shell (footer/widget/title) or the editor.
type Directive struct {
	Kind DirectiveKind

	// notify
	Message    string
	NotifyType string // "info" | "warning" | "error" (default info)

	// setStatus
	StatusKey  string
	StatusText string
	StatusSet  bool // false = clear the key (statusText was undefined)

	// setWidget
	WidgetKey       string
	WidgetLines     []string
	WidgetSet       bool   // false = clear the key (widgetLines was undefined)
	WidgetPlacement string // "aboveEditor" | "belowEditor" (default aboveEditor)

	// setTitle
	Title string

	// set_editor_text
	EditorText string
}

// DialogForRequest routes an extension_ui_request to an interactive Dialog. It
// returns ok=false for fire-and-forget methods (use ApplyRequest) and for the
// additive custom_unsupported notice (handled by builtinext).
func DialogForRequest(req bridge.ExtensionUIRequest, deps Deps) (Dialog, bool) {
	switch req.Method {
	case "select":
		return newSelectDialog(req, deps), true
	case "confirm":
		return newConfirmDialog(req, deps), true
	case "input":
		return newInputDialog(req, deps), true
	case "editor":
		return newEditorDialog(req, deps), true
	default:
		return nil, false
	}
}

// ApplyRequest decodes a fire-and-forget extension_ui_request into a Directive.
// It returns ok=false for interactive methods (use DialogForRequest).
func ApplyRequest(req bridge.ExtensionUIRequest) (Directive, bool) {
	switch req.Method {
	case "notify":
		return Directive{
			Kind:       DirectiveNotify,
			Message:    fieldString(req.Fields, "message"),
			NotifyType: fieldStringOr(req.Fields, "notifyType", "info"),
		}, true
	case "setStatus":
		text, set := fieldOptionalString(req.Fields, "statusText")
		return Directive{
			Kind:       DirectiveSetStatus,
			StatusKey:  fieldString(req.Fields, "statusKey"),
			StatusText: text,
			StatusSet:  set,
		}, true
	case "setWidget":
		lines, set := fieldOptionalStrings(req.Fields, "widgetLines")
		return Directive{
			Kind:            DirectiveSetWidget,
			WidgetKey:       fieldString(req.Fields, "widgetKey"),
			WidgetLines:     lines,
			WidgetSet:       set,
			WidgetPlacement: fieldStringOr(req.Fields, "widgetPlacement", "aboveEditor"),
		}, true
	case "setTitle":
		return Directive{Kind: DirectiveSetTitle, Title: fieldString(req.Fields, "title")}, true
	case "set_editor_text":
		return Directive{Kind: DirectiveSetEditorText, EditorText: fieldString(req.Fields, "text")}, true
	default:
		return Directive{}, false
	}
}

// --- field accessors: the bridge decodes per-method fields into map[string]any ---

func fieldString(fields map[string]any, key string) string {
	if fields == nil {
		return ""
	}
	if v, ok := fields[key].(string); ok {
		return v
	}
	return ""
}

func fieldStringOr(fields map[string]any, key, fallback string) string {
	if v := fieldString(fields, key); v != "" {
		return v
	}
	return fallback
}

// fieldOptionalString distinguishes "" (present, empty) from absent/undefined:
// the TS statusText is `string | undefined`, and undefined means "clear the key".
func fieldOptionalString(fields map[string]any, key string) (string, bool) {
	if fields == nil {
		return "", false
	}
	v, ok := fields[key]
	if !ok || v == nil {
		return "", false
	}
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	return s, true
}

// fieldOptionalStrings mirrors widgetLines: `string[] | undefined`. undefined
// (absent/null) means "clear the key".
func fieldOptionalStrings(fields map[string]any, key string) ([]string, bool) {
	if fields == nil {
		return nil, false
	}
	v, ok := fields[key]
	if !ok || v == nil {
		return nil, false
	}
	arr, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out, true
}

func fieldStrings(fields map[string]any, key string) []string {
	out, _ := fieldOptionalStrings(fields, key)
	return out
}
