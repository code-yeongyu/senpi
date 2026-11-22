[English](README.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-br.md) | [Italiano](README.it.md)

# senpi


<p align="center">
  <a href="https://discord.gg/PUwSMR9XNk"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/code-yeongyu/senpi/actions/workflows/ci.yml"><img alt="Estado de compilación" src="https://img.shields.io/github/actions/workflow/status/code-yeongyu/senpi/ci.yml?style=flat-square&branch=main" /></a>
</p>

> ⚠️ **Experimental.** senpi es un fork con criterio propio y en pleno desarrollo de [badlogic/pi-mono](https://github.com/badlogic/pi-mono). Impulsa a [Dori](https://sisyphuslabs.ai) por dentro y refleja lo que un asistente de IA específico necesita del runtime de un agente de programación. Úsalo, pero no apuestes un pipeline de producción a él.

senpi es un juego de palabras con senpai y un pi más **sensato** con baterías extra incluidas — un monorepo de TypeScript que renombra el agente de programación de pi-mono como `senpi` e incluye un conjunto seleccionado de extensiones integradas y ajustes del núcleo sobre upstream.

> **Upstream**: [pi-mono](https://github.com/badlogic/pi-mono) de [@mariozechner](https://github.com/badlogic) — herramientas para construir agentes de IA y gestionar despliegues de LLM.

## Inspirado en OMO, creado como el runtime de agente de programación de Dori

senpi nació de dos influencias:

- **Fuerte influencia de [OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent).** OMO es el harness de opencode de peso pesado con agentes de disciplina (Sisyphus, Hephaestus, Prometheus), [IntentGate](https://factory.ai/news/terminal-bench), ediciones ancladas por hash, Team Mode, MCPs integrados en skills, Ralph Loop, controladores de tareas pendientes y mucho más. senpi reutiliza muchas de las ideas características de OMO (intent gate, prompt dinámico, preajustes por modelo, enrutamiento de herramientas en paralelo, continuación de tareas pendientes), pero **mantiene la superficie lo más ligera posible** para permanecer cerca del upstream de pi-mono. Piensa en senpi como **una versión ligera de OMO** que se ejecuta como un único binario CLI de pi en lugar de un plugin de opencode.
- **senpi es el runtime de agente de programación para [Dori](https://sisyphuslabs.ai).** Dori es el asistente de IA de Sisyphus Labs — consulta la [mención a Dori en el README de OMO](https://github.com/code-yeongyu/oh-my-openagent#oh-my-openagent) para más contexto. senpi se puede usar de forma independiente, pero las decisiones de diseño (redacción del intent gate, conjunto de extensiones integradas, preajustes de prompt por familia de modelos, marca) están ajustadas a lo que Dori necesita cuando ejecuta trabajo de código.

Las modificaciones al código fuente principal se reducen al mínimo y se registran en archivos [`changes.md`](#fork-strategy) junto a cada subdirectorio modificado para que los commits de fusión con upstream sigan siendo fáciles de revisar.

| Paquete | Descripción |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Runtime independiente de composición de aplicaciones para servicios, estado replicado, RPC y plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Contratos de telemetría neutrales respecto al proveedor, adaptador de referencia, pruebas de conformidad y esquemas tipados |
| **[@earendil-works/pi-ai](packages/ai)** | API de LLM unificada y multiproveedor (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Runtime de agente con llamada a herramientas y gestión de estado |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | CLI interactiva de agente de programación |
| **[@earendil-works/pi-tui](packages/tui)** | Biblioteca de interfaz de terminal con renderizado diferencial |

## ¿Vienes de OMO? Configuración recomendada de extensiones

Si estás migrando desde [OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent), aquí tienes el mapa práctico de "lo que usaba en OMO" a "qué instalar en senpi". Gran parte del trabajo característico de OMO **ya viene integrado de serie en senpi** (no hay que instalar nada); el resto está en los repositorios de GitHub [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) a un solo `senpi install` de distancia.

> senpi es intencionalmente más ligero que OMO: un único binario CLI, no un plugin de opencode. Algunos conceptos de OMO (Discipline Agents, Team Mode, Skills, Hashline, Ralph Loop, `/init-deep`) **no tienen un equivalente 1:1 en senpi** y se indican al final de esta sección. Si los necesitas, sigue usando OMO.

### Ya integrado en senpi — no hay nada que instalar

| Función de OMO | Integrado en senpi |
|---|---|
| 🚪 **IntentGate** | [Prompt de sistema dinámico](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) — cada prompt se abre con un intent gate forzado antes de usar herramientas. |
| ✅ **Todo Enforcer** | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) + bucle de continuación que reactiva a los agentes inactivos. |
| **Ajuste por modelo** ("Model Setup") | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) — presets para GPT-5.x / Claude Opus 4.{5,6,7} / Kimi K2.6. |
| **Recuperación de sesión / gestión de contexto** | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) — umbrales adaptativos, rastreador de restauración, compactación de emergencia, truncamiento de resultados de herramientas. |
| **Apply-patch en modelos GPT** | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) — `apply_patch` de formato libre estilo Codex con gramática Lark. |
| **Búsqueda web nativa** (Anthropic + OpenAI) | Integrados `anthropic-web-search`, `openai-web-search`. |
| **Disciplina de tiempos de espera en Bash** | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) — aplicación de tiempo de espera predeterminado y máximo, política en el prompt del sistema. |
| **Emparejamiento de herramientas seguro ante compactación** | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) — elimina bloques `tool_result` huérfanos. |
| **Sistema de permisos** (permitir/denegar estilo opencode) | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) — reglas, almacenamiento JSONL, prompts TUI, patrones conscientes del parser. |

### Elige extensiones para tu configuración de OMO

Las funciones integradas de Senpi, las extensiones independientes `pi-*` y el
[plugin OMO Senpi](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-senpi/plugin)
se solapan. No instales todos los paquetes independientes cuando Senpi o el plugin ya ofrezcan esa capacidad.

| Capacidad | Senpi sin el plugin de OMO | Senpi con el plugin de OMO |
|---|---|---|
| LSP | Instala [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client). | El plugin registra seis herramientas LSP mediante su demonio empaquetado. Instala `pi-lsp-client` solo si necesitas específicamente su inspector `/lsp`. |
| AST-grep | Instala [`pi-ast-grep`](https://github.com/code-yeongyu/pi-ast-grep). | El plugin incluye una skill de AST-grep, un helper y scripts de instalación. `pi-ast-grep` sigue siendo opcional si quieres las herramientas nativas `ast_grep_search` y `ast_grep_replace`. |
| Revisión de comentarios | Instala [`pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker). | El plugin registra su propio componente de revisión de comentarios; no instales también la extensión independiente. |
| Reglas y `AGENTS.md` anidados | Ya incluido mediante los integrados `rules` y `nested-agents-md`. | Igual; no se requiere ninguna extensión independiente. |
| Búsqueda y obtención web | Ya incluido mediante los integrados `websearch` y `webfetch`. | Igual; no se requiere ninguna extensión independiente. |
| Objetivos persistentes | Ya incluido mediante el integrado `goal`. | Igual; no se requiere ninguna extensión independiente. |
| Perfiles de subagentes | [`pi-agent-system`](https://github.com/code-yeongyu/pi-agent-system) admite lanzadores externos que definen `PI_AGENT_TYPE` o `SANEPI_AGENT_TYPE`. | El plugin gestiona el enrutamiento de tareas/miembros y el filtrado de herramientas, por lo que `pi-agent-system` normalmente no es necesario. Consérvalo solo cuando otro lanzador dependa de su contrato de variables de entorno. |

Para Senpi independiente sin el plugin de OMO, instala solo las capacidades no integradas que necesites:

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

Consulta [Paquetes de Senpi](packages/coding-agent/README.md#pi-packages) para ver el flujo completo de instalación, actualización y eliminación.

### Permitir todos los permisos (estilo OMO)

OMO se ejecuta con todos los permisos de herramientas preaprobados. Para replicar ese comportamiento en senpi, añade una regla comodín de permitir en tu configuración global:

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

Esto indica al sistema de permisos que apruebe automáticamente cada llamada a herramientas sin preguntar. La clave `"*"` coincide con todos los nombres de permisos, y `"allow"` los concede de forma incondicional. También puedes configurarlo por proyecto colocando el mismo `settings.json` en `.senpi/settings.json` en la raíz del proyecto.

> **Nota:** Esto desactiva todos los prompts interactivos de permisos. Hazlo solo si confías en el modelo y en el espacio de trabajo donde lo estás ejecutando.

### Sin equivalente directo en senpi

Estas características forman parte de la estructura del harness de opencode de OMO y deliberadamente **no** están en senpi:

- **Discipline Agents** (Sisyphus / Hephaestus / Oracle / Librarian / Explore / Multimodal Looker) y el punto de entrada de orquestación de una sola palabra **`ultrawork` / `ulw`**.
- **Team Mode** — líder + hasta 8 miembros en paralelo, visualización en tmux, familia de herramientas `team_*` y las skills `hyperplan` / `security-research` funcionando por encima.
- **Hashline / herramienta de edición anclada por hash** — senpi se mantiene con las herramientas estándar de pi `edit` / `multiedit` / `apply_patch`. `pi-comment-checker` cubre la validación posterior a la edición para la que OMO usa Hashline, pero sin los identificadores de hash de contenido `LINE#ID`.
- **Sistema de skills** y **MCP integrados en skills** — las skills como concepto de primera clase (`SKILL.md`, servidores MCP con alcance por skill) no existen en senpi.
- **Planificador en modo entrevista Prometheus** y el bucle autorreferencial **Ralph Loop / `/ulw-loop`**.
- **`/init-deep`** — no hay un generador integrado en el árbol. Genera el árbol jerárquico de `AGENTS.md` manualmente (o con un prompt de agente normal); la extensión integrada `nested-agents-md` leerá los archivos resultantes.
- **Comando `doctor` integrado**, **capa de compatibilidad de hooks/comandos/skills/plugins de Claude Code** y el **enrutador de categorías de agentes** (`visual-engineering` / `deep` / `quick` / `ultrabrain`).

## ¿Quieres más? Prueba el ecosistema de pi-extensions

senpi incluye un conjunto fijo de extensiones integradas y se detiene ahí. Los repositorios de GitHub [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) contienen el ecosistema completo de extensiones: algunos paquetes vienen integrados en senpi de serie, mientras que el resto se puede instalar encima cuando quieras capacidades adicionales como LSP o AST-grep.

### Extensiones instalables

Estos paquetes [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) están pensados para instalarse como extensiones independientes de senpi/pi:

| Extensión | Qué añade |
|---|---|
| [`pi-anthropic-code-execution`](https://github.com/code-yeongyu/pi-anthropic-code-execution) | Ejecución de código nativa de Anthropic. |
| [`pi-anthropic-computer-use`](https://github.com/code-yeongyu/pi-anthropic-computer-use) | Bindings de computer-use de Anthropic. |
| [`pi-anthropic-text-editor`](https://github.com/code-yeongyu/pi-anthropic-text-editor) | Herramienta de editor de texto nativa de Anthropic. |
| [`pi-anthropic-tool-search`](https://github.com/code-yeongyu/pi-anthropic-tool-search) | Búsqueda de herramientas nativa de Anthropic. |
| [`pi-anthropic-web-fetch`](https://github.com/code-yeongyu/pi-anthropic-web-fetch) | Soporte nativo de obtención web (web fetch) de Anthropic. |
| [`pi-ast-grep`](https://github.com/code-yeongyu/pi-ast-grep) | Búsqueda y reemplazo de código basado en AST en 25 lenguajes. Descarga `sg` automáticamente en el primer uso. |
| [`pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) | Ejecuta comprobaciones de calidad de comentarios tras usar herramientas de edición de archivos y muestra advertencias en la TUI. |
| [`pi-cua-integration`](https://github.com/code-yeongyu/pi-cua-integration) | Conexión de acciones de computer-use para superficies de interacción de escritorio y navegador. |
| [`pi-google-code-execution`](https://github.com/code-yeongyu/pi-google-code-execution) | Ejecución de código nativa de Google. |
| [`pi-google-google-search`](https://github.com/code-yeongyu/pi-google-google-search) | Fundamentación (grounding) con Google Search. |
| [`pi-google-url-context`](https://github.com/code-yeongyu/pi-google-url-context) | Fundamentación (grounding) de URL de Google. |
| [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client) | Integración con LSP: `lsp_rename`, `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`, además de un inspector `/lsp`. |
| [`pi-openai-api-parallel-tool-calls`](https://github.com/code-yeongyu/pi-openai-api-parallel-tool-calls) | Soporte para el payload `parallel_tool_calls` de OpenAI. |
| [`pi-openai-code-interpreter`](https://github.com/code-yeongyu/pi-openai-code-interpreter) | Code Interpreter de OpenAI. |

Instala cualquiera de ellas con:

```bash
senpi install git:github.com/code-yeongyu/pi-ast-grep
senpi install git:github.com/code-yeongyu/pi-lsp-client
# ...substitute any of the package names from the table above.
```

Consulta [Paquetes de Senpi](packages/coding-agent/README.md#pi-packages) para ver el flujo de instalación, actualización y eliminación.

### Paquetes de pi-extension ya incluidos de serie en senpi

**No** necesitas instalar estos paquetes para el uso normal de senpi; su funcionalidad ya viene incluida en el binario. Esta tabla se limita intencionalmente a los paquetes que corresponden a la lista `builtinExtensions` registrada actualmente:

| Paquete | Incluido como | Capacidad integrada |
|---|---|---|
| [`pi-anthropic-bash`](https://github.com/code-yeongyu/pi-anthropic-bash) | `anthropic-bash` | Variante de la herramienta bash nativa de Anthropic. |
| [`pi-anthropic-web-search`](https://github.com/code-yeongyu/pi-anthropic-web-search) | `anthropic-web-search` | Soporte de búsqueda web nativa de Anthropic. |
| [`pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch) | `gpt-apply-patch` | Herramienta `apply_patch` al estilo de Codex para ejecuciones de la familia GPT. |
| [`pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout) | `bash-timeout` | Valores predeterminados de tiempo de espera de bash, aplicación de tiempo máximo y política de prompt. |
| [`pi-goal`](https://github.com/code-yeongyu/pi-goal) | `goal` | Seguimiento persistente de objetivos, estado en la TUI y prompts de continuación. |
| [`pi-nested-agents-md`](https://github.com/code-yeongyu/pi-nested-agents-md) | `nested-agents-md` | Inyecta automáticamente archivos `AGENTS.md` cercanos para directorios anidados. |
| [`pi-openai-web-search`](https://github.com/code-yeongyu/pi-openai-web-search) | `openai-web-search` | Búsqueda web nativa de OpenAI Responses. |
| [`pi-rules`](https://github.com/code-yeongyu/pi-rules) | `rules` | Descubre archivos de reglas de proyecto y de usuario, incluidos `AGENTS.md` y `CLAUDE.md`. |
| [`pi-todotools`](https://github.com/code-yeongyu/pi-todotools) | `todowrite` | `todowrite` / `todoread`, estado de tareas pendientes en la barra lateral, guía de prompt para flujos de trabajo y seguimientos de continuación. |
| [`pi-webfetch`](https://github.com/code-yeongyu/pi-webfetch) | `webfetch` | Obtiene contenido de URL como markdown, texto o HTML con límites de tiempo y tamaño. |
| [`pi-websearch`](https://github.com/code-yeongyu/pi-websearch) | `websearch` | Búsqueda web respaldada por proveedores con activación controlada por configuración y resultados con información de las fuentes. |

Otras extensiones integradas como `permission-system`, `prompt-preset`, `service-tier`, `tool-pair-guard`, `compaction`, `history-search` y `session-observer` son extensiones integradas propias de senpi sin paquetes equivalentes instalables.

## Por qué "senpi"

`senpi` es un pequeño juego de palabras con **senpai**, pero también refleja literalmente el posicionamiento del proyecto: este fork busca ser un pi más **sensato** con adiciones prácticas que hacen más fluido el trabajo diario del agente sin abandonar el diseño principal de upstream.

Todas las adiciones siguen la filosofía de pi centrada en extensiones. Las modificaciones en el código fuente principal se reducen al mínimo y se [documentan en archivos `changes.md`](#fork-strategy) para que los commits de merge desde upstream sigan siendo fáciles de revisar.

## Qué agrega este fork

senpi hereda el diseño centrado en extensiones de pi: el núcleo se mantiene mínimo y cada funcionalidad llega como una extensión integrada. La apuesta es que un conjunto de funcionalidades con criterio propio se necesita con la suficiente frecuencia como para incluirlo en el binario; cualquier cosa que no quieras sigue estando a una opción de configuración de desactivarse (`disabledBuiltinExtensions` en `settings.json`).

Verificado contra `git diff upstream/main..HEAD` y cada archivo `changes.md` del repositorio.

### Nuevos subsistemas centrales

| Subsistema | Qué hace | Docs |
|-----------|--------------|------|
| **Prompt del sistema dinámico** | Reemplaza el prompt estático de upstream con un constructor adaptativo: identidad de senpi → intent gate forzado → disciplina de ejecución de tareas (oleadas paralelas, paradas de exploración, compromiso con un solo plan) → niveles de verificación → referencia de herramientas categorizada → políticas → estilo → ajuste opcional por modelo. | [`dynamic-prompt/`](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) · [`changes.md`](packages/coding-agent/src/core/dynamic-prompt/changes.md) |
| **Pipeline de compactación** | Umbrales adaptativos estilo Plugsuit, protección contra resúmenes vacíos y hooks de resumen de ramas. La compactación especulativa y de emergencia con rastreador de restauración reside en la [extensión integrada `compaction`](#owned-builtin-extensions). | [`core/compaction/`](packages/coding-agent/src/core/compaction/) · [`changes.md`](packages/coding-agent/src/core/compaction/changes.md) |
| **Reescritura del middleware de llamadas a herramientas** | Protocolos de herramientas de texto XML / Hermes / YAML+XML / Gemma4 para modelos sin llamada a funciones nativa. Análisis estricto y preservación de errores de stream. | [`tool-call-middleware/`](packages/ai/src/tool-call-middleware/AGENTS.md) · [`changes.md`](packages/ai/src/tool-call-middleware/changes.md) |

<a id="owned-builtin-extensions"></a>

### Extensiones integradas propias

En el árbol del repositorio, estrechamente acopladas a los componentes internos de senpi. Se cargan en este orden exacto de registro:

| # | Extensión | Función | Docs |
|---|-----------|------|------|
| 1 | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) | Port completo de permisos estilo opencode: reglas, almacenamiento JSONL, prompts en TUI, patrones conscientes del parser (aridad de bash, globs de archivos, rutas en el cuerpo de `apply_patch`) y respaldo no interactivo | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/permission-system/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/permission-system/changes.md) |
| 2 | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) *(vendorizada)* | Cuando el modelo activo es OpenAI GPT, cambia `write`/`edit` por `apply_patch` de formato libre estilo Codex con una gramática Lark. Sincronizada desde [`code-yeongyu/pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch). | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/AGENTS.md) |
| 3 | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) | Presets de prompt del sistema por modelo (gpt-5.x, claude-opus-4-{5,6,7}, kimi-k2-6) aplicados sobre el prompt dinámico. Ajuste compartido de operaciones de archivos estilo codex. | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/changes.md) |
| 4 | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) *(vendorizada)* | Herramientas `todowrite` / `todoread` con persistencia consciente de ramas, widget de barra lateral, guía de flujo de trabajo en el prompt y un bucle de continuación. Sincronizada desde [`code-yeongyu/pi-todotools`](https://github.com/code-yeongyu/pi-todotools). | — |
| 5 | [`redraws`](packages/coding-agent/src/core/extensions/builtin/redraws.ts) | Comando `/tui` que informa el conteo acumulado de redibujados completos de la TUI. Usado para depurar el renderizado diferencial. | — |
| 6 | [`anthropic-web-search`](packages/coding-agent/src/core/extensions/builtin/anthropic-web-search/) | Herramienta `web_search` nativa de Anthropic | — |
| 7 | [`anthropic-bash`](packages/coding-agent/src/core/extensions/builtin/anthropic-bash/) | Variante de herramienta bash nativa de Anthropic | — |
| 8 | [`openai-web-search`](packages/coding-agent/src/core/extensions/builtin/openai-web-search/) | `web_search` nativo de OpenAI Responses | — |
| 9 | [`service-tier`](packages/coding-agent/src/core/extensions/builtin/service-tier.ts) | Inyecta `service_tier` (`auto` / `flex` / `priority`) en los payloads de OpenAI Responses usando el nivel de servicio por modelo o el ajuste `openai.serviceTier` | — |
| 10 | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) *(vendorizada)* | Inyecta tiempos de espera predeterminados y máximos de bash, y agrega la política al prompt del sistema. Sincronizada desde [`code-yeongyu/pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout). | — |
| 11 | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) | Sanea los payloads de solicitudes de Anthropic eliminando bloques `tool_result` huérfanos (seguridad en la compactación) | — |
| 12 | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) | Política de compactación especulativa y de emergencia: monitor de degradación, disyuntor (circuit breaker), límite por turno, puente de tareas pendientes, estado de puntos de control, rastreador de restauración y truncamiento de resultados de herramientas | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/compaction/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/compaction/changes.md) |
| 13 | [`history-search`](packages/coding-agent/src/core/extensions/builtin/history-search/) | Comando `/history`: busca en el historial de prompts entre sesiones dentro de una superposición | — |
| 14 | [`websearch`](packages/coding-agent/src/core/extensions/builtin/websearch/) | Herramienta `web_search` respaldada por proveedor con activación controlada por configuración, estado en TUI y resultados conscientes de la fuente | — |
| 15 | [`webfetch`](packages/coding-agent/src/core/extensions/builtin/webfetch/) | Herramienta `webfetch` para obtener contenido de URLs como markdown, texto o HTML con límites de tiempo y tamaño | — |
| 16 | [`nested-agents-md`](packages/coding-agent/src/core/extensions/builtin/nested-agents-md/) | Inyecta automáticamente archivos `AGENTS.md` cercanos cuando el agente lee desde directorios anidados | — |
| 17 | [`rules`](packages/coding-agent/src/core/extensions/builtin/rules/) | Descubre automáticamente archivos de reglas del proyecto y expone los comandos `/rules` y `/reload-rules` | — |
| 18 | [`goal`](packages/coding-agent/src/core/extensions/builtin/goal/) | Herramientas de seguimiento de objetivos persistentes, estado en el pie de página y prompts de continuación | — |

> Los directorios integrados anteriores son nuevos respecto a `pi-mono` upstream; ninguno existe en `badlogic/pi-mono`. Las versiones vendorizadas están fijadas en [`external-versions.json`](packages/coding-agent/src/core/extensions/builtin/external-versions.json) y se sincronizan desde el checkout hermano `pi-extensions` con [`sync-builtin-extensions.mjs`](packages/coding-agent/scripts/sync-builtin-extensions.mjs).

### Repositorios de extensiones independientes

Se mantienen como repositorios públicos `code-yeongyu/pi-*` y se pueden instalar mediante `packages` en `settings.json` o con `senpi install git:github.com/code-yeongyu/<repo>`.

| Extensión | Repositorio | Qué hace |
|-----------|------------|--------------|
| `pi-comment-checker` | [`code-yeongyu/pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) | Ejecuta `@code-yeongyu/comment-checker` después de `write`, `edit`, `multiedit` y `apply_patch`, incluidos metadatos de `apply_patch` compatibles con OMO y respaldo de parches sin procesar de Codex; muestra advertencias en un widget sobre el editor |

### Extensiones globales predeterminadas

No se cargan como extensiones integradas; se escriben una sola vez en `~/.senpi/agent/extensions/` en la primera ejecución para que puedas editarlas o eliminarlas localmente.

| Extensión | Fuente | Qué hace |
|-----------|--------|--------------|
| `diff` | [`diff.ts`](packages/coding-agent/src/core/extensions/builtin/diff.ts) | Comando `/diff`: toma archivos modificados, eliminados o nuevos de `git status` y abre la vista de diferencias de VS Code |
| `files` | [`files.ts`](packages/coding-agent/src/core/extensions/builtin/files.ts) | Comando `/files`: lista los archivos leídos, escritos o editados en la rama de la sesión actual y abre el seleccionado en VS Code |
| `prompt-url-widget` | [`prompt-url-widget.ts`](packages/coding-agent/src/core/extensions/builtin/prompt-url-widget.ts) | Detecta URLs de PRs o issues de GitHub en los prompts, obtiene el título mediante `gh` y asigna automáticamente el nombre de la sesión |
| `tps` | [`tps.ts`](packages/coding-agent/src/core/extensions/builtin/tps.ts) | Notificación de tokens por segundo (entrada / salida / lectura y escritura de caché / total / tiempo transcurrido) después de cada turno del agente |

### Paquetes upstream modificados

| Paquete | Qué cambió | Referencia |
|---------|--------------|-----------|
| [`packages/ai`](packages/ai/AGENTS.md) | `originator` y User-Agent de Codex con marca Senpi, utilidad compartida de reparación de pares de herramientas, soporte de herramientas personalizadas/de formato libre en OpenAI Responses para `apply_patch`, Claude Opus 4.7 + nivel de pensamiento `"max"`, paso directo de `extraBody` en todos los proveedores, [reescritura del middleware de llamadas a herramientas](packages/ai/src/tool-call-middleware/AGENTS.md) | [`ai/src/changes.md`](packages/ai/src/changes.md) |
| [`packages/agent`](packages/agent/AGENTS.md) | Emisión de finalización de herramientas en paralelo (finalización concurrente, resultados en orden de origen), UUIDv7 en línea que reemplaza la dependencia `uuid`, diagnósticos del harness compatibles con ES2021 | [`agent/src/changes.md`](packages/agent/src/changes.md) |
| [`packages/tui`](packages/tui/AGENTS.md) | Optimización del renderizado diferencial: ruta rápida de desplazamiento por inserción, corrección de repintado al reasignar el viewport, pruebas de regresión de presupuesto de parpadeo (sin limpiezas completas tras la inicialización, DECSET 2026 balanceado) | [`tui/src/changes.md`](packages/tui/src/changes.md) |
| [`packages/coding-agent`](packages/coding-agent/AGENTS.md) | Marca `senpi`, controles de configuración de modelos (`upstreamModelId`, `serviceTier`, modelos favoritos, desactivar/lista blanca/lista negra), descubrimiento de herramientas sin bloqueo al inicio, comprobaciones de actualización al inicio desactivadas, [cambio de `promptSnippet` de bash a `rg`](packages/coding-agent/src/core/tools/AGENTS.md), ruta rápida de extensiones predeterminadas generadas, identidad saliente con marca senpi | Múltiples archivos [`changes.md`](packages/coding-agent/src/) |

### Otros cambios de marca y tiempo de ejecución

| Cambio | Detalles |
|--------|---------|
| **Identidad de la CLI `senpi`** | El agente de programación se identifica como `senpi`, usa `.senpi/agent` para almacenar la configuración y se publica en npm como `@code-yeongyu/senpi`. El ejecutable instalado sigue siendo `senpi`. |
| **Identidad saliente con marca Senpi** | Cada solicitud saliente emite `senpi` en lugar de `pi`: `User-Agent` (comprobación de actualizaciones + Cloudflare + lanzamientos de GitHub), `X-OpenRouter-Title`, `originator` + User-Agent de OpenAI Codex. |
| **Sin comprobaciones de actualización al inicio** | Se eliminó la verificación de versiones en el registro de npm y los avisos de actualización de paquetes al iniciar. |
| **Agrupación de extensiones integradas en la interfaz** | Las extensiones integradas se muestran bajo un grupo `builtin/` en el encabezado de inicio, visualmente diferenciadas de las extensiones de usuario y de proyecto. |
| **Registro de modelos actualizado** | `models.generated.ts` actualizado con las últimas incorporaciones y desaprobaciones de modelos. |
| **Destino de autoactualización** | `senpi update senpi` consulta los lanzamientos de [`code-yeongyu/senpi`](https://github.com/code-yeongyu/senpi), no de upstream. |

<a id="fork-strategy"></a>

## Estrategia de fork

Este fork hace rebase periódicamente sobre `upstream/main`. Para minimizar los conflictos de fusión:

1. **Prioridad a las extensiones**: Todas las funcionalidades usan el [sistema de extensiones](packages/coding-agent/docs/extensions.md) de pi como extensiones integradas.
2. **Documentar cambios principales**: Cada modificación de un archivo upstream tiene su correspondiente `changes.md` en el subdirectorio afectado, donde se documenta qué cambió, por qué y las zonas de conflicto esperadas.
3. **Remotos**: `origin` = [code-yeongyu/senpi](https://github.com/code-yeongyu/senpi), `upstream` = [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

Archivos upstream modificados (de alto impacto; consulta el `changes.md` de cada directorio para el resto):

| Archivo | Cambio |
|------|--------|
| `agent-session.ts` | Llama a `buildDynamicSystemPrompt()` en lugar de `buildSystemPrompt()`; pipeline de compactación unificado; cambio del system prompt al cambiar de modelo |
| `resource-loader.ts` | Se eliminó el descubrimiento de SYSTEM.md / APPEND_SYSTEM.md; se agregó la carga de extensiones integradas; ruta rápida para extensiones predeterminadas generadas |
| `interactive-mode.ts` | Formato de visualización de extensiones integradas; comprobaciones de actualización deshabilitadas; herramientas de inicio no bloqueantes; rotación de modelos favoritos |
| `model-registry.ts` | `upstreamModelId` y `serviceTier` personalizados; deshabilitación/lista blanca/lista negra de proveedores y modelos; `thinkingLevelMapMode` |
| `settings-manager.ts` | `disabledBuiltinExtensions`; `favoriteModels`; `openai.serviceTier`; steering predeterminado en `"all"` |
| `agent-loop.ts` (`packages/agent`) | `executeToolCallsParallel()` |
| `tui.ts` (`packages/tui`) | Rutas rápidas de renderizado diferencial + aplicación de presupuesto de parpadeo |
| `package.json` | Cambio de marca del paquete del agente de programación y de la identidad del runtime a `senpi` |

## Comparte tus sesiones OSS de agentes de programación

Si usas pi u otros agentes de programación para trabajar en código abierto, por favor comparte tus sesiones.

Los datos públicos de sesiones OSS ayudan a mejorar los agentes de programación con tareas del mundo real, uso de herramientas, fallos y correcciones en lugar de benchmarks de juguete.

Para ver la explicación completa, consulta [esta publicación en X](https://x.com/badlogicgames/status/2037811643774652911).

Para publicar sesiones, usa [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Lee su README.md para ver las instrucciones de configuración. Todo lo que necesitas es una cuenta de Hugging Face, la CLI de Hugging Face y `pi-share-hf`.

También puedes ver [este video](https://x.com/badlogicgames/status/2041151967695634619), donde muestro cómo publico mis sesiones de `pi-mono`.

Publico regularmente mis propias sesiones de trabajo de `pi-mono` aquí:

- [badlogicgames/pi-mono en Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## Todos los paquetes

| Paquete | Descripción |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | API de LLM multiproveedor unificada con streaming de texto, llamada a herramientas, utilidades de OAuth y generación de imágenes |
| **[@earendil-works/pi-agent-core](packages/agent)** | Runtime de agente con llamada a herramientas y gestión de estado |
| **[senpi](packages/coding-agent)** | CLI interactiva de agente de programación, renombrada como senpi |
| **[@code-yeongyu/senpi-codemode](packages/senpi-codemode)** | Paquete de extensión codemode solo de código fuente con bloques de construcción de configuración, kernel, puente y preludio |
| **[@earendil-works/pi-tui](packages/tui)** | Biblioteca de interfaz de terminal con renderizado diferencial |

Para automatización y flujos de trabajo de Slack/chat, consulta [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permisos y contenedorización

senpi no incluye un límite de contenedor integrado para restringir el acceso al sistema de archivos, procesos, red o credenciales. De forma predeterminada, se ejecuta con los permisos del usuario y del proceso que lo inició.

Si necesitas límites más estrictos, ejecuta senpi en un contenedor. Consulta [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) para ver tres patrones:

- **OpenShell**: ejecuta todo el proceso `senpi` en un contenedor controlado por políticas.
- **Extensión Gondolin**: mantén `senpi` y la autenticación de proveedores en el host mientras enrutas las herramientas integradas y los comandos `!` hacia una micro-VM de Linux local.
- **Docker estándar**: ejecuta todo el proceso `senpi` en un contenedor local para un aislamiento sencillo.

## Contribuir

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para ver las pautas de contribución y [AGENTS.md](AGENTS.md) para las reglas específicas del proyecto (tanto para humanos como para agentes).

## Desarrollo

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
bun install --ignore-scripts # Bun alternative
bun run build        # Build all packages
bun run check        # Lint, format, and type check
bun run test             # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Live-API integration suite (env-gated; requires API keys)
bun run publish      # Publish npm workspaces, including @code-yeongyu/senpi
```

## Endurecimiento de la cadena de suministro

Tratamos los cambios en las dependencias de npm como cambios de código revisados.

- Las dependencias externas directas están fijadas a versiones exactas. Los paquetes internos del espacio de trabajo mantienen rangos de versiones.
- `.npmrc` define `save-exact=true` y `min-release-age=2` para evitar versiones de dependencias publicadas el mismo día durante la resolución de npm.
- `package-lock.json` es la fuente de verdad de las dependencias. El pre-commit bloquea commits accidentales del archivo de bloqueo a menos que se configure `PI_ALLOW_LOCKFILE_CHANGE=1`.
- `bun run check` verifica las dependencias directas fijadas, la compatibilidad de importación nativa de TypeScript y el bloqueo de instalación generado para el agente de programación.
- El manifiesto publicado de `@code-yeongyu/senpi` es la lista de dependencias de origen: los espacios de trabajo del fork se resuelven mediante sus alias `@code-yeongyu/senpi-*` publicados y dentro del tarball solo se envía el código de cliente/protocolo incluido (vendored). No se publica ningún `npm-shrinkwrap.json`.
- Las pruebas de humo de lanzamiento usan `bun run release:local` para compilar, empaquetar y crear instalaciones aisladas de npm y Bun fuera del repositorio antes de etiquetar una versión.
- Las instalaciones locales de lanzamiento, las instalaciones documentadas de npm y `senpi update senpi` usan `--ignore-scripts` donde sea compatible.
- La CI instala con `npm ci --ignore-scripts`, y un flujo de trabajo programado de GitHub ejecuta `npm audit --omit=dev` además de `npm audit signatures --omit=dev`. Estos elementos internos de npm están inventariados para una migración posterior.
- La generación del bloqueo de instalación tiene una lista de permitidos explícita para los scripts de ciclo de vida de las dependencias; las nuevas dependencias con scripts de ciclo de vida fallan las verificaciones hasta que se revisan.

## Contribuir

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para ver las pautas de contribución y [AGENTS.md](AGENTS.md) para las reglas específicas del proyecto (tanto para humanos como para agentes).

## Licencia

MIT

## Ganbare Ganbare Senpi

> *Hora, senpi senpi, senpi te kudasai!*
> *Ganbare ganbare senpi, gan ganbare ganbare senpi ora!*

Una pequeña y nada seria carta de amor al meme [Ganbare Ganbare Senpai](https://en.wikipedia.org/wiki/Don%27t_Toy_with_Me,_Miss_Nagatoro) al que el nombre del proyecto le rinde homenaje en secreto. Cada vez que el rebase queda limpio y los tests están en verde, en algún lugar una kouhai susurra:

- **¡Vamos senpi, vamos!** Lanza el PR.
- **Nótame, senpi.** ...los diagnósticos lo notaron primero.
- **¡Esfuérzate más, senpi!** *(sí miró. y el build sí pasó.)*
- **¡Tú puedes, senpi!** Un agente más, una herramienta más, un rebase limpio más.
- **Ganbare, ganbare, senpi! 頑張れ頑張れ先輩!** *¡Da lo mejor de ti, da lo mejor de ti, senpai!*

Sí, todo el nombre del proyecto es un juego de palabras con senpai. Usa tipado estricto, ejecuta los tests, escribe un `changes.md`, mantén pequeña la superficie de merge — y *gan ganbare ganbare senpi ora!*

Mención especial a [plugsuits](https://github.com/minpeter/pss-runtime): el sistema de compactación de senpi se inspira en su diseño.
