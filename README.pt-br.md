[English](README.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-br.md) | [Italiano](README.it.md)

# senpi


<p align="center">
  <a href="https://discord.gg/PUwSMR9XNk"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/code-yeongyu/senpi/actions/workflows/ci.yml"><img alt="Status do build" src="https://img.shields.io/github/actions/workflow/status/code-yeongyu/senpi/ci.yml?style=flat-square&branch=main" /></a>
</p>

> ⚠️ **Experimental.** O senpi é um fork opinativo e em andamento do [badlogic/pi-mono](https://github.com/badlogic/pi-mono). Ele alimenta o [Dori](https://sisyphuslabs.ai) por baixo do capô e reflete o que um assistente de IA específico precisa de um runtime de agente de programação. Use; só não aposte um pipeline de produção nele.

O senpi é um trocadilho com o nome senpai e um pi mais **sensato** com baterias extras inclusas — um monorepo TypeScript que renomeia o agente de programação do pi-mono como `senpi` e entrega um conjunto selecionado de extensões integradas e ajustes no core em cima do upstream.

> **Upstream**: [pi-mono](https://github.com/badlogic/pi-mono) por [@mariozechner](https://github.com/badlogic) — ferramentas para criar agentes de IA e gerenciar implantações de LLM.

## Inspirado no OMO, construído como o runtime de agente de programação do Dori

O senpi nasceu de duas influências:

- **Forte influência do [OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent).** O OMO é o harness pesado para opencode com agentes de disciplina (Sisyphus, Hephaestus, Prometheus), [IntentGate](https://factory.ai/news/terminal-bench), edições ancoradas por hash, Team Mode, MCPs embutidos em skills, Ralph Loop, aplicadores de todo e muito mais. O senpi reutiliza muitas das ideias marcantes do OMO (intent gate, prompt dinâmico, predefinições por modelo, roteamento paralelo de ferramentas, continuação de todo), mas **mantém a superfície o mais leve possível** para permanecer próximo ao pi-mono upstream. Pense no senpi como **uma versão leve do OMO** que roda como um único binário de CLI do pi em vez de um plugin do opencode.
- **O senpi é o runtime de agente de programação do [Dori](https://sisyphuslabs.ai).** O Dori é o assistente de IA da Sisyphus Labs — veja a [menção ao Dori no README do OMO](https://github.com/code-yeongyu/oh-my-openagent#oh-my-openagent) para mais contexto. O senpi pode ser usado de forma independente, mas as decisões de design (formulação do intent gate, conjunto de extensões integradas, predefinições de prompt por família de modelo, identidade visual) são ajustadas para o que o Dori precisa ao executar tarefas de código.

As modificações no código-fonte principal são minimizadas e rastreadas em arquivos [`changes.md`](#fork-strategy) junto a cada subdiretório modificado, para que os commits de merge do upstream continuem fáceis de revisar.

| Pacote | Descrição |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Runtime independente de composição de aplicações para serviços, estado replicado, RPC e plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Contratos de telemetria neutros em relação a fornecedores, adaptador de referência, testes de conformidade e esquemas tipados |
| **[@earendil-works/pi-ai](packages/ai)** | API unificada de LLM multiprovedor (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Runtime de agente com chamada de ferramentas e gerenciamento de estado |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | CLI interativa de agente de programação |
| **[@earendil-works/pi-tui](packages/tui)** | Biblioteca de UI de terminal com renderização diferencial |

## Vindo do OMO? Configuração de extensões recomendada

Se você está migrando do [OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent), aqui está o mapa prático de "o que eu usava no OMO" para "o que instalar no senpi". Grande parte dos recursos marcantes do OMO **já vem integrada ao senpi de forma nativa** (nada para instalar); o restante está nos repositórios [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) no GitHub, a apenas um `senpi install` de distância.

> O senpi é intencionalmente mais leve que o OMO — um único binário de CLI, não um plugin do opencode. Alguns conceitos do OMO (Discipline Agents, Team Mode, Skills, Hashline, Ralph Loop, `/init-deep`) **não têm um equivalente 1:1 no senpi** e estão sinalizados no final desta seção. Se você precisa deles, continue usando o OMO.

### Já nativo no senpi — nada para instalar

| Recurso do OMO | Nativo no senpi |
|---|---|
| 🚪 **IntentGate** | [System prompt dinâmico](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) — todo prompt começa com um gate de intenção obrigatório antes do uso de ferramentas. |
| ✅ **Todo Enforcer** | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) + loop de continuação que reativa agentes ociosos. |
| **Ajuste por modelo** ("Model Setup") | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) — presets para GPT-5.x / Claude Opus 4.{5,6,7} / Kimi K2.6. |
| **Recuperação de sessão / gerenciamento de contexto** | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) — limites adaptativos, rastreador de restauração, compactação de emergência, truncamento de resultados de ferramentas. |
| **Apply-patch em modelos GPT** | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) — `apply_patch` em formato livre estilo Codex com gramática Lark. |
| **Busca na web nativa** (Anthropic + OpenAI) | Recursos nativos `anthropic-web-search`, `openai-web-search`. |
| **Disciplina de timeout no Bash** | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) — aplicação de timeout padrão + máximo, política no system prompt. |
| **Pareamento de ferramentas seguro para compactação** | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) — remove blocos `tool_result` órfãos. |
| **Sistema de permissões** (allow/deny estilo opencode) | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) — regras, armazenamento JSONL, prompts na TUI, padrões sensíveis ao parser. |

### Escolha as extensões para a sua configuração do OMO

Os recursos nativos do Senpi, as extensões `pi-*` avulsas e o
[plugin OMO Senpi](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-senpi/plugin)
se sobrepõem. Não instale todos os pacotes avulsos quando a funcionalidade já for fornecida pelo Senpi ou pelo plugin.

| Funcionalidade | Senpi sem o plugin OMO | Senpi com o plugin OMO |
|---|---|---|
| LSP | Instale [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client). | O plugin registra seis ferramentas LSP por meio do daemon empacotado. Instale `pi-lsp-client` apenas se você precisar especificamente do inspetor `/lsp`. |
| AST-grep | Instale [`pi-ast-grep`](https://github.com/code-yeongyu/pi-ast-grep). | O plugin traz uma skill de AST-grep, um helper e scripts de instalação. O `pi-ast-grep` continua sendo opcional se você quiser as ferramentas nativas `ast_grep_search` e `ast_grep_replace`. |
| Verificação de comentários | Instale [`pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker). | O plugin registra seu próprio componente verificador de comentários; não instale a extensão avulsa junto. |
| Regras e `AGENTS.md` aninhados | Já fornecido pelos recursos nativos `rules` e `nested-agents-md`. | O mesmo; nenhuma extensão avulsa é necessária. |
| Busca e coleta na web | Já fornecido pelos recursos nativos `websearch` e `webfetch`. | O mesmo; nenhuma extensão avulsa é necessária. |
| Objetivos persistentes | Já fornecido pelo recurso nativo `goal`. | O mesmo; nenhuma extensão avulsa é necessária. |
| Perfis de subagentes | [`pi-agent-system`](https://github.com/code-yeongyu/pi-agent-system) oferece suporte a inicializadores externos que definem `PI_AGENT_TYPE` ou `SANEPI_AGENT_TYPE`. | O plugin gerencia o roteamento de tarefas/membros e a filtragem de ferramentas, portanto o `pi-agent-system` normalmente é desnecessário. Mantenha-o apenas quando outro inicializador depender do seu contrato de variáveis de ambiente. |

Para o Senpi avulso sem o plugin OMO, instale apenas as funcionalidades não nativas de que você precisa:

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

Veja [Pacotes do Senpi](packages/coding-agent/README.md#pi-packages) para o fluxo completo de instalar / atualizar / remover.

### Liberar todas as permissões (estilo OMO)

O OMO roda com todas as permissões de ferramentas pré-aprovadas. Para replicar esse comportamento no senpi, adicione uma regra de permissão curinga às suas configurações globais:

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

Isso instrui o sistema de permissões a aprovar automaticamente todas as chamadas de ferramenta sem pedir confirmação. A chave `"*"` corresponde a todos os nomes de permissão, e `"allow"` as concede incondicionalmente. Você também pode definir isso por projeto colocando o mesmo `settings.json` em `.senpi/settings.json` na raiz do projeto.

> **Nota:** Isso desativa todos os prompts interativos de permissão. Faça isso apenas se você confiar no modelo e no workspace em que está executando.

### Sem equivalente direto no senpi

Estes recursos fazem parte do formato de harness opencode do OMO e intencionalmente **não** estão no senpi:

- **Discipline Agents** (Sisyphus / Hephaestus / Oracle / Librarian / Explore / Multimodal Looker) e o ponto de entrada de orquestração de uma palavra **`ultrawork` / `ulw`**.
- **Team Mode** — líder + até 8 membros em paralelo, visualização no tmux, família de ferramentas `team_*` e as skills `hyperplan` / `security-research` rodando por cima.
- **Hashline / ferramenta de edição ancorada em hash** — o senpi mantém o padrão `edit` / `multiedit` / `apply_patch` do pi. O `pi-comment-checker` cobre a etapa de validação pós-edição para a qual o OMO usa o Hashline, apenas sem os identificadores de hash de conteúdo `LINE#ID`.
- **Sistema de skills** e **MCPs embutidos em skills** — skills como um conceito de primeira classe (`SKILL.md`, servidores MCP com escopo por skill) não existem no senpi.
- **Planejador em modo de entrevista Prometheus** e o loop autorreferencial **Ralph Loop / `/ulw-loop`**.
- **`/init-deep`** — não há gerador de árvore integrado. Gere a árvore hierárquica de `AGENTS.md` manualmente (ou com um prompt normal de agente); a extensão nativa `nested-agents-md` lerá os arquivos resultantes.
- **Comando `doctor` integrado**, **camada de compatibilidade de hooks/comandos/skills/plugins do Claude Code** e o **roteador de categorias de agentes** (`visual-engineering` / `deep` / `quick` / `ultrabrain`).

## Quer mais? Experimente o ecossistema pi-extensions

O senpi vem com um conjunto fixo de extensões integradas e para por aí. Os repositórios [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) no GitHub contêm o ecossistema completo de extensões: alguns pacotes são incorporados diretamente ao senpi como recursos integrados, enquanto o restante pode ser instalado à parte quando você quiser recursos extras, como LSP ou AST-grep.

### Extensões instaláveis

Estes pacotes [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) foram feitos para serem instalados como extensões independentes do senpi/pi:

| Extensão | O que ela adiciona |
|---|---|
| [`pi-anthropic-code-execution`](https://github.com/code-yeongyu/pi-anthropic-code-execution) | Execução de código nativa da Anthropic. |
| [`pi-anthropic-computer-use`](https://github.com/code-yeongyu/pi-anthropic-computer-use) | Bindings de computer-use da Anthropic. |
| [`pi-anthropic-text-editor`](https://github.com/code-yeongyu/pi-anthropic-text-editor) | Ferramenta de editor de texto nativa da Anthropic. |
| [`pi-anthropic-tool-search`](https://github.com/code-yeongyu/pi-anthropic-tool-search) | Busca de ferramentas nativa da Anthropic. |
| [`pi-anthropic-web-fetch`](https://github.com/code-yeongyu/pi-anthropic-web-fetch) | Suporte nativo a web fetch da Anthropic. |
| [`pi-ast-grep`](https://github.com/code-yeongyu/pi-ast-grep) | Busca e substituição de código baseada em AST para 25 linguagens. Baixa o `sg` automaticamente no primeiro uso. |
| [`pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) | Executa verificações de qualidade de comentários após ferramentas de edição de arquivos e exibe avisos na TUI. |
| [`pi-cua-integration`](https://github.com/code-yeongyu/pi-cua-integration) | Integração de ações de computer-use para superfícies de interação de desktop/navegador. |
| [`pi-google-code-execution`](https://github.com/code-yeongyu/pi-google-code-execution) | Execução de código nativa do Google. |
| [`pi-google-google-search`](https://github.com/code-yeongyu/pi-google-google-search) | Grounding com o Google Search. |
| [`pi-google-url-context`](https://github.com/code-yeongyu/pi-google-url-context) | Grounding de URL do Google. |
| [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client) | Integração com LSP: `lsp_rename`, `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`, além de um inspetor `/lsp`. |
| [`pi-openai-api-parallel-tool-calls`](https://github.com/code-yeongyu/pi-openai-api-parallel-tool-calls) | Suporte ao payload `parallel_tool_calls` da OpenAI. |
| [`pi-openai-code-interpreter`](https://github.com/code-yeongyu/pi-openai-code-interpreter) | Code Interpreter da OpenAI. |

Instale qualquer uma delas com:

```bash
senpi install git:github.com/code-yeongyu/pi-ast-grep
senpi install git:github.com/code-yeongyu/pi-lsp-client
# ...substitute any of the package names from the table above.
```

Veja [Pacotes do Senpi](packages/coding-agent/README.md#pi-packages) para o fluxo de instalar / atualizar / remover.

### Pacotes pi-extension já incluídos nativamente no senpi

Você **não** precisa instalar estes pacotes para o uso normal do senpi; a funcionalidade deles já está incluída no binário. Esta tabela é intencionalmente limitada aos pacotes que correspondem à lista `builtinExtensions` registrada atualmente:

| Pacote | Incluído como | Recurso integrado |
|---|---|---|
| [`pi-anthropic-bash`](https://github.com/code-yeongyu/pi-anthropic-bash) | `anthropic-bash` | Variante da ferramenta bash nativa da Anthropic. |
| [`pi-anthropic-web-search`](https://github.com/code-yeongyu/pi-anthropic-web-search) | `anthropic-web-search` | Suporte nativo a busca na web da Anthropic. |
| [`pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch) | `gpt-apply-patch` | Ferramenta `apply_patch` no estilo Codex para execuções da família GPT. |
| [`pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout) | `bash-timeout` | Padrões de timeout do bash, aplicação de timeout máximo e política de prompt. |
| [`pi-goal`](https://github.com/code-yeongyu/pi-goal) | `goal` | Acompanhamento persistente de objetivos, status na TUI e prompts de continuação. |
| [`pi-nested-agents-md`](https://github.com/code-yeongyu/pi-nested-agents-md) | `nested-agents-md` | Injeta automaticamente arquivos `AGENTS.md` próximos para diretórios aninhados. |
| [`pi-openai-web-search`](https://github.com/code-yeongyu/pi-openai-web-search) | `openai-web-search` | Busca na web nativa do OpenAI Responses. |
| [`pi-rules`](https://github.com/code-yeongyu/pi-rules) | `rules` | Descobre arquivos de regras do projeto e do usuário, incluindo `AGENTS.md` e `CLAUDE.md`. |
| [`pi-todotools`](https://github.com/code-yeongyu/pi-todotools) | `todowrite` | `todowrite` / `todoread`, estado da barra lateral de tarefas, orientação de prompt de fluxo de trabalho e acompanhamentos de continuação. |
| [`pi-webfetch`](https://github.com/code-yeongyu/pi-webfetch) | `webfetch` | Busca o conteúdo de URLs como markdown, texto ou HTML com limites de tempo e tamanho. |
| [`pi-websearch`](https://github.com/code-yeongyu/pi-websearch) | `websearch` | Busca na web via provedor com ativação controlada por configuração e resultados cientes da fonte. |

Outros recursos integrados, como `permission-system`, `prompt-preset`, `service-tier`, `tool-pair-guard`, `compaction`, `history-search` e `session-observer`, são extensões integradas próprias do senpi sem pacotes equivalentes instaláveis.

## Por que "senpi"

`senpi` é uma pequena brincadeira com **senpai**, mas também reflete literalmente o posicionamento do projeto: este fork busca ser um pi mais **sensato**, com adições práticas que tornam o trabalho diário com agentes mais fluido sem abandonar o design central do upstream.

Todas as adições seguem a filosofia do pi de priorizar extensões. As modificações no código-fonte principal são minimizadas e [documentadas em arquivos `changes.md`](#fork-strategy) para manter os commits de merge do upstream fáceis de revisar.

## O que este fork adiciona

O senpi herda o design focado em extensões do pi — o núcleo permanece mínimo e cada recurso entra como uma extensão integrada (builtin). A aposta é que um conjunto opinativo de recursos é desejado com frequência suficiente para estar no binário; qualquer coisa que você não queira ainda está a uma flag de configuração de ser desativada (`disabledBuiltinExtensions` em `settings.json`).

Verificado com `git diff upstream/main..HEAD` e todos os arquivos `changes.md` no repositório.

### Novos subsistemas principais

| Subsistema | O que faz | Docs |
|-----------|--------------|------|
| **System prompt dinâmico** | Substitui o prompt estático do upstream por um construtor adaptativo: identidade senpi → gate de intenção forçado → disciplina de execução da tarefa (ondas paralelas, paradas de exploração, compromisso com um único plano) → níveis de verificação → referência de ferramentas categorizada → políticas → estilo → ajuste opcional por modelo. | [`dynamic-prompt/`](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) · [`changes.md`](packages/coding-agent/src/core/dynamic-prompt/changes.md) |
| **Pipeline de compactação** | Limites adaptativos estilo Plugsuit, proteção contra sumarização vazia, hooks de sumarização de branch. A compactação especulativa + de emergência com rastreador de restauração vive como a [extensão integrada `compaction`](#owned-builtin-extensions). | [`core/compaction/`](packages/coding-agent/src/core/compaction/) · [`changes.md`](packages/coding-agent/src/core/compaction/changes.md) |
| **Reescrita do middleware de chamada de ferramentas** | Protocolos de ferramentas em texto XML / Hermes / YAML+XML / Gemma4 para modelos sem function calling nativo. Parsing estrito, preservação de erros de stream. | [`tool-call-middleware/`](packages/ai/src/tool-call-middleware/AGENTS.md) · [`changes.md`](packages/ai/src/tool-call-middleware/changes.md) |

<a id="owned-builtin-extensions"></a>

### Extensões integradas próprias

Na árvore do repositório, fortemente acopladas aos componentes internos do senpi. Carregadas exatamente nesta ordem de registro:

| # | Extensão | Função | Docs |
|---|-----------|------|------|
| 1 | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) | Port completo de permissões estilo opencode — regras, armazenamento JSONL, prompts de TUI, padrões sensíveis ao parser (aridade do bash, globs de arquivo, caminhos no corpo do `apply_patch`), fallback não interativo | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/permission-system/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/permission-system/changes.md) |
| 2 | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) *(vendored)* | Quando o modelo ativo é OpenAI GPT, troca `write`/`edit` pelo `apply_patch` livre estilo Codex com uma gramática Lark. Sincronizada de [`code-yeongyu/pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch). | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/AGENTS.md) |
| 3 | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) | Presets de system prompt por modelo (gpt-5.x, claude-opus-4-{5,6,7}, kimi-k2-6) aplicados sobre o prompt dinâmico. Ajuste compartilhado de operações de arquivo estilo codex. | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/changes.md) |
| 4 | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) *(vendored)* | Ferramentas `todowrite` / `todoread` com persistência ciente de branch, widget na barra lateral, orientação de prompt de fluxo de trabalho e um loop de continuação. Sincronizada de [`code-yeongyu/pi-todotools`](https://github.com/code-yeongyu/pi-todotools). | — |
| 5 | [`redraws`](packages/coding-agent/src/core/extensions/builtin/redraws.ts) | Comando `/tui` que reporta a contagem cumulativa de redesenhos completos da TUI. Usado para depuração de renderização diferencial. | — |
| 6 | [`anthropic-web-search`](packages/coding-agent/src/core/extensions/builtin/anthropic-web-search/) | Ferramenta `web_search` nativa da Anthropic | — |
| 7 | [`anthropic-bash`](packages/coding-agent/src/core/extensions/builtin/anthropic-bash/) | Variante nativa da ferramenta bash da Anthropic | — |
| 8 | [`openai-web-search`](packages/coding-agent/src/core/extensions/builtin/openai-web-search/) | Ferramenta `web_search` nativa do OpenAI Responses | — |
| 9 | [`service-tier`](packages/coding-agent/src/core/extensions/builtin/service-tier.ts) | Injeta `service_tier` (`auto` / `flex` / `priority`) nos payloads do OpenAI Responses usando o nível de serviço por modelo ou a configuração `openai.serviceTier` | — |
| 10 | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) *(vendored)* | Injeta timeouts padrão + máximo no bash e anexa a política ao system prompt. Sincronizada de [`code-yeongyu/pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout). | — |
| 11 | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) | Sanitiza payloads de requisição da Anthropic removendo blocos `tool_result` órfãos — segurança na compactação | — |
| 12 | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) | Política de compactação especulativa + de emergência: monitor de degradação, circuit breaker, limite por turno, ponte de tarefas (todos), estado de checkpoint, rastreador de restauração, truncamento de resultado de ferramentas | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/compaction/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/compaction/changes.md) |
| 13 | [`history-search`](packages/coding-agent/src/core/extensions/builtin/history-search/) | Comando `/history` — pesquisa o histórico de prompts entre sessões em uma sobreposição | — |
| 14 | [`websearch`](packages/coding-agent/src/core/extensions/builtin/websearch/) | Ferramenta `web_search` apoiada por provedor com ativação controlada por configuração, status na TUI e resultados cientes da fonte | — |
| 15 | [`webfetch`](packages/coding-agent/src/core/extensions/builtin/webfetch/) | Ferramenta `webfetch` para obter conteúdo de URLs como markdown, texto ou HTML com limite de tempo e tamanho | — |
| 16 | [`nested-agents-md`](packages/coding-agent/src/core/extensions/builtin/nested-agents-md/) | Injeta automaticamente arquivos `AGENTS.md` próximos quando o agente lê de diretórios aninhados | — |
| 17 | [`rules`](packages/coding-agent/src/core/extensions/builtin/rules/) | Descobre automaticamente arquivos de regras do projeto e expõe os comandos `/rules` / `/reload-rules` | — |
| 18 | [`goal`](packages/coding-agent/src/core/extensions/builtin/goal/) | Ferramentas de acompanhamento persistente de objetivos, estado no rodapé e prompts de continuação | — |

> Os diretórios integrados acima são novos em relação ao `pi-mono` upstream — nenhum deles existe em `badlogic/pi-mono`. As versões vendored são fixadas em [`external-versions.json`](packages/coding-agent/src/core/extensions/builtin/external-versions.json) e sincronizadas a partir do checkout irmão `pi-extensions` com [`sync-builtin-extensions.mjs`](packages/coding-agent/scripts/sync-builtin-extensions.mjs).

### Repositórios de extensões independentes

Estes são mantidos como repositórios públicos `code-yeongyu/pi-*` e podem ser instalados via `packages` no `settings.json` ou com `senpi install git:github.com/code-yeongyu/<repo>`.

| Extensão | Repositório | O que faz |
|-----------|------------|--------------|
| `pi-comment-checker` | [`code-yeongyu/pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) | Executa `@code-yeongyu/comment-checker` após `write`, `edit`, `multiedit` e `apply_patch`, incluindo metadados de `apply_patch` compatíveis com OMO e fallback para patch bruto do Codex; exibe avisos em um widget acima do editor |

### Extensões padrão globais

Não são carregadas como extensões integradas; são gravadas uma única vez em `~/.senpi/agent/extensions/` na primeira execução para que você possa editá-las ou removê-las localmente.

| Extensão | Fonte | O que faz |
|-----------|--------|--------------|
| `diff` | [`diff.ts`](packages/coding-agent/src/core/extensions/builtin/diff.ts) | Comando `/diff` — seleciona arquivos modificados / excluídos / novos do `git status` e abre a visualização de diff do VS Code |
| `files` | [`files.ts`](packages/coding-agent/src/core/extensions/builtin/files.ts) | Comando `/files` — lista os arquivos lidos / gravados / editados na branch da sessão atual e abre o selecionado no VS Code |
| `prompt-url-widget` | [`prompt-url-widget.ts`](packages/coding-agent/src/core/extensions/builtin/prompt-url-widget.ts) | Detecta URLs de PR / issue do GitHub nos prompts, busca o título via `gh` e define automaticamente o nome da sessão |
| `tps` | [`tps.ts`](packages/coding-agent/src/core/extensions/builtin/tps.ts) | Notificação de tokens por segundo (entrada / saída / cache r/w / total / tempo decorrido) após cada turno do agente |

### Pacotes upstream modificados

| Pacote | O que mudou | Referência |
|---------|--------------|-----------|
| [`packages/ai`](packages/ai/AGENTS.md) | `originator` do Codex e User-Agent com a marca Senpi, utilitário compartilhado de reparo de pares de ferramentas, suporte a ferramentas personalizadas/livres no OpenAI Responses para `apply_patch`, Claude Opus 4.7 + nível de raciocínio `"max"`, repasse de `extraBody` em todos os provedores, [reescrita do middleware de chamada de ferramentas](packages/ai/src/tool-call-middleware/AGENTS.md) | [`ai/src/changes.md`](packages/ai/src/changes.md) |
| [`packages/agent`](packages/agent/AGENTS.md) | Emissão paralela de conclusão de ferramentas (finalização concorrente, resultados na ordem de origem), UUIDv7 inline substituindo a dependência `uuid`, diagnósticos de harness compatíveis com ES2021 | [`agent/src/changes.md`](packages/agent/src/changes.md) |
| [`packages/tui`](packages/tui/AGENTS.md) | Ajustes na renderização diferencial: caminho rápido para insert-scroll, correção de repintura no remapeamento da viewport, testes de regressão de limite de cintilação (sem limpezas completas pós-inicialização, DECSET 2026 balanceado) | [`tui/src/changes.md`](packages/tui/src/changes.md) |
| [`packages/coding-agent`](packages/coding-agent/AGENTS.md) | Marca `senpi`, controles de configuração de modelo (`upstreamModelId`, `serviceTier`, modelos favoritos, desativar/whitelist/blacklist), descoberta não bloqueante de ferramentas na inicialização, verificações de atualização na inicialização desativadas, [troca do `promptSnippet` do bash para `rg`](packages/coding-agent/src/core/tools/AGENTS.md), caminho rápido para extensão padrão gerada, identidade de saída com a marca senpi | Vários arquivos [`changes.md`](packages/coding-agent/src/) |

### Outras mudanças de marca / runtime

| Mudança | Detalhes |
|--------|---------|
| **Identidade de CLI `senpi`** | O agente de programação se identifica como `senpi`, usa `.senpi/agent` para armazenamento de configuração e é publicado no npm como `@code-yeongyu/senpi`. O executável instalado permanece `senpi`. |
| **Identidade de saída com a marca Senpi** | Toda requisição de saída emite `senpi` em vez de `pi`: `User-Agent` (verificação de atualização + Cloudflare + releases do GitHub), `X-OpenRouter-Title`, `originator` + User-Agent do OpenAI Codex. |
| **Sem verificações de atualização na inicialização** | Removida a verificação de versão no registro do npm e os prompts de atualização de pacotes ao iniciar. |
| **Agrupamento de UI para extensões integradas** | As extensões integradas são renderizadas sob um grupo `builtin/` no cabeçalho de inicialização, visualmente distintas das extensões de usuário e de projeto. |
| **Registro de modelos atualizado** | `models.generated.ts` atualizado com as adições e depreciações de modelos mais recentes. |
| **Alvo de autoatualização** | `senpi update senpi` consulta as releases de [`code-yeongyu/senpi`](https://github.com/code-yeongyu/senpi), não do upstream. |

<a id="fork-strategy"></a>

## Estratégia de Fork

Este fork faz rebase periodicamente em `upstream/main`. Para minimizar conflitos de merge:

1. **Extensões em primeiro lugar**: Todos os recursos usam o [sistema de extensões](packages/coding-agent/docs/extensions.md) do pi como extensões integradas.
2. **Documentar mudanças principais**: Toda modificação em arquivo do upstream tem um `changes.md` correspondente no subdiretório afetado, documentando o que mudou, o motivo e as zonas de conflito esperadas.
3. **Remotes**: `origin` = [code-yeongyu/senpi](https://github.com/code-yeongyu/senpi), `upstream` = [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

Arquivos do upstream modificados (alto impacto; veja o `changes.md` de cada diretório para o restante):

| Arquivo | Alteração |
|------|--------|
| `agent-session.ts` | Chama `buildDynamicSystemPrompt()` em vez de `buildSystemPrompt()`; pipeline de compactação unificado; alteração do prompt de sistema ao trocar de modelo |
| `resource-loader.ts` | Removida a descoberta de SYSTEM.md / APPEND_SYSTEM.md; adicionado carregamento de extensões integradas; fast-path para extensões padrão geradas |
| `interactive-mode.ts` | Formatação de exibição de extensões integradas; verificações de atualização desativadas; ferramentas de inicialização não bloqueantes; alternância entre modelos favoritos |
| `model-registry.ts` | `upstreamModelId` e `serviceTier` personalizados; desativação/whitelist/blacklist de provedor/modelo; `thinkingLevelMapMode` |
| `settings-manager.ts` | `disabledBuiltinExtensions`; `favoriteModels`; `openai.serviceTier`; padrão de steering `"all"` |
| `agent-loop.ts` (`packages/agent`) | `executeToolCallsParallel()` |
| `tui.ts` (`packages/tui`) | Fast paths de renderização diferencial + controle de flicker-budget |
| `package.json` | Renomeado o pacote do agente de programação e a identidade de runtime para `senpi` |

## Compartilhe suas sessões de agentes de programação OSS

Se você usa o pi ou outros agentes de programação para trabalhar com código aberto, por favor, compartilhe suas sessões.

Dados públicos de sessões OSS ajudam a melhorar os agentes de programação com tarefas do mundo real, uso de ferramentas, falhas e correções, em vez de benchmarks de brinquedo.

Para a explicação completa, veja [este post no X](https://x.com/badlogicgames/status/2037811643774652911).

Para publicar sessões, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Leia o README.md para instruções de configuração. Tudo o que você precisa é de uma conta no Hugging Face, a CLI do Hugging Face e o `pi-share-hf`.

Você também pode assistir a [este vídeo](https://x.com/badlogicgames/status/2041151967695634619), onde mostro como publico minhas sessões do `pi-mono`.

Eu publico regularmente minhas próprias sessões de trabalho do `pi-mono` aqui:

- [badlogicgames/pi-mono no Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## Todos os pacotes

| Pacote | Descrição |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | API de LLM multiprovedor unificada com streaming de texto, chamada de ferramentas, auxiliares de OAuth e geração de imagens |
| **[@earendil-works/pi-agent-core](packages/agent)** | Runtime de agente com chamada de ferramentas e gerenciamento de estado |
| **[senpi](packages/coding-agent)** | CLI interativa de agente de programação, renomeada como senpi |
| **[@code-yeongyu/senpi-codemode](packages/senpi-codemode)** | Pacote de extensão codemode somente em código-fonte com blocos de construção de configurações, kernel, bridge e prelude |
| **[@earendil-works/pi-tui](packages/tui)** | Biblioteca de UI de terminal com renderização diferencial |

Para automação e fluxos de trabalho de Slack/chat, consulte [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissões e Conteinerização

O senpi não inclui um limite de contêiner integrado para restringir o acesso ao sistema de arquivos, processos, rede ou credenciais. Por padrão, ele é executado com as permissões do usuário e do processo que o iniciaram.

Se você precisar de limites mais rígidos, conteinerize o senpi. Veja [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) para três padrões:

- **OpenShell**: execute todo o processo do `senpi` em um contêiner controlado por políticas.
- **Extensão Gondolin**: mantenha o `senpi` e a autenticação do provedor no host enquanto roteia as ferramentas integradas e os comandos `!` para uma micro-VM Linux local.
- **Docker puro**: execute todo o processo do `senpi` em um contêiner local para um isolamento simples.

## Contribuindo

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para as diretrizes de contribuição e [AGENTS.md](AGENTS.md) para as regras específicas do projeto (tanto para humanos quanto para agentes).

## Desenvolvimento

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
bun install --ignore-scripts # Bun alternative
bun run build        # Build all packages
bun run check        # Lint, format, and type check
bun run test             # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Live-API integration suite (env-gated; requires API keys)
bun run publish      # Publish npm workspaces, including @code-yeongyu/senpi
```

## Fortalecimento da cadeia de suprimentos

Tratamos alterações de dependências do npm como alterações de código revisadas.

- Dependências externas diretas são fixadas em versões exatas. Pacotes internos do workspace mantêm intervalos de versão.
- O `.npmrc` define `save-exact=true` e `min-release-age=2` para evitar lançamentos de dependências no mesmo dia durante a resolução do npm.
- O `package-lock.json` é a fonte da verdade das dependências. O pre-commit bloqueia commits acidentais do lockfile, a menos que `PI_ALLOW_LOCKFILE_CHANGE=1` esteja definido.
- `bun run check` verifica dependências diretas fixadas, compatibilidade de importação nativa do TypeScript e o lock de instalação gerado para o agente de programação.
- O manifesto publicado de `@code-yeongyu/senpi` é a lista de dependências de origem: os workspaces do fork são resolvidos por meio de seus aliases `@code-yeongyu/senpi-*` publicados e nada além do código de cliente/protocolo integrado é enviado dentro do tarball. Nenhum `npm-shrinkwrap.json` é publicado.
- Os smoke tests de lançamento usam `bun run release:local` para compilar, empacotar e criar instalações isoladas do npm e do Bun fora do repositório antes de criar a tag de uma versão.
- Instalações de versões locais, instalações documentadas do npm e `senpi update senpi` usam `--ignore-scripts` onde há suporte.
- O CI instala com `npm ci --ignore-scripts`, e um workflow agendado do GitHub executa `npm audit --omit=dev` além de `npm audit signatures --omit=dev`. Esses processos internos do npm estão inventariados para uma migração futura.
- A geração do lock de instalação tem uma allowlist explícita para scripts de ciclo de vida de dependências; novas dependências com scripts de ciclo de vida falham nas verificações até serem revisadas.

## Contribuindo

Veja [CONTRIBUTING.md](CONTRIBUTING.md) para as diretrizes de contribuição e [AGENTS.md](AGENTS.md) para as regras específicas do projeto (tanto para humanos quanto para agentes).

## Licença

MIT

## Ganbare Ganbare Senpi

> *Hora, senpi senpi, senpi te kudasai!*
> *Ganbare ganbare senpi, gan ganbare ganbare senpi ora!*

Uma pequena e nada séria carta de amor ao meme [Ganbare Ganbare Senpai](https://en.wikipedia.org/wiki/Don%27t_Toy_with_Me,_Miss_Nagatoro), ao qual o nome do projeto presta uma homenagem secreta. Toda vez que o rebase sai limpo e os testes ficam verdes, em algum lugar uma kouhai sussurra:

- **Vamos lá, senpi, vamos!** Suba o PR.
- **Me nota, senpi.** ...os diagnósticos notaram primeiro.
- **Esforce-se mais, senpi!** *(ela realmente olhou. e o build realmente passou.)*
- **Você consegue, senpi!** Mais um agente, mais uma ferramenta, mais um rebase limpo.
- **Ganbare, ganbare, senpi! 頑張れ頑張れ先輩!** *Dê o seu melhor, dê o seu melhor, senpai!*

Sim, o nome inteiro do projeto é um trocadilho com senpai. Use tipagem estrita, rode os testes, escreva um `changes.md`, mantenha a superfície de merge minúscula — e *gan ganbare ganbare senpi ora!*

Um salve para o [plugsuits](https://github.com/minpeter/pss-runtime): o sistema de compactação do senpi se inspira no design dele.
