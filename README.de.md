[English](README.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-br.md) | [Italiano](README.it.md)

# senpi


<p align="center">
  <a href="https://discord.gg/PUwSMR9XNk"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/code-yeongyu/senpi/actions/workflows/ci.yml"><img alt="Build-Status" src="https://img.shields.io/github/actions/workflow/status/code-yeongyu/senpi/ci.yml?style=flat-square&branch=main" /></a>
</p>

> ⚠️ **Experimentell.** senpi ist ein meinungsstarker, sich in aktiver Entwicklung befindlicher Fork von [badlogic/pi-mono](https://github.com/badlogic/pi-mono). Er treibt [Dori](https://sisyphuslabs.ai) unter der Haube an und spiegelt wider, was ein ganz bestimmter KI-Assistent von einer Coding-Agent-Runtime braucht. Nutz ihn; setz aber keine Produktions-Pipeline darauf.

senpi ist ein Wortspiel mit dem Namen „Senpai" und ein vernünftigeres (**sane**) pi mit extra „Batteries included" — ein TypeScript-Monorepo, das den Coding-Agent von pi-mono in `senpi` umbenennt und aufbauend auf dem Upstream ein kuratiertes Set aus integrierten Erweiterungen und Core-Anpassungen mitliefert.

> **Upstream**: [pi-mono](https://github.com/badlogic/pi-mono) von [@mariozechner](https://github.com/badlogic) — Tools zum Entwickeln von KI-Agenten und zum Verwalten von LLM-Deployments.

## Inspiriert von OMO, entwickelt als Coding-Agent-Runtime für Dori

senpi ist aus zwei Einflüssen entstanden:

- **Starker Einfluss von [OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent).** OMO ist das schwergewichtige opencode-Harness mit Discipline Agents (Sisyphus, Hephaestus, Prometheus), [IntentGate](https://factory.ai/news/terminal-bench), Hash-verankerten Edits, Team Mode, in Skills eingebetteten MCPs, Ralph Loop, Todo-Enforcern und vielem mehr. senpi übernimmt viele der prägenden Ideen von OMO (Intent-Gate, dynamischer Prompt, Presets pro Modell, paralleles Tool-Routing, Todo-Fortführung), **hält den Umfang aber so schlank wie möglich**, um nah am Upstream von pi-mono zu bleiben. Stell dir senpi als **eine schlanke Version von OMO** vor, die als einzelne pi-CLI-Binary statt als opencode-Plugin läuft.
- **senpi ist die Coding-Agent-Runtime für [Dori](https://sisyphuslabs.ai).** Dori ist der KI-Assistent von Sisyphus Labs — siehe den [Dori-Hinweis in der README von OMO](https://github.com/code-yeongyu/oh-my-openagent#oh-my-openagent) für mehr Kontext. senpi lässt sich eigenständig nutzen, aber die Designentscheidungen (Formulierung des Intent-Gates, integrierte Erweiterungen, Prompt-Presets pro Modellfamilie, Branding) sind auf das abgestimmt, was Dori beim Ausführen von Code-Aufgaben braucht.

Änderungen am Kerncode sind auf ein Minimum reduziert und werden in [`changes.md`](#fork-strategy)-Dateien neben jedem geänderten Unterverzeichnis dokumentiert, damit Upstream-Merge-Commits überprüfbar bleiben.

| Paket | Beschreibung |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Eigenständige Runtime zur Anwendungskomposition für Services, replizierten State, RPC und Plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Herstellerneutrale Telemetrie-Verträge, Referenzadapter, Konformitätstests und typisierte Schemata |
| **[@earendil-works/pi-ai](packages/ai)** | Einheitliche Multi-Provider-LLM-API (OpenAI, Anthropic, Google usw.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent-Runtime mit Tool-Calling und State-Management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interaktive Coding-Agent-CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal-UI-Bibliothek mit differenziellem Rendering |

## Du kommst von OMO? Empfohlenes Erweiterungs-Setup

Wenn du von [OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent) migrierst, findest du hier die praktische Zuordnung von "Was ich in OMO genutzt habe" zu "Was ich in senpi installieren muss". Vieles von dem, was OMO ausmacht, ist **bereits fest in senpi eingebaut** (keine Installation nötig); der Rest liegt in den [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-)-GitHub-Repos und ist nur ein `senpi install` entfernt.

> senpi ist bewusst schlanker als OMO — eine einzelne CLI-Binary, kein opencode-Plugin. Einige OMO-Konzepte (Discipline Agents, Team Mode, Skills, Hashline, Ralph Loop, `/init-deep`) haben **kein 1:1-Gegenstück in senpi** und sind am Ende dieses Abschnitts aufgeführt. Wenn du diese brauchst, nutze weiterhin OMO.

### Bereits in senpi integriert — keine Installation nötig

| OMO-Feature | senpi-Builtin |
|---|---|
| 🚪 **IntentGate** | [Dynamischer System-Prompt](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) — jeder Prompt beginnt vor der Tool-Nutzung mit einem erzwungenen Intent-Gate. |
| ✅ **Todo Enforcer** | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) + Fortsetzungsschleife, die inaktive Agenten wieder aktiviert. |
| **Modellspezifisches Tuning** ("Model Setup") | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) — Presets für GPT-5.x / Claude Opus 4.{5,6,7} / Kimi K2.6. |
| **Sitzungswiederherstellung / Kontextverwaltung** | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) — adaptive Schwellenwerte, Wiederherstellungs-Tracker, Notfall-Compaction, Kürzung von Tool-Ergebnissen. |
| **Apply-Patch bei GPT-Modellen** | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) — Freiform-`apply_patch` im Codex-Stil mit Lark-Grammatik. |
| **Native Websuche** (Anthropic + OpenAI) | Builtins `anthropic-web-search`, `openai-web-search`. |
| **Bash-Timeout-Disziplin** | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) — Durchsetzung von Standard- und Maximal-Timeouts, Richtlinie im System-Prompt. |
| **Compaction-sichere Tool-Paarung** | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) — entfernt verwaiste `tool_result`-Blöcke. |
| **Berechtigungssystem** (Erlauben/Ablehnen im opencode-Stil) | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) — Regeln, JSONL-Speicherung, TUI-Prompts, Parser-bewusste Muster. |

### Erweiterungen für dein OMO-Setup auswählen

Senpi-Builtins, eigenständige `pi-*`-Erweiterungen und das
[OMO-Senpi-Plugin](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-senpi/plugin)
überschneiden sich. Installiere nicht jedes eigenständige Paket, wenn die Funktion bereits von Senpi oder dem Plugin bereitgestellt wird.

| Funktion | Senpi ohne das OMO-Plugin | Senpi mit dem OMO-Plugin |
|---|---|---|
| LSP | Installiere [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client). | Das Plugin registriert sechs LSP-Tools über seinen mitgelieferten Daemon. Installiere `pi-lsp-client` nur, wenn du gezielt dessen `/lsp`-Inspektor benötigst. |
| AST-grep | Installiere [`pi-ast-grep`](https://github.com/code-yeongyu/pi-ast-grep). | Das Plugin liefert einen AST-grep-Skill, Helfer und Installationsskripte mit. `pi-ast-grep` bleibt optional, falls du die nativen Tools `ast_grep_search` und `ast_grep_replace` nutzen möchtest. |
| Kommentarprüfung | Installiere [`pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker). | Das Plugin registriert seine eigene Comment-Checker-Komponente; installiere die eigenständige Erweiterung nicht zusätzlich. |
| Regeln und verschachtelte `AGENTS.md` | Bereits durch die Builtins `rules` und `nested-agents-md` bereitgestellt. | Ebenso; keine eigenständige Erweiterung erforderlich. |
| Websuche und -abruf | Bereits durch die Builtins `websearch` und `webfetch` bereitgestellt. | Ebenso; keine eigenständige Erweiterung erforderlich. |
| Persistente Ziele | Bereits durch das Builtin `goal` bereitgestellt. | Ebenso; keine eigenständige Erweiterung erforderlich. |
| Subagenten-Profile | [`pi-agent-system`](https://github.com/code-yeongyu/pi-agent-system) unterstützt externe Launcher, die `PI_AGENT_TYPE` oder `SANEPI_AGENT_TYPE` setzen. | Das Plugin übernimmt das Task-/Member-Routing und die Tool-Filterung, sodass `pi-agent-system` normalerweise unnötig ist. Behalte es nur, wenn ein anderer Launcher auf dessen Umgebungsvariablen-Vertrag angewiesen ist. |

Installiere für ein eigenständiges Senpi ohne das OMO-Plugin nur die Funktionen, die nicht bereits integriert sind und die du benötigst:

```bash
senpi install git:github.com/code-yeongyu/pi-lsp-client            # 🛠️  LSP: rename / goto / refs / diagnostics + /lsp inspector
senpi install git:github.com/code-yeongyu/pi-ast-grep              # 🛠️  AST-Grep across 25 languages (auto-downloads sg)
senpi install git:github.com/code-yeongyu/pi-comment-checker       # 💬  Comment Checker — the standalone pi port of OMO's hook

# Optional — only if you used the matching OMO surface:
senpi install git:github.com/code-yeongyu/pi-cua-integration                 # 🖥️  Computer-use bindings (desktop / browser)
senpi install git:github.com/code-yeongyu/pi-anthropic-computer-use          #     Claude-native computer use
senpi install git:github.com/code-yeongyu/pi-anthropic-code-execution        #     Claude-native code execution
senpi install git:github.com/code-yeongyu/pi-google-code-execution           #     Google-native code execution
senpi install git:github.com/code-yeongyu/pi-openai-code-interpreter         #     OpenAI Code Interpreter
senpi install git:github.com/code-yeongyu/pi-anthropic-text-editor           #     Claude-native text editor tool
senpi install git:github.com/code-yeongyu/pi-anthropic-tool-search           #     Claude-native tool search
senpi install git:github.com/code-yeongyu/pi-anthropic-web-fetch             #     Claude-native web fetch
senpi install git:github.com/code-yeongyu/pi-google-google-search            #     Google Search grounding
senpi install git:github.com/code-yeongyu/pi-google-url-context              #     Google URL grounding
senpi install git:github.com/code-yeongyu/pi-openai-api-parallel-tool-calls  #     OpenAI parallel_tool_calls payload support
```

Siehe [Senpi-Pakete](packages/coding-agent/README.md#pi-packages) für den vollständigen Ablauf zum Installieren, Aktualisieren und Entfernen.

### Alle Berechtigungen erlauben (im OMO-Stil)

Bei OMO sind alle Tool-Berechtigungen vorab genehmigt. Um dieses Verhalten in senpi nachzubilden, füge eine Wildcard-Erlaubnisregel zu deinen globalen Einstellungen hinzu:

```bash
mkdir -p ~/.senpi/agent
cat > ~/.senpi/agent/settings.json << 'EOF'
{
  "permission": {
    "*": "allow"
  }
}
EOF
```

Dadurch weist du das Berechtigungssystem an, jeden Tool-Aufruf automatisch und ohne Rückfrage zu genehmigen. Der Schlüssel `"*"` greift bei allen Berechtigungsnamen und `"allow"` gewährt sie bedingungslos. Du kannst dies auch pro Projekt festlegen, indem du dieselbe `settings.json` unter `.senpi/settings.json` im Stammverzeichnis des Projekts ablegst.

> **Hinweis:** Dadurch werden alle interaktiven Berechtigungsabfragen deaktiviert. Tu dies nur, wenn du dem Modell und dem Workspace vertraust, in dem du arbeitest.

### Kein direktes Gegenstück in senpi

Diese Funktionen sind Teil der opencode-Harness-Struktur von OMO und bewusst **nicht** in senpi enthalten:

- **Discipline Agents** (Sisyphus / Hephaestus / Oracle / Librarian / Explore / Multimodal Looker) und der Ein-Wort-Orchestrierungseinstieg **`ultrawork` / `ulw`**.
- **Team Mode** — Lead + bis zu 8 parallele Mitglieder, tmux-Visualisierung, `team_*`-Tool-Familie sowie darauf aufbauende `hyperplan`- / `security-research`-Skills.
- **Hashline / Hash-verankertes Edit-Tool** — senpi bleibt bei den Standard-Tools `edit` / `multiedit` / `apply_patch` von pi. `pi-comment-checker` übernimmt die Validierung nach dem Bearbeiten, für die OMO Hashline nutzt, nur eben ohne `LINE#ID`-Content-Hash-Bezeichner.
- **Skill-System** und **in Skills eingebettete MCPs** — Skills als eigenständiges Konzept (`SKILL.md`, pro Skill abgegrenzte MCP-Server) existieren in senpi nicht.
- **Prometheus-Planer im Interview-Modus** und die selbstreferenzielle Schleife **Ralph Loop / `/ulw-loop`**.
- **`/init-deep`** — es gibt keinen integrierten Generator. Erstelle den hierarchischen `AGENTS.md`-Baum manuell (oder mit einem normalen Agenten-Prompt); die integrierte Erweiterung `nested-agents-md` liest die resultierenden Dateien ein.
- **Integrierter `doctor`-Befehl**, **Kompatibilitätsschicht für Claude Code Hooks/Commands/Skills/Plugins** und der **Agenten-Kategorie-Router** (`visual-engineering` / `deep` / `quick` / `ultrabrain`).

## Du willst mehr? Probier das pi-extensions-Ökosystem aus

senpi liefert ein festes Set an integrierten Erweiterungen mit und belässt es dabei. Die [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-)-GitHub-Repos enthalten das vollständige Erweiterungs-Ökosystem: Einige Pakete sind direkt als Builtins in senpi eingebettet, während die übrigen zusätzlich installiert werden können, wenn du weitere Funktionen wie LSP oder AST-grep benötigst.

### Installierbare Erweiterungen

Diese [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-)-Pakete sind für die Installation als eigenständige senpi/pi-Erweiterungen gedacht:

| Erweiterung | Was sie hinzufügt |
|---|---|
| [`pi-anthropic-code-execution`](https://github.com/code-yeongyu/pi-anthropic-code-execution) | Native Code-Ausführung von Anthropic. |
| [`pi-anthropic-computer-use`](https://github.com/code-yeongyu/pi-anthropic-computer-use) | Anthropic-Computer-Use-Anbindungen. |
| [`pi-anthropic-text-editor`](https://github.com/code-yeongyu/pi-anthropic-text-editor) | Natives Texteditor-Tool von Anthropic. |
| [`pi-anthropic-tool-search`](https://github.com/code-yeongyu/pi-anthropic-tool-search) | Native Tool-Suche von Anthropic. |
| [`pi-anthropic-web-fetch`](https://github.com/code-yeongyu/pi-anthropic-web-fetch) | Native Web-Fetch-Unterstützung von Anthropic. |
| [`pi-ast-grep`](https://github.com/code-yeongyu/pi-ast-grep) | AST-basierte Codesuche und -ersetzung für 25 Sprachen. Lädt `sg` bei der ersten Nutzung automatisch herunter. |
| [`pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) | Prüft die Kommentarqualität nach Datei-Bearbeitungs-Tools und zeigt Warnungen im TUI an. |
| [`pi-cua-integration`](https://github.com/code-yeongyu/pi-cua-integration) | Anbindung von Computer-Use-Aktionen für Desktop- und Browser-Interaktionsflächen. |
| [`pi-google-code-execution`](https://github.com/code-yeongyu/pi-google-code-execution) | Native Code-Ausführung von Google. |
| [`pi-google-google-search`](https://github.com/code-yeongyu/pi-google-google-search) | Google-Search-Grounding. |
| [`pi-google-url-context`](https://github.com/code-yeongyu/pi-google-url-context) | Google-URL-Grounding. |
| [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client) | LSP-Integration: `lsp_rename`, `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics` sowie ein `/lsp`-Inspektor. |
| [`pi-openai-api-parallel-tool-calls`](https://github.com/code-yeongyu/pi-openai-api-parallel-tool-calls) | Unterstützung für OpenAI-`parallel_tool_calls`-Payloads. |
| [`pi-openai-code-interpreter`](https://github.com/code-yeongyu/pi-openai-code-interpreter) | OpenAI Code Interpreter. |

Du kannst jede davon installieren mit:

```bash
senpi install git:github.com/code-yeongyu/pi-ast-grep
senpi install git:github.com/code-yeongyu/pi-lsp-client
# ...substitute any of the package names from the table above.
```

Informationen zum Ablauf für Installation, Update und Entfernen findest du unter [Senpi-Pakete](packages/coding-agent/README.md#pi-packages).

### Bereits als senpi-Builtins mitgelieferte pi-extension-Pakete

Für die normale Nutzung von senpi musst du diese Pakete **nicht** installieren; ihre Funktionalität ist bereits in der Binary enthalten. Diese Tabelle beschränkt sich bewusst auf Pakete, die der aktuell registrierten `builtinExtensions`-Liste entsprechen:

| Paket | Enthalten als | Integrierte Funktion |
|---|---|---|
| [`pi-anthropic-bash`](https://github.com/code-yeongyu/pi-anthropic-bash) | `anthropic-bash` | Native Bash-Tool-Variante von Anthropic. |
| [`pi-anthropic-web-search`](https://github.com/code-yeongyu/pi-anthropic-web-search) | `anthropic-web-search` | Native Websuche-Unterstützung von Anthropic. |
| [`pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch) | `gpt-apply-patch` | `apply_patch`-Tool im Codex-Stil für Durchläufe mit der GPT-Familie. |
| [`pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout) | `bash-timeout` | Standardwerte für Bash-Timeouts, Durchsetzung maximaler Timeouts und Prompt-Richtlinie. |
| [`pi-goal`](https://github.com/code-yeongyu/pi-goal) | `goal` | Persistentes Ziel-Tracking, TUI-Status und Fortsetzungs-Prompts. |
| [`pi-nested-agents-md`](https://github.com/code-yeongyu/pi-nested-agents-md) | `nested-agents-md` | Injiziert automatisch nahegelegene `AGENTS.md`-Dateien für verschachtelte Verzeichnisse. |
| [`pi-openai-web-search`](https://github.com/code-yeongyu/pi-openai-web-search) | `openai-web-search` | Native Websuche über OpenAI Responses. |
| [`pi-rules`](https://github.com/code-yeongyu/pi-rules) | `rules` | Erkennt Projekt- und Benutzer-Regeldateien, einschließlich `AGENTS.md` und `CLAUDE.md`. |
| [`pi-todotools`](https://github.com/code-yeongyu/pi-todotools) | `todowrite` | `todowrite` / `todoread`, Todo-Seitenleistenstatus, Workflow-Prompt-Anleitung und Fortsetzungs-Follow-ups. |
| [`pi-webfetch`](https://github.com/code-yeongyu/pi-webfetch) | `webfetch` | Ruft URL-Inhalte als Markdown, Text oder HTML mit Zeit- und Größenbegrenzung ab. |
| [`pi-websearch`](https://github.com/code-yeongyu/pi-websearch) | `websearch` | Provider-gestützte Websuche mit konfigurationsgesteuerter Aktivierung und quellenbewussten Ergebnissen. |

Weitere Builtins wie `permission-system`, `prompt-preset`, `service-tier`, `tool-pair-guard`, `compaction`, `history-search` und `session-observer` sind senpi-eigene integrierte Erweiterungen ohne installierbare Schwesterpakete.

## Warum "senpi"

`senpi` ist eine kleine Anspielung auf **senpai**, steht aber auch wörtlich für die Positionierung des Projekts: Dieser Fork soll ein **sane** (vernünftigeres) pi sein – mit praktischen Ergänzungen, die die tägliche Arbeit mit Agenten reibungsloser machen, ohne das Kerndesign von Upstream aufzugeben.

Alle Ergänzungen folgen der Extension-First-Philosophie von pi. Änderungen am Core-Quellcode werden auf ein Minimum beschränkt und [in `changes.md`-Dateien dokumentiert](#fork-strategy), damit Upstream-Merge-Commits gut überprüfbar bleiben.

## Was dieser Fork hinzufügt

senpi übernimmt das Extension-First-Design von pi – der Kern bleibt minimal, jedes Feature landet als integrierte Erweiterung (Builtin-Extension). Die Idee dahinter ist, dass ein gezieltes Set an Features oft genug gebraucht wird, um direkt in der Binary zu landen; alles, was du nicht brauchst, lässt sich über ein einziges Flag in den Einstellungen deaktivieren (`disabledBuiltinExtensions` in `settings.json`).

Abgeglichen mit `git diff upstream/main..HEAD` und jeder `changes.md`-Datei im Repo.

### Neue Kern-Subsysteme

| Subsystem | Funktion | Docs |
|-----------|--------------|------|
| **Dynamischer System-Prompt** | Ersetzt den statischen Upstream-Prompt durch einen adaptiven Builder: senpi-Identität → erzwungenes Intent-Gate → strukturierte Aufgabenabarbeitung (parallele Wellen, Explorations-Stopps, Festlegung auf einen Plan) → Verifizierungsstufen → kategorisierte Tool-Referenz → Richtlinien → Stil → optionales Tuning pro Modell. | [`dynamic-prompt/`](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) · [`changes.md`](packages/coding-agent/src/core/dynamic-prompt/changes.md) |
| **Compaction-Pipeline** | Adaptive Schwellenwerte im Plugsuit-Stil, Schutz vor leeren Zusammenfassungen, Hooks für Branch-Zusammenfassungen. Spekulative und Notfall-Compaction mit Wiederherstellungs-Tracker ist als [integrierte Erweiterung `compaction`](#owned-builtin-extensions) umgesetzt. | [`core/compaction/`](packages/coding-agent/src/core/compaction/) · [`changes.md`](packages/coding-agent/src/core/compaction/changes.md) |
| **Neuschreibung der Tool-Call-Middleware** | XML- / Hermes- / YAML+XML- / Gemma4-Text-Tool-Protokolle für Modelle ohne natives Function Calling. Striktes Parsing, Erhalt von Stream-Fehlern. | [`tool-call-middleware/`](packages/ai/src/tool-call-middleware/AGENTS.md) · [`changes.md`](packages/ai/src/tool-call-middleware/changes.md) |

<a id="owned-builtin-extensions"></a>

### Eigene integrierte Erweiterungen

Direkt im Repo und eng an die Interna von senpi gekoppelt. Werden in genau dieser Registrierungsreihenfolge geladen:

| # | Erweiterung | Rolle | Docs |
|---|-----------|------|------|
| 1 | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) | Vollständiger Port des Berechtigungssystems im opencode-Stil – Regeln, JSONL-Speicherung, TUI-Prompts, Parser-gestützte Muster (Bash-Arität, Datei-Globs, Pfade im `apply_patch`-Body), nicht-interaktiver Fallback | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/permission-system/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/permission-system/changes.md) |
| 2 | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) *(vendored)* | Wenn das aktive Modell OpenAI GPT ist, werden `write`/`edit` durch ein freies `apply_patch` im Codex-Stil mit Lark-Grammatik ersetzt. Synchronisiert aus [`code-yeongyu/pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch). | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/AGENTS.md) |
| 3 | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) | Modellspezifische System-Prompt-Presets (gpt-5.x, claude-opus-4-{5,6,7}, kimi-k2-6), die auf dem dynamischen Prompt aufbauen. Gemeinsames Tuning für Dateioperationen im codex-Stil. | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/changes.md) |
| 4 | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) *(vendored)* | `todowrite`- / `todoread`-Tools mit Branch-abhängiger Persistenz, Sidebar-Widget, Workflow-Prompt-Anleitung und einer Fortsetzungsschleife. Synchronisiert aus [`code-yeongyu/pi-todotools`](https://github.com/code-yeongyu/pi-todotools). | — |
| 5 | [`redraws`](packages/coding-agent/src/core/extensions/builtin/redraws.ts) | `/tui`-Befehl, der die kumulierte Anzahl vollständiger TUI-Redraws ausgibt. Wird zum Debuggen des differenziellen Renderings verwendet. | — |
| 6 | [`anthropic-web-search`](packages/coding-agent/src/core/extensions/builtin/anthropic-web-search/) | Natives `web_search`-Tool von Anthropic | — |
| 7 | [`anthropic-bash`](packages/coding-agent/src/core/extensions/builtin/anthropic-bash/) | Native Bash-Tool-Variante von Anthropic | — |
| 8 | [`openai-web-search`](packages/coding-agent/src/core/extensions/builtin/openai-web-search/) | Natives `web_search` für OpenAI Responses | — |
| 9 | [`service-tier`](packages/coding-agent/src/core/extensions/builtin/service-tier.ts) | Fügt `service_tier` (`auto` / `flex` / `priority`) über das modellspezifische Service-Tier oder die Einstellung `openai.serviceTier` in Payloads von OpenAI Responses ein | — |
| 10 | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) *(vendored)* | Fügt Standard- und maximale Bash-Timeouts ein und hängt die Richtlinie an den System-Prompt an. Synchronisiert aus [`code-yeongyu/pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout). | — |
| 11 | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) | Bereinigt Anthropic-Request-Payloads durch Entfernen verwaister `tool_result`-Blöcke – Sicherheit bei der Compaction | — |
| 12 | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) | Richtlinie für spekulative und Notfall-Compaction: Degradations-Monitor, Circuit Breaker, Limit pro Turn, Todo-Überbrückung, Checkpoint-Status, Wiederherstellungs-Tracker, Kürzung von Tool-Ergebnissen | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/compaction/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/compaction/changes.md) |
| 13 | [`history-search`](packages/coding-agent/src/core/extensions/builtin/history-search/) | `/history`-Befehl – durchsucht den Prompt-Verlauf sitzungsübergreifend in einem Overlay | — |
| 14 | [`websearch`](packages/coding-agent/src/core/extensions/builtin/websearch/) | Provider-gestütztes `web_search`-Tool mit konfigurationsgesteuerter Aktivierung, TUI-Status und quellenbasierten Ergebnissen | — |
| 15 | [`webfetch`](packages/coding-agent/src/core/extensions/builtin/webfetch/) | `webfetch`-Tool zum Abrufen von URL-Inhalten als Markdown, Text oder HTML mit Zeit- und Größenlimits | — |
| 16 | [`nested-agents-md`](packages/coding-agent/src/core/extensions/builtin/nested-agents-md/) | Bindet umliegende `AGENTS.md`-Dateien automatisch ein, wenn der Agent aus verschachtelten Verzeichnissen liest | — |
| 17 | [`rules`](packages/coding-agent/src/core/extensions/builtin/rules/) | Erkennt Projekt-Regeldateien automatisch und stellt die Befehle `/rules` / `/reload-rules` bereit | — |
| 18 | [`goal`](packages/coding-agent/src/core/extensions/builtin/goal/) | Tools zur persistenten Zielverfolgung, Footer-Status und Fortsetzungs-Prompts | — |

> Die oben genannten Builtin-Verzeichnisse sind neu gegenüber dem Upstream `pi-mono` – keines davon existiert in `badlogic/pi-mono`. Vendored-Versionen sind in [`external-versions.json`](packages/coding-agent/src/core/extensions/builtin/external-versions.json) festgeschrieben und werden über [`sync-builtin-extensions.mjs`](packages/coding-agent/scripts/sync-builtin-extensions.mjs) aus dem benachbarten `pi-extensions`-Checkout synchronisiert.

### Eigenständige Erweiterungs-Repositories

Diese werden als öffentliche `code-yeongyu/pi-*`-Repositories gepflegt und können über `packages` in der `settings.json` oder mit `senpi install git:github.com/code-yeongyu/<repo>` installiert werden.

| Erweiterung | Repository | Funktion |
|-----------|------------|--------------|
| `pi-comment-checker` | [`code-yeongyu/pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) | Führt `@code-yeongyu/comment-checker` nach `write`, `edit`, `multiedit` und `apply_patch` aus, einschließlich OMO-kompatibler `apply_patch`-Metadaten und Fallback für rohe Codex-Patches; zeigt Warnungen in einem Widget über dem Editor an |

### Globale Standard-Erweiterungen

Werden nicht als Builtins geladen, sondern beim ersten Start einmalig nach `~/.senpi/agent/extensions/` geschrieben, damit du sie lokal bearbeiten oder entfernen kannst.

| Erweiterung | Quelle | Funktion |
|-----------|--------|--------------|
| `diff` | [`diff.ts`](packages/coding-agent/src/core/extensions/builtin/diff.ts) | `/diff`-Befehl – wählt geänderte / gelöschte / neue Dateien aus `git status` aus und öffnet die Diff-Ansicht von VS Code |
| `files` | [`files.ts`](packages/coding-agent/src/core/extensions/builtin/files.ts) | `/files`-Befehl – listet im aktuellen Sitzungs-Branch gelesene / geschriebene / bearbeitete Dateien auf und öffnet die Auswahl in VS Code |
| `prompt-url-widget` | [`prompt-url-widget.ts`](packages/coding-agent/src/core/extensions/builtin/prompt-url-widget.ts) | Erkennt GitHub-PR- und Issue-URLs in Prompts, ruft den Titel über `gh` ab und setzt automatisch den Sitzungsnamen |
| `tps` | [`tps.ts`](packages/coding-agent/src/core/extensions/builtin/tps.ts) | Benachrichtigung zu Tokens pro Sekunde (Input / Output / Cache R/W / Gesamt / verstrichene Zeit) nach jedem Agent-Turn |

### Modifizierte Upstream-Pakete

| Paket | Änderungen | Referenz |
|---------|--------------|-----------|
| [`packages/ai`](packages/ai/AGENTS.md) | Codex-`originator` und User-Agent mit senpi-Branding, gemeinsames Utility zur Reparatur von Tool-Paaren, Unterstützung für benutzerdefinierte/freie Tools in OpenAI Responses für `apply_patch`, Claude Opus 4.7 + Thinking-Level `"max"`, `extraBody`-Durchreichung über alle Provider hinweg, [Neuschreibung der Tool-Call-Middleware](packages/ai/src/tool-call-middleware/AGENTS.md) | [`ai/src/changes.md`](packages/ai/src/changes.md) |
| [`packages/agent`](packages/agent/AGENTS.md) | Parallele Ausgabe von Tool-Abschlüssen (gleichzeitige Finalisierung, Ergebnisse in Quellreihenfolge), Inline-UUIDv7 als Ersatz für die `uuid`-Abhängigkeit, ES2021-kompatible Harness-Diagnose | [`agent/src/changes.md`](packages/agent/src/changes.md) |
| [`packages/tui`](packages/tui/AGENTS.md) | Optimiertes differenzielles Rendering: Fast-Path für Insert-Scroll, Repaint-Fix beim Viewport-Remapping, Regressionstests für das Flicker-Budget (kein vollständiges Leeren nach der Initialisierung, ausgewogenes DECSET 2026) | [`tui/src/changes.md`](packages/tui/src/changes.md) |
| [`packages/coding-agent`](packages/coding-agent/AGENTS.md) | `senpi`-Branding, Steuerung der Modellkonfiguration (`upstreamModelId`, `serviceTier`, favorisierte Modelle, Deaktivieren/Whitelist/Blacklist), nicht-blockierende Tool-Erkennung beim Start, deaktivierte Update-Prüfungen beim Start, [Austausch von `promptSnippet` in Bash gegen `rg`](packages/coding-agent/src/core/tools/AGENTS.md), Fast-Path für generierte Standard-Erweiterungen, ausgehende Identität mit senpi-Branding | Mehrere [`changes.md`](packages/coding-agent/src/)-Dateien |

### Weitere Branding- und Laufzeitänderungen

| Änderung | Details |
|--------|---------|
| **`senpi`-CLI-Identität** | Der Coding-Agent identifiziert sich selbst als `senpi`, nutzt `.senpi/agent` zur Speicherung der Konfiguration und wird auf npm als `@code-yeongyu/senpi` veröffentlicht. Die installierte ausführbare Datei bleibt `senpi`. |
| **Ausgehende Identität mit senpi-Branding** | Jede ausgehende Anfrage sendet `senpi` anstelle von `pi`: `User-Agent` (Update-Prüfung + Cloudflare + GitHub-Releases), `X-OpenRouter-Title`, OpenAI Codex `originator` + User-Agent. |
| **Keine Update-Prüfungen beim Start** | Die Versionsprüfung über die npm-Registry sowie Hinweise auf Paket-Updates beim Start wurden entfernt. |
| **UI-Gruppierung für integrierte Erweiterungen** | Builtins werden im Start-Header unter einer `builtin/`-Gruppe dargestellt und sind so optisch von Benutzer- und Projekterweiterungen getrennt. |
| **Aktualisierte Modell-Registry** | `models.generated.ts` wurde mit den neuesten Modellergänzungen und -abkündigungen aktualisiert. |
| **Ziel für Selbst-Updates** | `senpi update senpi` fragt Releases von [`code-yeongyu/senpi`](https://github.com/code-yeongyu/senpi) ab, nicht den Upstream. |

<a id="fork-strategy"></a>

## Fork-Strategie

Dieser Fork führt regelmäßig ein Rebase auf `upstream/main` durch. Um Merge-Konflikte zu minimieren:

1. **Extension-first**: Alle Features nutzen das [Erweiterungssystem](packages/coding-agent/docs/extensions.md) von pi als integrierte Erweiterungen.
2. **Core-Änderungen dokumentieren**: Jede Änderung an einer Upstream-Datei hat eine entsprechende `changes.md` im betroffenen Unterverzeichnis, die dokumentiert, was geändert wurde, warum und wo Konflikte zu erwarten sind.
3. **Remotes**: `origin` = [code-yeongyu/senpi](https://github.com/code-yeongyu/senpi), `upstream` = [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

Geänderte Upstream-Dateien (wichtigste Änderungen; siehe die jeweilige `changes.md` pro Verzeichnis für den Rest):

| Datei | Änderung |
|------|--------|
| `agent-session.ts` | Ruft `buildDynamicSystemPrompt()` statt `buildSystemPrompt()` auf; vereinheitlichte Compaction-Pipeline; System-Prompt-Wechsel beim Modellwechsel |
| `resource-loader.ts` | Erkennung von SYSTEM.md / APPEND_SYSTEM.md entfernt; Laden integrierter Erweiterungen hinzugefügt; Fast-Path für generierte Standard-Erweiterungen |
| `interactive-mode.ts` | Anzeigeformatierung für integrierte Erweiterungen; Update-Prüfungen deaktiviert; nicht-blockierende Startup-Tools; Durchschalten favorisierter Modelle |
| `model-registry.ts` | Benutzerdefinierte `upstreamModelId` und `serviceTier`; Deaktivierung/Whitelist/Blacklist für Provider/Modelle; `thinkingLevelMapMode` |
| `settings-manager.ts` | `disabledBuiltinExtensions`; `favoriteModels`; `openai.serviceTier`; Steering-Standardwert `"all"` |
| `agent-loop.ts` (`packages/agent`) | `executeToolCallsParallel()` |
| `tui.ts` (`packages/tui`) | Fast-Paths für differenzielles Rendering + Durchsetzung des Flicker-Budgets |
| `package.json` | Paket- und Laufzeit-Identität des Coding-Agents in `senpi` umbenannt |

## Teile deine OSS-Coding-Agent-Sessions

Wenn du pi oder andere Coding-Agenten für Open-Source-Arbeit nutzt, teile bitte deine Sessions.

Öffentliche OSS-Session-Daten helfen dabei, Coding-Agenten anhand echter Aufgaben, Tool-Nutzung, Fehlern und Fixes statt mit Spielzeug-Benchmarks zu verbessern.

Die vollständige Erklärung findest du in [diesem Post auf X](https://x.com/badlogicgames/status/2037811643774652911).

Verwende [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf), um Sessions zu veröffentlichen. Lies die README.md für die Anleitung zur Einrichtung. Alles, was du brauchst, sind ein Hugging-Face-Konto, die Hugging Face CLI und `pi-share-hf`.

Du kannst dir auch [dieses Video](https://x.com/badlogicgames/status/2041151967695634619) ansehen, in dem ich zeige, wie ich meine `pi-mono`-Sessions veröffentliche.

Ich veröffentliche meine eigenen `pi-mono`-Arbeitssessions regelmäßig hier:

- [badlogicgames/pi-mono auf Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## Alle Pakete

| Paket | Beschreibung |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | Einheitliche Multi-Provider-LLM-API mit Text-Streaming, Tool-Calling, OAuth-Hilfsfunktionen und Bildgenerierung |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent-Runtime mit Tool-Calling und State-Management |
| **[senpi](packages/coding-agent)** | Interaktive Coding-Agent-CLI, umbenannt in senpi |
| **[@code-yeongyu/senpi-codemode](packages/senpi-codemode)** | Source-only-Erweiterungspaket für codemode mit Bausteinen für Settings, Kernel, Bridge und Prelude |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal-UI-Bibliothek mit differenziellem Rendering |

Für Slack-/Chat-Automatisierung und Workflows siehe [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Berechtigungen & Containerisierung

senpi enthält keine integrierte Containergrenze zur Einschränkung des Zugriffs auf Dateisystem, Prozesse, Netzwerk oder Zugangsdaten. Standardmäßig läuft es mit den Berechtigungen des Benutzers und des Prozesses, der es gestartet hat.

Wenn du strengere Grenzen brauchst, containerisiere senpi. Siehe [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) für drei Muster:

- **OpenShell**: Führe den gesamten `senpi`-Prozess in einem richtliniengesteuerten Container aus.
- **Gondolin-Erweiterung**: Belasse `senpi` und die Provider-Authentifizierung auf dem Host, während integrierte Tools und `!`-Befehle in eine lokale Linux-Micro-VM geleitet werden.
- **Reines Docker**: Führe den gesamten `senpi`-Prozess zur einfachen Isolierung in einem lokalen Container aus.

## Mitwirken

Siehe [CONTRIBUTING.md](CONTRIBUTING.md) für Richtlinien zum Mitwirken und [AGENTS.md](AGENTS.md) für projektspezifische Regeln (sowohl für Menschen als auch für Agenten).

## Entwicklung

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
bun install --ignore-scripts # Bun alternative
bun run build        # Build all packages
bun run check        # Lint, format, and type check
bun run test             # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Live-API integration suite (env-gated; requires API keys)
bun run publish      # Publish npm workspaces, including @code-yeongyu/senpi
```

## Supply-Chain-Härtung

Wir behandeln Änderungen an npm-Abhängigkeiten wie geprüfte Code-Änderungen.

- Direkte externe Abhängigkeiten sind auf exakte Versionen festgelegt. Interne Workspace-Pakete verwenden weiterhin Versionsbereiche.
- `.npmrc` setzt `save-exact=true` und `min-release-age=2`, um bei der npm-Auflösung Abhängigkeits-Releases vom selben Tag zu vermeiden.
- `package-lock.json` ist die maßgebliche Quelle für Abhängigkeiten. Pre-Commit blockiert versehentliche Lockfile-Commits, sofern nicht `PI_ALLOW_LOCKFILE_CHANGE=1` gesetzt ist.
- `bun run check` überprüft festgelegte direkte Abhängigkeiten, die Kompatibilität nativer TypeScript-Importe und das generierte Install-Lock für den Coding-Agent.
- Das veröffentlichte `@code-yeongyu/senpi`-Manifest ist die maßgebliche Abhängigkeitsliste: Fork-Workspaces werden über ihre veröffentlichten `@code-yeongyu/senpi-*`-Aliase aufgelöst, und außer dem per Vendoring eingebundenen Client-/Protokoll-Code wird nichts davon im Tarball mitgeliefert. Es wird keine `npm-shrinkwrap.json` veröffentlicht.
- Release-Smoke-Tests nutzen `bun run release:local`, um das Paket vor dem Taggen eines Releases zu bauen, zu packen und isolierte npm- und Bun-Installationen außerhalb des Repos zu erstellen.
- Lokale Release-Installationen, dokumentierte npm-Installationen und `senpi update senpi` verwenden `--ignore-scripts`, sofern unterstützt.
- Die CI installiert mit `npm ci --ignore-scripts`, und ein geplanter GitHub-Workflow führt `npm audit --omit=dev` sowie `npm audit signatures --omit=dev` aus. Diese npm-Interna sind für eine spätere Migration erfasst.
- Die Install-Lock-Generierung nutzt eine explizite Allowlist für Lifecycle-Skripte von Abhängigkeiten; neue Abhängigkeiten mit Lifecycle-Skripten lassen die Checks fehlschlagen, bis sie geprüft wurden.

## Mitwirken

Siehe [CONTRIBUTING.md](CONTRIBUTING.md) für Richtlinien zum Mitwirken und [AGENTS.md](AGENTS.md) für projektspezifische Regeln (sowohl für Menschen als auch für Agenten).

## Lizenz

MIT

## Ganbare Ganbare Senpi

> *Hora, senpi senpi, senpi te kudasai!*
> *Ganbare ganbare senpi, gan ganbare ganbare senpi ora!*

Ein winziger, völlig unernster Liebesbrief an das [Ganbare Ganbare Senpai](https://en.wikipedia.org/wiki/Don%27t_Toy_with_Me,_Miss_Nagatoro)-Meme, vor dem sich der Projektname insgeheim verneigt. Jedes Mal, wenn der Rebase sauber ist und die Tests grün sind, flüstert irgendwo eine Kouhai:

- **Komm schon senpi, komm schon!** Shippe den PR.
- **Beachte mich, senpi.** ...die Diagnostics haben es zuerst bemerkt.
- **Streng dich mehr an, senpi!** *(sie hat hingeschaut. und der Build lief durch.)*
- **Du schaffst das, senpi!** Noch ein Agent, noch ein Tool, noch ein sauberer Rebase.
- **Ganbare, ganbare, senpi! 頑張れ頑張れ先輩!** *Gib dein Bestes, gib dein Bestes, Senpai!*

Ja, der gesamte Projektname ist ein Senpai-Wortspiel. Typisiere strikt, führe die Tests aus, schreib eine `changes.md`, halte die Merge-Fläche winzig — und *gan ganbare ganbare senpi ora!*

Shoutout an [plugsuits](https://github.com/minpeter/pss-runtime): Das Compaction-System von senpi ist von dessen Design inspiriert.
