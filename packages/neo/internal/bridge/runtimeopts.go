package bridge

import "strings"

// NeoRuntimeOptions is the typed per-connection handshake payload the client
// sends so the daemon builds THIS connection's runtime exactly as the classic
// launcher would. It mirrors
// packages/coding-agent/src/modes/rpc/neo-runtime-options.ts field-for-field.
//
// Every field is a pointer / slice / map so an unset field is omitted from the
// JSON — an omitted field means "classic default" for that flag, matching the TS
// contract. Values are populated by ParseNeoRuntimeArgv from the argv the neo
// launcher (build-argv.ts) forwards.
type NeoRuntimeOptions struct {
	// Provider / model / thinking / auth.
	Provider *string  `json:"provider,omitempty"`
	Model    *string  `json:"model,omitempty"`
	Models   []string `json:"models,omitempty"`
	Thinking *string  `json:"thinking,omitempty"`
	APIKey   *string  `json:"apiKey,omitempty"`

	// Session selection.
	NoSession  *bool   `json:"noSession,omitempty"`
	Session    *string `json:"session,omitempty"`
	SessionID  *string `json:"sessionId,omitempty"`
	SessionDir *string `json:"sessionDir,omitempty"`
	Fork       *string `json:"fork,omitempty"`
	Name       *string `json:"name,omitempty"`
	Resume     *bool   `json:"resume,omitempty"`
	Continue   *bool   `json:"continue,omitempty"`

	// Approval / project trust.
	ProjectTrustOverride *bool `json:"projectTrustOverride,omitempty"`

	// Tool scoping.
	Tools          []string `json:"tools,omitempty"`
	ExcludeTools   []string `json:"excludeTools,omitempty"`
	NoTools        *bool    `json:"noTools,omitempty"`
	NoBuiltinTools *bool    `json:"noBuiltinTools,omitempty"`

	// Resource loading.
	Extensions        []string `json:"extensions,omitempty"`
	Skills            []string `json:"skills,omitempty"`
	PromptTemplates   []string `json:"promptTemplates,omitempty"`
	Themes            []string `json:"themes,omitempty"`
	NoExtensions      *bool    `json:"noExtensions,omitempty"`
	NoSkills          *bool    `json:"noSkills,omitempty"`
	NoPromptTemplates *bool    `json:"noPromptTemplates,omitempty"`
	NoThemes          *bool    `json:"noThemes,omitempty"`
	NoContextFiles    *bool    `json:"noContextFiles,omitempty"`

	// Unknown flags (extension flags): name -> bool|string.
	UnknownFlags map[string]any `json:"unknownFlags,omitempty"`

	// Initial inputs — forwarded RAW; the daemon expands @file/image paths per cwd.
	Messages []string `json:"messages,omitempty"`
	FileArgs []string `json:"fileArgs,omitempty"`
}

// valueFlags maps a --flag that consumes the following token to a setter. Mirrors
// the pushValue calls in build-argv.ts. Comma-joined multi-value flags
// (--models/--tools/--exclude-tools) are split back into slices here.
type argvKind int

const (
	kindString argvKind = iota
	kindStringCSV
	kindBool
)

// argvFlag describes one recognized launcher flag and where it lands in options.
type argvFlag struct {
	kind argvKind
	set  func(o *NeoRuntimeOptions, v string)
	on   func(o *NeoRuntimeOptions)
}

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }

// recognizedFlags is the closed set of flags build-argv.ts can emit, keyed by the
// flag token. A flag not in this table (and not --isolated) is treated as an
// extension (unknown) flag, matching the classic parser's unknownFlags behavior.
var recognizedFlags = map[string]argvFlag{
	"--provider": {kind: kindString, set: func(o *NeoRuntimeOptions, v string) { o.Provider = strPtr(v) }},
	"--model":    {kind: kindString, set: func(o *NeoRuntimeOptions, v string) { o.Model = strPtr(v) }},
	"--models":   {kind: kindStringCSV, set: func(o *NeoRuntimeOptions, v string) { o.Models = splitCSV(v) }},
	"--thinking": {kind: kindString, set: func(o *NeoRuntimeOptions, v string) { o.Thinking = strPtr(v) }},
	"--api-key":  {kind: kindString, set: func(o *NeoRuntimeOptions, v string) { o.APIKey = strPtr(v) }},

	"--session":     {kind: kindString, set: func(o *NeoRuntimeOptions, v string) { o.Session = strPtr(v) }},
	"--session-id":  {kind: kindString, set: func(o *NeoRuntimeOptions, v string) { o.SessionID = strPtr(v) }},
	"--session-dir": {kind: kindString, set: func(o *NeoRuntimeOptions, v string) { o.SessionDir = strPtr(v) }},
	"--fork":        {kind: kindString, set: func(o *NeoRuntimeOptions, v string) { o.Fork = strPtr(v) }},
	"--name":        {kind: kindString, set: func(o *NeoRuntimeOptions, v string) { o.Name = strPtr(v) }},
	"--resume":      {kind: kindBool, on: func(o *NeoRuntimeOptions) { o.Resume = boolPtr(true) }},
	"--continue":    {kind: kindBool, on: func(o *NeoRuntimeOptions) { o.Continue = boolPtr(true) }},
	"--no-session":  {kind: kindBool, on: func(o *NeoRuntimeOptions) { o.NoSession = boolPtr(true) }},

	"--approve":    {kind: kindBool, on: func(o *NeoRuntimeOptions) { o.ProjectTrustOverride = boolPtr(true) }},
	"--no-approve": {kind: kindBool, on: func(o *NeoRuntimeOptions) { o.ProjectTrustOverride = boolPtr(false) }},

	"--tools":            {kind: kindStringCSV, set: func(o *NeoRuntimeOptions, v string) { o.Tools = splitCSV(v) }},
	"--exclude-tools":    {kind: kindStringCSV, set: func(o *NeoRuntimeOptions, v string) { o.ExcludeTools = splitCSV(v) }},
	"--no-tools":         {kind: kindBool, on: func(o *NeoRuntimeOptions) { o.NoTools = boolPtr(true) }},
	"--no-builtin-tools": {kind: kindBool, on: func(o *NeoRuntimeOptions) { o.NoBuiltinTools = boolPtr(true) }},

	"--extension":       {kind: kindString, set: func(o *NeoRuntimeOptions, v string) { o.Extensions = append(o.Extensions, v) }},
	"--skill":           {kind: kindString, set: func(o *NeoRuntimeOptions, v string) { o.Skills = append(o.Skills, v) }},
	"--prompt-template": {kind: kindString, set: func(o *NeoRuntimeOptions, v string) { o.PromptTemplates = append(o.PromptTemplates, v) }},
	"--theme":           {kind: kindString, set: func(o *NeoRuntimeOptions, v string) { o.Themes = append(o.Themes, v) }},

	"--no-extensions":       {kind: kindBool, on: func(o *NeoRuntimeOptions) { o.NoExtensions = boolPtr(true) }},
	"--no-skills":           {kind: kindBool, on: func(o *NeoRuntimeOptions) { o.NoSkills = boolPtr(true) }},
	"--no-prompt-templates": {kind: kindBool, on: func(o *NeoRuntimeOptions) { o.NoPromptTemplates = boolPtr(true) }},
	"--no-themes":           {kind: kindBool, on: func(o *NeoRuntimeOptions) { o.NoThemes = boolPtr(true) }},
	"--no-context-files":    {kind: kindBool, on: func(o *NeoRuntimeOptions) { o.NoContextFiles = boolPtr(true) }},
}

// launcherLocalFlags are consumed before the runtime-options parser (they select
// transport / dev overrides, not a runtime input). They are dropped, not treated
// as extension flags, mirroring the TS carve-out list.
var launcherLocalFlags = map[string]bool{
	"--isolated": true,
}

// ParseNeoRuntimeArgv converts the argv the neo launcher forwards
// (build-argv.ts output) into a NeoRuntimeOptions payload plus any residual args
// it did not consume (there should be none for well-formed launcher argv; the
// residual return exists for defensive callers). Positional (non-flag) tokens are
// initial-input messages; @-prefixed tokens are @file args (the @ is stripped).
func ParseNeoRuntimeArgv(argv []string) (NeoRuntimeOptions, []string) {
	var opts NeoRuntimeOptions
	var rest []string

	for i := 0; i < len(argv); i++ {
		arg := argv[i]

		if launcherLocalFlags[arg] {
			continue
		}

		if strings.HasPrefix(arg, "@") && len(arg) > 1 {
			opts.FileArgs = append(opts.FileArgs, arg[1:])
			continue
		}

		if !strings.HasPrefix(arg, "--") {
			// A positional token is an initial-input message.
			opts.Messages = append(opts.Messages, arg)
			continue
		}

		flag, ok := recognizedFlags[arg]
		if ok {
			if flag.kind == kindBool {
				flag.on(&opts)
				continue
			}
			// value flag: consume the next token.
			if i+1 >= len(argv) {
				// Missing value: treat as residual so nothing is silently lost.
				rest = append(rest, arg)
				continue
			}
			flag.set(&opts, argv[i+1])
			i++
			continue
		}

		// Unrecognized --flag: an extension flag. `--flag value` becomes a string
		// value when the next token is not itself a flag; otherwise boolean-true.
		name := strings.TrimPrefix(arg, "--")
		if i+1 < len(argv) && !strings.HasPrefix(argv[i+1], "--") && !strings.HasPrefix(argv[i+1], "@") {
			setUnknown(&opts, name, argv[i+1])
			i++
			continue
		}
		setUnknown(&opts, name, true)
	}

	return opts, rest
}

func setUnknown(o *NeoRuntimeOptions, name string, value any) {
	if o.UnknownFlags == nil {
		o.UnknownFlags = map[string]any{}
	}
	o.UnknownFlags[name] = value
}

func splitCSV(v string) []string {
	if v == "" {
		return nil
	}
	return strings.Split(v, ",")
}
