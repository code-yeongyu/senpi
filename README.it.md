[English](README.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-br.md) | [Italiano](README.it.md)

# senpi


<p align="center">
  <a href="https://discord.gg/PUwSMR9XNk"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/code-yeongyu/senpi/actions/workflows/ci.yml"><img alt="Stato della build" src="https://img.shields.io/github/actions/workflow/status/code-yeongyu/senpi/ci.yml?style=flat-square&branch=main" /></a>
</p>

> ⚠️ **Sperimentale.** senpi è un fork con scelte ben precise e in continua evoluzione di [badlogic/pi-mono](https://github.com/badlogic/pi-mono). Alimenta [Dori](https://sisyphuslabs.ai) sotto il cofano e riflette ciò di cui uno specifico assistente IA ha bisogno dal runtime di un agente di programmazione. Usalo; non scommetterci una pipeline di produzione.

senpi è un gioco di parole su senpai e un pi più **sensato** con batterie extra incluse — un monorepo TypeScript che rinomina l'agente di programmazione di pi-mono in `senpi` e fornisce un set curato di estensioni integrate e modifiche al core sopra l'upstream.

> **Upstream**: [pi-mono](https://github.com/badlogic/pi-mono) di [@mariozechner](https://github.com/badlogic) — strumenti per creare agenti IA e gestire i deployment di LLM.

## Ispirato da OMO, costruito come runtime dell'agente di programmazione di Dori

senpi nasce da due influenze:

- **Forte influenza da [OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent).** OMO è l'harness opencode pesante con agenti di disciplina (Sisyphus, Hephaestus, Prometheus), [IntentGate](https://factory.ai/news/terminal-bench), modifiche ancorate a hash, Team Mode, MCP integrati nelle skill, Ralph Loop, todo enforcer e molto altro. senpi riutilizza molte delle idee distintive di OMO (intent gate, prompt dinamico, preset per modello, routing parallelo degli strumenti, continuazione dei todo), ma **mantiene la superficie il più leggera possibile** per restare vicino a pi-mono upstream. Pensa a senpi come a **una versione leggera di OMO** che gira come un singolo binario CLI di pi invece che come plugin di opencode.
- **senpi è il runtime dell'agente di programmazione per [Dori](https://sisyphuslabs.ai).** Dori è l'assistente IA di Sisyphus Labs — vedi il [riferimento a Dori nel README di OMO](https://github.com/code-yeongyu/oh-my-openagent#oh-my-openagent) per il contesto. senpi è utilizzabile in modo indipendente, ma le scelte progettuali (formulazione dell'intent gate, set di estensioni integrate, preset di prompt per famiglia di modelli, branding) sono calibrate su ciò di cui Dori ha bisogno quando esegue lavori sul codice.

Le modifiche al codice sorgente principale sono ridotte al minimo e tracciate nei file [`changes.md`](#fork-strategy) accanto a ogni sottodirectory modificata, così che i commit di merge da upstream restino facili da revisionare.

| Pacchetto | Descrizione |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Runtime indipendente di composizione delle applicazioni per servizi, stato replicato, RPC e plugin |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Contratti di telemetria indipendenti dal fornitore, adapter di riferimento, test di conformità e schemi tipizzati |
| **[@earendil-works/pi-ai](packages/ai)** | API LLM multi-provider unificata (OpenAI, Anthropic, Google, ecc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Runtime dell'agente con chiamata degli strumenti e gestione dello stato |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | CLI interattiva dell'agente di programmazione |
| **[@earendil-works/pi-tui](packages/tui)** | Libreria UI da terminale con rendering differenziale |

## Vieni da OMO? Configurazione delle estensioni consigliata

Se stai migrando da [OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent), ecco la mappa pratica da "cosa usavo in OMO" a "cosa installare in senpi". Gran parte delle funzionalità distintive di OMO è **già integrata in senpi come builtin** (niente da installare); il resto si trova nei repo GitHub [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) ed è a un solo `senpi install` di distanza.

> senpi è intenzionalmente più leggero di OMO — un singolo binario CLI, non un plugin opencode. Alcuni concetti di OMO (Discipline Agents, Team Mode, Skills, Hashline, Ralph Loop, `/init-deep`) **non hanno un equivalente 1:1 in senpi** e sono segnalati in fondo a questa sezione. Se ti servono, continua a usare OMO.

### Già integrato in senpi — niente da installare

| Funzionalità OMO | Builtin di senpi |
|---|---|
| 🚪 **IntentGate** | [Prompt di sistema dinamico](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) — ogni prompt si apre con un intent gate forzato prima dell'uso dei tool. |
| ✅ **Todo Enforcer** | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) + ciclo di continuazione che riattiva gli agenti inattivi. |
| **Ottimizzazione per modello** ("Model Setup") | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) — preset per GPT-5.x / Claude Opus 4.{5,6,7} / Kimi K2.6. |
| **Ripristino della sessione / gestione del contesto** | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) — soglie adattive, tracker di ripristino, compattazione di emergenza, troncamento dei risultati dei tool. |
| **Apply-patch sui modelli GPT** | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) — `apply_patch` a formato libero in stile Codex con grammatica Lark. |
| **Ricerca web nativa** (Anthropic + OpenAI) | Builtin `anthropic-web-search`, `openai-web-search`. |
| **Gestione rigorosa dei timeout Bash** | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) — applicazione di timeout predefinito e massimo, policy nel prompt di sistema. |
| **Accoppiamento dei tool sicuro per la compattazione** | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) — rimuove i blocchi `tool_result` orfani. |
| **Sistema di permessi** (consenti/nega in stile opencode) | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) — regole, archiviazione JSONL, prompt TUI, pattern consapevoli del parser. |

### Scegli le estensioni per la tua configurazione OMO

I builtin di Senpi, le estensioni standalone `pi-*` e il
[plugin OMO Senpi](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-senpi/plugin)
si sovrappongono. Non installare tutti i pacchetti standalone quando la funzionalità è già fornita da Senpi o dal plugin.

| Funzionalità | Senpi senza il plugin OMO | Senpi con il plugin OMO |
|---|---|---|
| LSP | Installa [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client). | Il plugin registra sei tool LSP tramite il suo demone integrato. Installa `pi-lsp-client` solo se ti serve specificamente il suo inspector `/lsp`. |
| AST-grep | Installa [`pi-ast-grep`](https://github.com/code-yeongyu/pi-ast-grep). | Il plugin include una skill AST-grep, helper e script di installazione. `pi-ast-grep` resta opzionale se vuoi i tool nativi `ast_grep_search` e `ast_grep_replace`. |
| Controllo dei commenti | Installa [`pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker). | Il plugin registra il proprio componente comment-checker; non installare anche l'estensione standalone. |
| Regole e `AGENTS.md` annidati | Già forniti dai builtin `rules` e `nested-agents-md`. | Uguale; non serve alcuna estensione standalone. |
| Ricerca e recupero web | Già forniti dai builtin `websearch` e `webfetch`. | Uguale; non serve alcuna estensione standalone. |
| Obiettivi persistenti | Già forniti dal builtin `goal`. | Uguale; non serve alcuna estensione standalone. |
| Profili dei subagenti | [`pi-agent-system`](https://github.com/code-yeongyu/pi-agent-system) supporta launcher esterni che impostano `PI_AGENT_TYPE` o `SANEPI_AGENT_TYPE`. | Il plugin gestisce il routing di task/membri e il filtraggio dei tool, quindi `pi-agent-system` di solito non è necessario. Mantienilo solo quando un altro launcher dipende dal suo contratto basato su variabili d'ambiente. |

Per Senpi standalone senza il plugin OMO, installa solo le funzionalità non integrate che ti servono:

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

Consulta [Pacchetti Senpi](packages/coding-agent/README.md#pi-packages) per il flusso completo di installazione / aggiornamento / rimozione.

### Consenti tutti i permessi (in stile OMO)

OMO viene eseguito con tutti i permessi dei tool pre-approvati. Per replicare questo comportamento in senpi, aggiungi una regola di autorizzazione con carattere jolly alle tue impostazioni globali:

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

Questo indica al sistema di permessi di approvare automaticamente ogni chiamata ai tool senza chiedere conferma. La chiave `"*"` corrisponde a tutti i nomi di permesso e `"allow"` li concede incondizionatamente. Puoi anche impostarlo per singolo progetto inserendo lo stesso `settings.json` in `.senpi/settings.json` nella radice del progetto.

> **Nota:** Questo disabilita tutti i prompt interattivi dei permessi. Fallo solo se ti fidi del modello e del workspace in cui stai lavorando.

### Nessun equivalente diretto in senpi

Questi elementi fanno parte della struttura dell'harness opencode di OMO e intenzionalmente **non** sono presenti in senpi:

- **Discipline Agents** (Sisyphus / Hephaestus / Oracle / Librarian / Explore / Multimodal Looker) e il punto di ingresso di orchestrazione a parola singola **`ultrawork` / `ulw`**.
- **Team Mode** — lead + fino a 8 membri in parallelo, visualizzazione tmux, famiglia di tool `team_*`, skill `hyperplan` / `security-research` costruite sopra.
- **Hashline / tool di modifica ancorato a hash** — senpi mantiene i tool standard di pi `edit` / `multiedit` / `apply_patch`. `pi-comment-checker` copre la fase di validazione post-modifica per cui OMO usa Hashline, solo senza gli identificatori di hash del contenuto `LINE#ID`.
- **Sistema di skill** e **MCP integrati nelle skill** — le skill come concetto di prima classe (`SKILL.md`, server MCP isolati per singola skill) non esistono in senpi.
- **Pianificatore in modalità intervista Prometheus** e il ciclo autoreferenziale **Ralph Loop / `/ulw-loop`**.
- **`/init-deep`** — non c'è un generatore integrato. Genera manualmente l'albero gerarchico `AGENTS.md` (o con un normale prompt dell'agente); l'estensione builtin `nested-agents-md` leggerà i file risultanti.
- **Comando `doctor` integrato**, **livello di compatibilità per hook/comandi/skill/plugin di Claude Code** e il **router di categorie degli agenti** (`visual-engineering` / `deep` / `quick` / `ultrabrain`).

## Vuoi di più? Prova l'ecosistema pi-extensions

senpi include un set fisso di estensioni integrate e si ferma lì. I repository GitHub [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) contengono l'intero ecosistema di estensioni: alcuni pacchetti sono vendored in senpi come builtin, mentre il resto può essere installato in aggiunta quando vuoi funzionalità extra come LSP o AST-grep.

### Estensioni installabili

Questi pacchetti [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) sono pensati per essere installati come estensioni standalone per senpi/pi:

| Estensione | Cosa aggiunge |
|---|---|
| [`pi-anthropic-code-execution`](https://github.com/code-yeongyu/pi-anthropic-code-execution) | Esecuzione di codice nativa di Anthropic. |
| [`pi-anthropic-computer-use`](https://github.com/code-yeongyu/pi-anthropic-computer-use) | Binding per il computer-use di Anthropic. |
| [`pi-anthropic-text-editor`](https://github.com/code-yeongyu/pi-anthropic-text-editor) | Strumento editor di testo nativo di Anthropic. |
| [`pi-anthropic-tool-search`](https://github.com/code-yeongyu/pi-anthropic-tool-search) | Ricerca di strumenti nativa di Anthropic. |
| [`pi-anthropic-web-fetch`](https://github.com/code-yeongyu/pi-anthropic-web-fetch) | Supporto per il recupero web nativo di Anthropic. |
| [`pi-ast-grep`](https://github.com/code-yeongyu/pi-ast-grep) | Ricerca e sostituzione del codice basata su AST in 25 linguaggi. Scarica automaticamente `sg` al primo utilizzo. |
| [`pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) | Esegue controlli sulla qualità dei commenti dopo l'uso degli strumenti di modifica dei file e mostra avvisi nella TUI. |
| [`pi-cua-integration`](https://github.com/code-yeongyu/pi-cua-integration) | Collegamento delle azioni di computer-use per le superfici di interazione desktop e browser. |
| [`pi-google-code-execution`](https://github.com/code-yeongyu/pi-google-code-execution) | Esecuzione di codice nativa di Google. |
| [`pi-google-google-search`](https://github.com/code-yeongyu/pi-google-google-search) | Grounding con Google Search. |
| [`pi-google-url-context`](https://github.com/code-yeongyu/pi-google-url-context) | Grounding con URL di Google. |
| [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client) | Integrazione LSP: `lsp_rename`, `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`, più un inspector `/lsp`. |
| [`pi-openai-api-parallel-tool-calls`](https://github.com/code-yeongyu/pi-openai-api-parallel-tool-calls) | Supporto per il payload `parallel_tool_calls` di OpenAI. |
| [`pi-openai-code-interpreter`](https://github.com/code-yeongyu/pi-openai-code-interpreter) | Code Interpreter di OpenAI. |

Puoi installarne una qualsiasi con:

```bash
senpi install git:github.com/code-yeongyu/pi-ast-grep
senpi install git:github.com/code-yeongyu/pi-lsp-client
# ...substitute any of the package names from the table above.
```

Consulta [Pacchetti Senpi](packages/coding-agent/README.md#pi-packages) per il flusso di installazione / aggiornamento / rimozione.

### Pacchetti pi-extension già inclusi come estensioni integrate in senpi

**Non** hai bisogno di installare questi pacchetti per il normale utilizzo di senpi; le loro funzionalità sono già incluse nel binario. Questa tabella è intenzionalmente limitata ai pacchetti che corrispondono all'elenco `builtinExtensions` attualmente registrato:

| Pacchetto | Incluso come | Funzionalità integrata |
|---|---|---|
| [`pi-anthropic-bash`](https://github.com/code-yeongyu/pi-anthropic-bash) | `anthropic-bash` | Variante dello strumento bash nativa di Anthropic. |
| [`pi-anthropic-web-search`](https://github.com/code-yeongyu/pi-anthropic-web-search) | `anthropic-web-search` | Supporto per la ricerca web nativa di Anthropic. |
| [`pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch) | `gpt-apply-patch` | Strumento `apply_patch` in stile Codex per le esecuzioni della famiglia GPT. |
| [`pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout) | `bash-timeout` | Valori predefiniti del timeout bash, applicazione del timeout massimo e policy di prompt. |
| [`pi-goal`](https://github.com/code-yeongyu/pi-goal) | `goal` | Tracciamento persistente degli obiettivi, stato nella TUI e prompt di continuazione. |
| [`pi-nested-agents-md`](https://github.com/code-yeongyu/pi-nested-agents-md) | `nested-agents-md` | Inietta automaticamente i file `AGENTS.md` vicini per le directory annidate. |
| [`pi-openai-web-search`](https://github.com/code-yeongyu/pi-openai-web-search) | `openai-web-search` | Ricerca web nativa di OpenAI Responses. |
| [`pi-rules`](https://github.com/code-yeongyu/pi-rules) | `rules` | Rileva i file di regole del progetto e dell'utente, inclusi `AGENTS.md` e `CLAUDE.md`. |
| [`pi-todotools`](https://github.com/code-yeongyu/pi-todotools) | `todowrite` | `todowrite` / `todoread`, stato dei todo nella barra laterale, guida di prompt per il workflow e follow-up di continuazione. |
| [`pi-webfetch`](https://github.com/code-yeongyu/pi-webfetch) | `webfetch` | Recupera il contenuto di un URL come markdown, testo o HTML con limiti di tempo e dimensione. |
| [`pi-websearch`](https://github.com/code-yeongyu/pi-websearch) | `websearch` | Ricerca web supportata da provider con attivazione controllata da configurazione e risultati consapevoli delle fonti. |

Altre estensioni integrate come `permission-system`, `prompt-preset`, `service-tier`, `tool-pair-guard`, `compaction`, `history-search` e `session-observer` sono estensioni integrate interne di senpi senza pacchetti equivalenti installabili.

## Perché "senpi"

`senpi` è un piccolo gioco di parole su **senpai**, ma definisce anche letteralmente il posizionamento del progetto: questo fork punta a essere un pi più **sensato**, con aggiunte pratiche che rendono più fluido il lavoro quotidiano dell'agente senza abbandonare il design di base dell'upstream.

Tutte le aggiunte seguono la filosofia extension-first di pi. Le modifiche al codice sorgente di base sono ridotte al minimo e [documentate nei file `changes.md`](#fork-strategy) per mantenere revisionabili i commit di merge dall'upstream.

## Cosa aggiunge questo fork

senpi eredita il design orientato alle estensioni di pi — il core rimane minimale, ogni funzionalità arriva come estensione integrata. La scommessa è che un set ben definito di funzionalità sia richiesto abbastanza spesso da giustificarne la presenza nel binario; tutto ciò che non vuoi è comunque disattivabile con un singolo flag nelle impostazioni (`disabledBuiltinExtensions` in `settings.json`).

Verificato tramite `git diff upstream/main..HEAD` e ogni file `changes.md` nel repository.

### Nuovi sottosistemi core

| Sottosistema | Cosa fa | Docs |
|-----------|--------------|------|
| **Prompt di sistema dinamico** | Sostituisce il prompt statico di upstream con un builder adattivo: identità senpi → intent gate forzato → disciplina di esecuzione del task (ondate parallele, limiti di esplorazione, impegno su un unico piano) → livelli di verifica → riferimento agli strumenti categorizzato → policy → stile → ottimizzazione opzionale per modello. | [`dynamic-prompt/`](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) · [`changes.md`](packages/coding-agent/src/core/dynamic-prompt/changes.md) |
| **Pipeline di compattazione** | Soglie adattive in stile Plugsuit, protezione contro i riepiloghi vuoti, hook di riepilogo dei branch. La compattazione speculativa e di emergenza con tracker di ripristino risiede nell'[estensione integrata `compaction`](#owned-builtin-extensions). | [`core/compaction/`](packages/coding-agent/src/core/compaction/) · [`changes.md`](packages/coding-agent/src/core/compaction/changes.md) |
| **Riscrittura del middleware per le tool-call** | Protocolli di tool-call testuali XML / Hermes / YAML+XML / Gemma4 destinati ai modelli senza function calling nativo. Parsing rigoroso, conservazione degli errori di stream. | [`tool-call-middleware/`](packages/ai/src/tool-call-middleware/AGENTS.md) · [`changes.md`](packages/ai/src/tool-call-middleware/changes.md) |

<a id="owned-builtin-extensions"></a>

### Estensioni integrate interne

Presenti nel repository, strettamente accoppiate ai componenti interni di senpi. Caricate esattamente in questo ordine di registrazione:

| # | Estensione | Ruolo | Docs |
|---|-----------|------|------|
| 1 | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) | Porting completo dei permessi in stile opencode — regole, archiviazione JSONL, prompt TUI, pattern consapevoli del parser (arietà bash, glob di file, percorsi nel corpo di `apply_patch`), fallback non interattivo | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/permission-system/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/permission-system/changes.md) |
| 2 | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) *(vendored)* | Quando il modello attivo è OpenAI GPT, sostituisce `write`/`edit` con `apply_patch` a formato libero in stile Codex con grammatica Lark. Sincronizzata da [`code-yeongyu/pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch). | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/AGENTS.md) |
| 3 | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) | Preset del prompt di sistema per modello (gpt-5.x, claude-opus-4-{5,6,7}, kimi-k2-6) applicati sopra il prompt dinamico. Ottimizzazione condivisa delle operazioni sui file in stile codex. | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/changes.md) |
| 4 | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) *(vendored)* | Strumenti `todowrite` / `todoread` con persistenza consapevole del branch, widget nella barra laterale, guida al workflow nel prompt e loop di continuazione. Sincronizzata da [`code-yeongyu/pi-todotools`](https://github.com/code-yeongyu/pi-todotools). | — |
| 5 | [`redraws`](packages/coding-agent/src/core/extensions/builtin/redraws.ts) | Comando `/tui` che riporta il conteggio cumulativo dei ridisegni completi della TUI. Usato per il debug del rendering differenziale. | — |
| 6 | [`anthropic-web-search`](packages/coding-agent/src/core/extensions/builtin/anthropic-web-search/) | Strumento `web_search` nativo di Anthropic | — |
| 7 | [`anthropic-bash`](packages/coding-agent/src/core/extensions/builtin/anthropic-bash/) | Variante dello strumento bash nativo di Anthropic | — |
| 8 | [`openai-web-search`](packages/coding-agent/src/core/extensions/builtin/openai-web-search/) | `web_search` nativo di OpenAI Responses | — |
| 9 | [`service-tier`](packages/coding-agent/src/core/extensions/builtin/service-tier.ts) | Inietta `service_tier` (`auto` / `flex` / `priority`) nei payload di OpenAI Responses usando il livello di servizio per modello o l'impostazione `openai.serviceTier` | — |
| 10 | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) *(vendored)* | Inietta i timeout bash predefinito e massimo, aggiunge la policy al prompt di sistema. Sincronizzata da [`code-yeongyu/pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout). | — |
| 11 | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) | Sanifica i payload delle richieste Anthropic rimuovendo i blocchi `tool_result` orfani — sicurezza durante la compattazione | — |
| 12 | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) | Policy di compattazione speculativa e di emergenza: monitor di degradazione, circuit breaker, limite per turno, bridging dei todo, stato di checkpoint, tracker di ripristino, troncamento dei risultati degli strumenti | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/compaction/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/compaction/changes.md) |
| 13 | [`history-search`](packages/coding-agent/src/core/extensions/builtin/history-search/) | Comando `/history` — cerca nella cronologia dei prompt tra le sessioni in un overlay | — |
| 14 | [`websearch`](packages/coding-agent/src/core/extensions/builtin/websearch/) | Strumento `web_search` basato su provider con attivazione controllata da configurazione, stato nella TUI e risultati consapevoli della fonte | — |
| 15 | [`webfetch`](packages/coding-agent/src/core/extensions/builtin/webfetch/) | Strumento `webfetch` per scaricare il contenuto di URL come markdown, testo o HTML con limiti di tempo e dimensione | — |
| 16 | [`nested-agents-md`](packages/coding-agent/src/core/extensions/builtin/nested-agents-md/) | Inietta automaticamente i file `AGENTS.md` vicini quando l'agente legge da directory annidate | — |
| 17 | [`rules`](packages/coding-agent/src/core/extensions/builtin/rules/) | Rileva automaticamente i file di regole del progetto ed espone i comandi `/rules` / `/reload-rules` | — |
| 18 | [`goal`](packages/coding-agent/src/core/extensions/builtin/goal/) | Strumenti di tracciamento persistente degli obiettivi, stato nel footer e prompt di continuazione | — |

> Le directory delle estensioni integrate qui sopra sono nuove rispetto a `pi-mono` upstream — nessuna di esse esiste in `badlogic/pi-mono`. Le versioni vendored sono fissate in [`external-versions.json`](packages/coding-agent/src/core/extensions/builtin/external-versions.json) e sincronizzate dal checkout parallelo `pi-extensions` tramite [`sync-builtin-extensions.mjs`](packages/coding-agent/scripts/sync-builtin-extensions.mjs).

### Repository di estensioni standalone

Queste estensioni sono mantenute come repository pubblici `code-yeongyu/pi-*` e possono essere installate tramite `packages` in `settings.json` o con `senpi install git:github.com/code-yeongyu/<repo>`.

| Estensione | Repository | Cosa fa |
|-----------|------------|--------------|
| `pi-comment-checker` | [`code-yeongyu/pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) | Esegue `@code-yeongyu/comment-checker` dopo `write`, `edit`, `multiedit` e `apply_patch`, inclusi i metadati `apply_patch` compatibili con OMO e il fallback per le patch grezze di Codex; mostra gli avvisi in un widget sopra l'editor |

### Estensioni predefinite globali

Non vengono caricate come estensioni integrate; vengono scritte una sola volta in `~/.senpi/agent/extensions/` al primo avvio, così puoi modificarle o rimuoverle localmente.

| Estensione | Sorgente | Cosa fa |
|-----------|--------|--------------|
| `diff` | [`diff.ts`](packages/coding-agent/src/core/extensions/builtin/diff.ts) | Comando `/diff` — seleziona i file modificati / eliminati / nuovi da `git status` e apre la vista diff di VS Code |
| `files` | [`files.ts`](packages/coding-agent/src/core/extensions/builtin/files.ts) | Comando `/files` — elenca i file letti / scritti / modificati nel branch della sessione corrente e apre quello selezionato in VS Code |
| `prompt-url-widget` | [`prompt-url-widget.ts`](packages/coding-agent/src/core/extensions/builtin/prompt-url-widget.ts) | Rileva gli URL di PR / issue di GitHub nei prompt, recupera il titolo tramite `gh` e imposta automaticamente il nome della sessione |
| `tps` | [`tps.ts`](packages/coding-agent/src/core/extensions/builtin/tps.ts) | Notifica dei token al secondo (input / output / cache r/w / totale / tempo trascorso) dopo ogni turno dell'agente |

### Pacchetti upstream modificati

| Pacchetto | Cosa è cambiato | Riferimento |
|---------|--------------|-----------|
| [`packages/ai`](packages/ai/AGENTS.md) | `originator` e User-Agent di Codex con brand senpi, utility condivisa per la riparazione delle coppie di strumenti, supporto per strumenti personalizzati/a formato libero di OpenAI Responses per `apply_patch`, Claude Opus 4.7 + livello di riflessione `"max"`, pass-through di `extraBody` su tutti i provider, [riscrittura del middleware per le tool-call](packages/ai/src/tool-call-middleware/AGENTS.md) | [`ai/src/changes.md`](packages/ai/src/changes.md) |
| [`packages/agent`](packages/agent/AGENTS.md) | Emissione parallela del completamento degli strumenti (finalizzazione concorrente, risultati nell'ordine di origine), UUIDv7 inline in sostituzione della dipendenza `uuid`, diagnostica dell'harness compatibile con ES2021 | [`agent/src/changes.md`](packages/agent/src/changes.md) |
| [`packages/tui`](packages/tui/AGENTS.md) | Perfezionamento del rendering differenziale: fast path per insert-scroll, correzione del repaint nella rimappatura del viewport, test di regressione per il flicker-budget (nessuna cancellazione completa post-inizializzazione, DECSET 2026 bilanciato) | [`tui/src/changes.md`](packages/tui/src/changes.md) |
| [`packages/coding-agent`](packages/coding-agent/AGENTS.md) | Branding `senpi`, controlli di configurazione dei modelli (`upstreamModelId`, `serviceTier`, modelli preferiti, disattivazione/whitelist/blacklist), rilevamento non bloccante degli strumenti all'avvio, controlli di aggiornamento all'avvio disattivati, [sostituzione di `promptSnippet` bash con `rg`](packages/coding-agent/src/core/tools/AGENTS.md), fast-path per le estensioni predefinite generate, identità in uscita con brand senpi | Vari file [`changes.md`](packages/coding-agent/src/) |

### Altre modifiche di branding / runtime

| Modifica | Dettagli |
|--------|---------|
| **Identità della CLI `senpi`** | L'agente di programmazione si identifica come `senpi`, usa `.senpi/agent` per archiviare la configurazione e viene pubblicato su npm come `@code-yeongyu/senpi`. L'eseguibile installato rimane `senpi`. |
| **Identità in uscita con brand senpi** | Ogni richiesta in uscita emette `senpi` invece di `pi`: `User-Agent` (controllo aggiornamenti + Cloudflare + release di GitHub), `X-OpenRouter-Title`, `originator` + User-Agent di OpenAI Codex. |
| **Nessun controllo degli aggiornamenti all'avvio** | Rimossi il controllo della versione sul registro npm e i prompt di aggiornamento dei pacchetti all'avvio. |
| **Raggruppamento UI delle estensioni integrate** | Le estensioni integrate vengono mostrate sotto il gruppo `builtin/` nell'header di avvio, visivamente distinte dalle estensioni dell'utente e del progetto. |
| **Registro dei modelli aggiornato** | `models.generated.ts` aggiornato con le ultime aggiunte e deprecazioni di modelli. |
| **Target di auto-aggiornamento** | `senpi update senpi` interroga le release di [`code-yeongyu/senpi`](https://github.com/code-yeongyu/senpi), non quelle di upstream. |

<a id="fork-strategy"></a>

## Strategia di fork

Questo fork esegue periodicamente il rebase su `upstream/main`. Per ridurre al minimo i conflitti di merge:

1. **Extension-first**: Tutte le funzionalità usano il [sistema di estensioni](packages/coding-agent/docs/extensions.md) di pi come estensioni integrate.
2. **Documentare le modifiche core**: Ogni modifica ai file upstream ha un file `changes.md` corrispondente nella sottodirectory interessata, che documenta cosa è cambiato, perché e le zone di conflitto previste.
3. **Remote**: `origin` = [code-yeongyu/senpi](https://github.com/code-yeongyu/senpi), `upstream` = [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

File upstream modificati (ad alto impatto, consulta i file `changes.md` di ciascuna directory per il resto):

| File | Modifica |
|------|--------|
| `agent-session.ts` | Chiama `buildDynamicSystemPrompt()` invece di `buildSystemPrompt()`; pipeline di compattazione unificata; cambio del system prompt al cambio di modello |
| `resource-loader.ts` | Rimossa la ricerca di SYSTEM.md / APPEND_SYSTEM.md; aggiunto il caricamento delle estensioni integrate; fast-path per le estensioni predefinite generate |
| `interactive-mode.ts` | Formattazione di visualizzazione delle estensioni integrate; controlli degli aggiornamenti disabilitati; strumenti di avvio non bloccanti; rotazione dei modelli preferiti |
| `model-registry.ts` | `upstreamModelId` e `serviceTier` personalizzati; disabilitazione/whitelist/blacklist di provider e modelli; `thinkingLevelMapMode` |
| `settings-manager.ts` | `disabledBuiltinExtensions`; `favoriteModels`; `openai.serviceTier`; valore predefinito di steering `"all"` |
| `agent-loop.ts` (`packages/agent`) | `executeToolCallsParallel()` |
| `tui.ts` (`packages/tui`) | Fast path di rendering differenziale + applicazione del flicker-budget |
| `package.json` | Rinominato il pacchetto dell'agente di programmazione e l'identità runtime in `senpi` |

## Condividi le tue sessioni OSS con gli agenti di programmazione

Se usi pi o altri agenti di programmazione per il lavoro open source, condividi le tue sessioni.

I dati pubblici delle sessioni OSS aiutano a migliorare gli agenti di programmazione con attività reali, uso degli strumenti, errori e correzioni, invece di benchmark giocattolo.

Per la spiegazione completa, vedi [questo post su X](https://x.com/badlogicgames/status/2037811643774652911).

Per pubblicare le sessioni, usa [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Leggi il suo README.md per le istruzioni di configurazione. Tutto ciò che ti serve è un account Hugging Face, la CLI di Hugging Face e `pi-share-hf`.

Puoi anche guardare [questo video](https://x.com/badlogicgames/status/2041151967695634619), in cui mostro come pubblico le mie sessioni di `pi-mono`.

Pubblico regolarmente le mie sessioni di lavoro su `pi-mono` qui:

- [badlogicgames/pi-mono su Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## Tutti i pacchetti

| Pacchetto | Descrizione |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | API LLM multi-provider unificata con streaming di testo, tool calling, helper OAuth e generazione di immagini |
| **[@earendil-works/pi-agent-core](packages/agent)** | Runtime dell'agente con tool calling e gestione dello stato |
| **[senpi](packages/coding-agent)** | CLI interattiva per agente di programmazione, rinominata senpi |
| **[@code-yeongyu/senpi-codemode](packages/senpi-codemode)** | Pacchetto di estensione codemode solo sorgente con componenti di base per impostazioni, kernel, bridge e prelude |
| **[@earendil-works/pi-tui](packages/tui)** | Libreria UI per terminale con rendering differenziale |

Per l'automazione e i workflow di Slack/chat vedi [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permessi e containerizzazione

senpi non include un isolamento tramite container integrato per limitare l'accesso a filesystem, processi, rete o credenziali. Per impostazione predefinita, viene eseguito con i permessi dell'utente e del processo che lo ha avviato.

Se hai bisogno di limiti più rigorosi, containerizza senpi. Consulta [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) per tre pattern:

- **OpenShell**: esegui l'intero processo `senpi` in un container controllato da policy.
- **Estensione Gondolin**: mantieni `senpi` e l'autenticazione del provider sull'host, instradando gli strumenti integrati e i comandi `!` in una micro-VM Linux locale.
- **Docker standard**: esegui l'intero processo `senpi` in un container locale per un isolamento semplice.

## Contribuire

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) per le linee guida sui contributi e [AGENTS.md](AGENTS.md) per le regole specifiche del progetto (sia per gli esseri umani che per gli agenti).

## Sviluppo

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
bun install --ignore-scripts # Bun alternative
bun run build        # Build all packages
bun run check        # Lint, format, and type check
bun run test             # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Live-API integration suite (env-gated; requires API keys)
bun run publish      # Publish npm workspaces, including @code-yeongyu/senpi
```

## Hardening della supply chain

Trattiamo le modifiche alle dipendenze npm come modifiche al codice soggette a revisione.

- Le dipendenze esterne dirette sono bloccate su versioni esatte. I pacchetti interni del workspace mantengono intervalli di versione.
- `.npmrc` imposta `save-exact=true` e `min-release-age=2` per evitare rilasci di dipendenze dello stesso giorno durante la risoluzione npm.
- `package-lock.json` è l'unica fonte di verità per le dipendenze. Il pre-commit blocca i commit accidentali del lockfile a meno che non sia impostato `PI_ALLOW_LOCKFILE_CHANGE=1`.
- `bun run check` verifica le dipendenze dirette bloccate, la compatibilità degli import TypeScript nativi e il lock di installazione generato per l'agente di programmazione.
- Il manifesto pubblicato di `@code-yeongyu/senpi` è l'elenco delle dipendenze di origine: i workspace del fork vengono risolti tramite i rispettivi alias `@code-yeongyu/senpi-*` pubblicati e all'interno del tarball viene distribuito solo il codice client/protocollo vendored. Non viene pubblicato alcun `npm-shrinkwrap.json`.
- Gli smoke test di rilascio usano `bun run release:local` per compilare, impacchettare e creare installazioni npm e Bun isolate all'esterno del repo prima di taggare una release.
- Le installazioni di release locali, le installazioni npm documentate e `senpi update senpi` usano `--ignore-scripts` dove supportato.
- La CI installa con `npm ci --ignore-scripts` e un workflow GitHub pianificato esegue `npm audit --omit=dev` insieme a `npm audit signatures --omit=dev`. Questi meccanismi interni di npm sono inventariati per una successiva migrazione.
- La generazione del lock di installazione ha una allowlist esplicita per gli script del ciclo di vita delle dipendenze; le nuove dipendenze con script del ciclo di vita fanno fallire i controlli finché non vengono revisionate.

## Contribuire

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) per le linee guida sui contributi e [AGENTS.md](AGENTS.md) per le regole specifiche del progetto (sia per gli umani che per gli agenti).

## Licenza

MIT

## Ganbare Ganbare Senpi

> *Hora, senpi senpi, senpi te kudasai!*
> *Ganbare ganbare senpi, gan ganbare ganbare senpi ora!*

Una piccola e per nulla seria lettera d'amore al meme [Ganbare Ganbare Senpai](https://en.wikipedia.org/wiki/Don%27t_Toy_with_Me,_Miss_Nagatoro) a cui il nome del progetto rende segretamente omaggio. Ogni volta che il rebase è pulito e i test sono verdi, da qualche parte una kouhai sussurra:

- **Dai senpi, dai!** Spedisci la PR.
- **Notami, senpi.** ...la diagnostica ti ha notato per prima.
- **Impegnati di più, senpi!** *(ha guardato davvero. e la build è passata davvero.)*
- **Ce la puoi fare, senpi!** Ancora un agente, ancora uno strumento, ancora un rebase pulito.
- **Ganbare, ganbare, senpi! 頑張れ頑張れ先輩!** *Fai del tuo meglio, fai del tuo meglio, senpai!*

Sì, l'intero nome del progetto è un gioco di parole su senpai. Usa tipi rigorosi, esegui i test, scrivi un `changes.md`, mantieni minima la superficie di merge — e *gan ganbare ganbare senpi ora!*

Un ringraziamento speciale a [plugsuits](https://github.com/minpeter/pss-runtime): il sistema di compattazione di senpi prende ispirazione dal suo design.
