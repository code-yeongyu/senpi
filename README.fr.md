[English](README.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-br.md) | [Italiano](README.it.md)

# senpi


<p align="center">
  <a href="https://discord.gg/PUwSMR9XNk"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/code-yeongyu/senpi/actions/workflows/ci.yml"><img alt="Statut du build" src="https://img.shields.io/github/actions/workflow/status/code-yeongyu/senpi/ci.yml?style=flat-square&branch=main" /></a>
</p>

> ⚠️ **Expérimental.** senpi est un fork aux choix tranchés et en pleine évolution de [badlogic/pi-mono](https://github.com/badlogic/pi-mono). Il propulse [Dori](https://sisyphuslabs.ai) sous le capot et reflète ce dont un assistant IA spécifique a besoin dans un runtime d'agent de code. Utilisez-le, mais ne misez pas un pipeline de production dessus.

senpi est un jeu de mots sur « senpai » et un pi plus **sain** (sane) avec tout le nécessaire inclus — un monorepo TypeScript qui renomme l'agent de code de pi-mono en `senpi` et embarque une sélection d'extensions intégrées ainsi que des ajustements internes par-dessus le projet upstream.

> **Upstream** : [pi-mono](https://github.com/badlogic/pi-mono) par [@mariozechner](https://github.com/badlogic) — des outils pour créer des agents IA et gérer les déploiements de LLM.

## Inspiré par OMO, conçu comme le runtime d'agent de code de Dori

senpi est né de deux influences :

- **Forte influence d'[OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent).** OMO est le harness opencode poids lourd avec des agents de discipline (Sisyphus, Hephaestus, Prometheus), [IntentGate](https://factory.ai/news/terminal-bench), des modifications ancrées par hachage, Team Mode, des MCP intégrés aux skills, Ralph Loop, des contrôleurs de tâches (todo enforcers), et bien plus encore. senpi réutilise bon nombre des idées phares d'OMO (intent gate, prompt dynamique, préréglages par modèle, routage d'outils en parallèle, continuation des tâches) mais **garde une surface aussi légère que possible** pour rester proche du dépôt upstream pi-mono. Voyez senpi comme **une version légère d'OMO** qui s'exécute sous la forme d'un binaire CLI pi unique plutôt que d'un plugin opencode.
- **senpi est le runtime d'agent de code pour [Dori](https://sisyphuslabs.ai).** Dori est l'assistant IA de Sisyphus Labs — consultez [l'encadré sur Dori dans le README d'OMO](https://github.com/code-yeongyu/oh-my-openagent#oh-my-openagent) pour le contexte. senpi est utilisable de manière autonome, mais les choix de conception (formulation de l'intent gate, jeu d'extensions intégrées, préréglages de prompt par famille de modèles, image de marque) sont ajustés aux besoins de Dori lorsqu'il exécute du travail de code.

Les modifications du code source principal sont réduites au minimum et suivies dans des fichiers [`changes.md`](#fork-strategy) au sein de chaque sous-répertoire modifié afin que les commits de fusion upstream restent faciles à relire.

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Runtime autonome de composition d'applications pour les services, l'état répliqué, le RPC et les plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Contrats de télémétrie indépendants des fournisseurs, adaptateur de référence, tests de conformité et schémas typés |
| **[@earendil-works/pi-ai](packages/ai)** | API LLM multi-fournisseurs unifiée (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Runtime d'agent avec appel d'outils et gestion d'état |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | CLI interactive d'agent de code |
| **[@earendil-works/pi-tui](packages/tui)** | Bibliothèque d'interface utilisateur de terminal avec rendu différentiel |

## Vous venez d'OMO ? Configuration d'extensions recommandée

Si vous migrez depuis [OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent), voici la correspondance pratique entre « ce que j'utilisais dans OMO » et « quoi installer dans senpi ». Une grande partie des fonctionnalités phares d'OMO est **déjà intégrée nativement dans senpi** (rien à installer) ; le reste se trouve dans les dépôts GitHub [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) et s'installe d'un simple `senpi install`.

> senpi est volontairement plus léger qu'OMO — un binaire CLI unique, pas un plugin opencode. Certains concepts d'OMO (Discipline Agents, Team Mode, Skills, Hashline, Ralph Loop, `/init-deep`) n'ont **pas d'équivalent direct dans senpi** et sont signalés au bas de cette section. Si vous en avez besoin, continuez à utiliser OMO.

### Déjà intégré dans senpi — rien à installer

| Fonctionnalité OMO | Intégré dans senpi |
|---|---|
| 🚪 **IntentGate** | [Prompt système dynamique](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) — chaque prompt commence par une vérification d'intention forcée avant l'utilisation d'outils. |
| ✅ **Todo Enforcer** | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) + boucle de continuation qui relance les agents inactifs. |
| **Ajustement par modèle** (« Model Setup ») | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) — préréglages pour GPT-5.x / Claude Opus 4.{5,6,7} / Kimi K2.6. |
| **Récupération de session / gestion du contexte** | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) — seuils adaptatifs, suivi de restauration, compaction d'urgence, troncature des résultats d'outils. |
| **Apply-patch sur les modèles GPT** | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) — `apply_patch` libre de style Codex avec grammaire Lark. |
| **Recherche web native** (Anthropic + OpenAI) | Extensions intégrées `anthropic-web-search` et `openai-web-search`. |
| **Discipline de délai d'expiration Bash** | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) — application du délai par défaut et maximal, politique dans le prompt système. |
| **Appariement d'outils sécurisé pour la compaction** | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) — supprime les blocs `tool_result` orphelins. |
| **Système de permissions** (autoriser/refuser de style opencode) | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) — règles, stockage JSONL, prompts TUI, motifs sensibles à l'analyseur. |

### Choisir les extensions pour votre configuration OMO

Les extensions intégrées de Senpi, les extensions autonomes `pi-*` et le
[plugin OMO Senpi](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-senpi/plugin)
se recoupent. N'installez pas chaque paquet autonome lorsque la fonctionnalité est déjà fournie par Senpi ou par le plugin.

| Fonctionnalité | Senpi sans le plugin OMO | Senpi avec le plugin OMO |
|---|---|---|
| LSP | Installez [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client). | Le plugin enregistre six outils LSP via son démon embarqué. N'installez `pi-lsp-client` que si vous avez spécifiquement besoin de son inspecteur `/lsp`. |
| AST-grep | Installez [`pi-ast-grep`](https://github.com/code-yeongyu/pi-ast-grep). | Le plugin inclut un skill AST-grep, un utilitaire et des scripts d'installation. `pi-ast-grep` reste facultatif si vous souhaitez les outils natifs `ast_grep_search` et `ast_grep_replace`. |
| Vérification des commentaires | Installez [`pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker). | Le plugin enregistre son propre composant de vérification des commentaires ; n'installez pas l'extension autonome en plus. |
| Règles et `AGENTS.md` imbriqués | Déjà fournis par les extensions intégrées `rules` et `nested-agents-md`. | Idem ; aucune extension autonome n'est requise. |
| Recherche et récupération web | Déjà fournies par les extensions intégrées `websearch` et `webfetch`. | Idem ; aucune extension autonome n'est requise. |
| Objectifs persistants | Déjà fournis par l'extension intégrée `goal`. | Idem ; aucune extension autonome n'est requise. |
| Profils de sous-agents | [`pi-agent-system`](https://github.com/code-yeongyu/pi-agent-system) prend en charge les lanceurs externes qui définissent `PI_AGENT_TYPE` ou `SANEPI_AGENT_TYPE`. | Le plugin gère le routage des tâches/membres et le filtrage des outils, `pi-agent-system` est donc normalement inutile. Ne le conservez que lorsqu'un autre lanceur repose sur son contrat de variables d'environnement. |

Pour Senpi en mode autonome sans le plugin OMO, n'installez que les fonctionnalités non intégrées dont vous avez besoin :

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

Consultez [Paquets Senpi](packages/coding-agent/README.md#pi-packages) pour le flux complet d'installation, de mise à jour et de suppression.

### Autoriser toutes les permissions (style OMO)

OMO s'exécute avec toutes les permissions d'outils pré-approuvées. Pour reproduire ce comportement dans senpi, ajoutez une règle d'autorisation générique à vos paramètres globaux :

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

Cela indique au système de permissions d'approuver automatiquement chaque appel d'outil sans demander de confirmation. La clé `"*"` correspond à tous les noms de permissions et `"allow"` les accorde sans condition. Vous pouvez également définir ce paramètre par projet en plaçant le même fichier `settings.json` dans `.senpi/settings.json` à la racine du projet.

> **Remarque :** Cela désactive tous les prompts de permission interactifs. Ne le faites que si vous faites confiance au modèle et à l'espace de travail dans lequel vous vous trouvez.

### Sans équivalent direct dans senpi

Ces éléments font partie de l'architecture du harness opencode d'OMO et ne sont volontairement **pas** présents dans senpi :

- **Discipline Agents** (Sisyphus / Hephaestus / Oracle / Librarian / Explore / Multimodal Looker) et le point d'entrée d'orchestration en un mot **`ultrawork` / `ulw`**.
- **Team Mode** — un responsable + jusqu'à 8 membres en parallèle, visualisation tmux, famille d'outils `team_*`, et les skills `hyperplan` / `security-research` par-dessus.
- **Hashline / outil d'édition ancré par hachage** — senpi conserve les outils standards `edit` / `multiedit` / `apply_patch` de pi. `pi-comment-checker` assure la validation post-édition pour laquelle OMO utilise Hashline, simplement sans les identifiants de hachage de contenu `LINE#ID`.
- **Système de skills** et **MCP intégrés aux skills** — les skills en tant que concept de premier ordre (`SKILL.md`, serveurs MCP dédiés par skill) n'existent pas dans senpi.
- **Planificateur en mode entretien Prometheus** et la boucle auto-référentielle **Ralph Loop / `/ulw-loop`**.
- **`/init-deep`** — il n'y a pas de générateur intégré au dépôt. Générez l'arborescence hiérarchique `AGENTS.md` manuellement (ou avec un prompt d'agent standard) ; l'extension intégrée `nested-agents-md` lira les fichiers obtenus.
- **Commande `doctor` intégrée**, **couche de compatibilité hook/commande/skill/plugin Claude Code** et le **routeur de catégories d'agents** (`visual-engineering` / `deep` / `quick` / `ultrabrain`).

## Vous en voulez plus ? Essayez l'écosystème pi-extensions

senpi intègre un ensemble fixe d'extensions natives et s'arrête là. Les dépôts GitHub [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) contiennent l'écosystème complet d'extensions : certains paquets sont directement inclus dans senpi comme extensions intégrées, tandis que les autres peuvent être installés en complément lorsque vous avez besoin de fonctionnalités supplémentaires telles que LSP ou AST-grep.

### Extensions installables

Ces paquets [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) sont conçus pour être installés en tant qu'extensions senpi/pi autonomes :

| Extension | Ce qu'elle ajoute |
|---|---|
| [`pi-anthropic-code-execution`](https://github.com/code-yeongyu/pi-anthropic-code-execution) | Exécution de code native Anthropic. |
| [`pi-anthropic-computer-use`](https://github.com/code-yeongyu/pi-anthropic-computer-use) | Bindings computer-use d'Anthropic. |
| [`pi-anthropic-text-editor`](https://github.com/code-yeongyu/pi-anthropic-text-editor) | Outil d'édition de texte natif Anthropic. |
| [`pi-anthropic-tool-search`](https://github.com/code-yeongyu/pi-anthropic-tool-search) | Recherche d'outils native Anthropic. |
| [`pi-anthropic-web-fetch`](https://github.com/code-yeongyu/pi-anthropic-web-fetch) | Prise en charge de la récupération web native Anthropic. |
| [`pi-ast-grep`](https://github.com/code-yeongyu/pi-ast-grep) | Recherche et remplacement de code basés sur l'AST dans 25 langages. Télécharge automatiquement `sg` à la première utilisation. |
| [`pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) | Vérifie la qualité des commentaires après l'exécution des outils d'édition de fichiers et affiche des avertissements dans la TUI. |
| [`pi-cua-integration`](https://github.com/code-yeongyu/pi-cua-integration) | Connexion des actions computer-use pour les interfaces d'interaction bureau et navigateur. |
| [`pi-google-code-execution`](https://github.com/code-yeongyu/pi-google-code-execution) | Exécution de code native Google. |
| [`pi-google-google-search`](https://github.com/code-yeongyu/pi-google-google-search) | Ancrage (grounding) avec Google Search. |
| [`pi-google-url-context`](https://github.com/code-yeongyu/pi-google-url-context) | Ancrage (grounding) d'URL Google. |
| [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client) | Intégration LSP : `lsp_rename`, `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`, ainsi qu'un inspecteur `/lsp`. |
| [`pi-openai-api-parallel-tool-calls`](https://github.com/code-yeongyu/pi-openai-api-parallel-tool-calls) | Prise en charge de la charge utile `parallel_tool_calls` d'OpenAI. |
| [`pi-openai-code-interpreter`](https://github.com/code-yeongyu/pi-openai-code-interpreter) | Code Interpreter d'OpenAI. |

Installez n'importe laquelle d'entre elles avec :

```bash
senpi install git:github.com/code-yeongyu/pi-ast-grep
senpi install git:github.com/code-yeongyu/pi-lsp-client
# ...substitute any of the package names from the table above.
```

Consultez [Paquets Senpi](packages/coding-agent/README.md#pi-packages) pour le processus d'installation, de mise à jour et de suppression.

### Paquets pi-extension déjà intégrés à senpi

Vous n'avez **pas** besoin d'installer ces paquets pour une utilisation normale de senpi ; leurs fonctionnalités sont déjà incluses dans le binaire. Ce tableau est volontairement limité aux paquets qui correspondent à la liste `builtinExtensions` actuellement enregistrée :

| Paquet | Inclus sous le nom | Fonctionnalité intégrée |
|---|---|---|
| [`pi-anthropic-bash`](https://github.com/code-yeongyu/pi-anthropic-bash) | `anthropic-bash` | Variante de l'outil bash native Anthropic. |
| [`pi-anthropic-web-search`](https://github.com/code-yeongyu/pi-anthropic-web-search) | `anthropic-web-search` | Prise en charge de la recherche web native Anthropic. |
| [`pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch) | `gpt-apply-patch` | Outil `apply_patch` de style Codex pour les exécutions de la famille GPT. |
| [`pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout) | `bash-timeout` | Délais d'expiration bash par défaut, application du délai maximal et politique de prompt. |
| [`pi-goal`](https://github.com/code-yeongyu/pi-goal) | `goal` | Suivi persistant des objectifs, statut dans la TUI et prompts de continuation. |
| [`pi-nested-agents-md`](https://github.com/code-yeongyu/pi-nested-agents-md) | `nested-agents-md` | Injecte automatiquement les fichiers `AGENTS.md` à proximité pour les répertoires imbriqués. |
| [`pi-openai-web-search`](https://github.com/code-yeongyu/pi-openai-web-search) | `openai-web-search` | Recherche web native d'OpenAI Responses. |
| [`pi-rules`](https://github.com/code-yeongyu/pi-rules) | `rules` | Détecte les fichiers de règles du projet et de l'utilisateur, y compris `AGENTS.md` et `CLAUDE.md`. |
| [`pi-todotools`](https://github.com/code-yeongyu/pi-todotools) | `todowrite` | `todowrite` / `todoread`, état de la barre latérale des tâches, directives de prompt pour le flux de travail et relances de continuation. |
| [`pi-webfetch`](https://github.com/code-yeongyu/pi-webfetch) | `webfetch` | Récupère le contenu d'une URL au format Markdown, texte ou HTML avec des limites de temps et de taille. |
| [`pi-websearch`](https://github.com/code-yeongyu/pi-websearch) | `websearch` | Recherche web adossée à un fournisseur avec activation contrôlée par configuration et résultats tenant compte des sources. |

D'autres extensions intégrées telles que `permission-system`, `prompt-preset`, `service-tier`, `tool-pair-guard`, `compaction`, `history-search` et `session-observer` sont des extensions propres à senpi sans paquets équivalents installables.

## Pourquoi "senpi"

`senpi` est un petit jeu de mots sur **senpai**, mais reflète aussi littéralement le positionnement du projet : ce fork se veut un pi plus **sain** (*sane*), avec des ajouts pratiques qui fluidifient le travail quotidien de l'agent sans abandonner la conception de base du projet upstream.

Tous les ajouts suivent la philosophie axée sur les extensions de pi. Les modifications du code source principal sont réduites au minimum et [documentées dans des fichiers `changes.md`](#fork-strategy) afin que les commits de merge upstream restent faciles à relire.

## Ce que ce fork ajoute

senpi hérite de l'architecture centrée sur les extensions de pi — le cœur reste minimal, chaque fonctionnalité arrive sous forme d'extension intégrée. Le pari est qu'un ensemble de fonctionnalités bien tranché est suffisamment demandé pour être inclus dans le binaire ; tout ce dont vous ne voulez pas peut être désactivé via une simple option de configuration (`disabledBuiltinExtensions` dans `settings.json`).

Vérifié par rapport à `git diff upstream/main..HEAD` et à chaque fichier `changes.md` du dépôt.

### Nouveaux sous-systèmes du cœur

| Sous-système | Ce qu'il fait | Docs |
|-----------|--------------|------|
| **Prompt système dynamique** | Remplace le prompt statique upstream par un générateur adaptatif : identité senpi → contrôle d'intention forcé → discipline d'exécution de tâche (vagues parallèles, arrêts d'exploration, engagement sur un plan unique) → niveaux de vérification → référence d'outils catégorisée → politiques → style → ajustement optionnel par modèle. | [`dynamic-prompt/`](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) · [`changes.md`](packages/coding-agent/src/core/dynamic-prompt/changes.md) |
| **Pipeline de compaction** | Seuils adaptatifs de style Plugsuit, protection contre les résumés vides, hooks de résumé de branche. La compaction spéculative et d'urgence avec suivi de restauration est implémentée dans l'[extension intégrée `compaction`](#owned-builtin-extensions). | [`core/compaction/`](packages/coding-agent/src/core/compaction/) · [`changes.md`](packages/coding-agent/src/core/compaction/changes.md) |
| **Réécriture du middleware d'appel d'outils** | Protocoles d'outils textuels XML / Hermes / YAML+XML / Gemma4 pour les modèles sans appel de fonction natif. Analyse stricte, préservation des erreurs de flux. | [`tool-call-middleware/`](packages/ai/src/tool-call-middleware/AGENTS.md) · [`changes.md`](packages/ai/src/tool-call-middleware/changes.md) |

<a id="owned-builtin-extensions"></a>

### Extensions intégrées internes

Incluses dans l'arborescence, étroitement couplées au fonctionnement interne de senpi. Chargées dans cet ordre exact d'enregistrement :

| # | Extension | Rôle | Docs |
|---|-----------|------|------|
| 1 | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) | Portage complet des permissions façon opencode — règles, stockage JSONL, prompts TUI, motifs sensibles à la syntaxe (arité bash, globs de fichiers, chemins dans le corps `apply_patch`), repli non interactif | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/permission-system/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/permission-system/changes.md) |
| 2 | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) *(vendorisé)* | Lorsque le modèle actif est OpenAI GPT, remplace `write`/`edit` par un `apply_patch` libre façon Codex avec une grammaire Lark. Synchronisé depuis [`code-yeongyu/pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch). | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/AGENTS.md) |
| 3 | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) | Préréglages de prompt système par modèle (gpt-5.x, claude-opus-4-{5,6,7}, kimi-k2-6) superposés au prompt dynamique. Ajustement partagé des opérations sur les fichiers façon codex. | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/changes.md) |
| 4 | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) *(vendorisé)* | Outils `todowrite` / `todoread` avec persistance par branche, widget de barre latérale, conseils de prompt pour le workflow et boucle de continuation. Synchronisé depuis [`code-yeongyu/pi-todotools`](https://github.com/code-yeongyu/pi-todotools). | — |
| 5 | [`redraws`](packages/coding-agent/src/core/extensions/builtin/redraws.ts) | Commande `/tui` indiquant le nombre cumulé de rafraîchissements complets de la TUI. Utilisée pour le débogage du rendu différentiel. | — |
| 6 | [`anthropic-web-search`](packages/coding-agent/src/core/extensions/builtin/anthropic-web-search/) | Outil `web_search` natif d'Anthropic | — |
| 7 | [`anthropic-bash`](packages/coding-agent/src/core/extensions/builtin/anthropic-bash/) | Variante native de l'outil bash d'Anthropic | — |
| 8 | [`openai-web-search`](packages/coding-agent/src/core/extensions/builtin/openai-web-search/) | `web_search` natif d'OpenAI Responses | — |
| 9 | [`service-tier`](packages/coding-agent/src/core/extensions/builtin/service-tier.ts) | Injecte `service_tier` (`auto` / `flex` / `priority`) dans les charges utiles OpenAI Responses selon le niveau de service du modèle ou le paramètre `openai.serviceTier` | — |
| 10 | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) *(vendorisé)* | Injecte les délais d'expiration bash par défaut et maximum, ajoute la politique au prompt système. Synchronisé depuis [`code-yeongyu/pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout). | — |
| 11 | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) | Nettoie les charges utiles des requêtes Anthropic en supprimant les blocs `tool_result` orphelins — sécurité lors de la compaction | — |
| 12 | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) | Politique de compaction spéculative et d'urgence : moniteur de dégradation, disjoncteur, limite par tour, pont de tâches (todo), état de point de contrôle, suivi de restauration, troncature des résultats d'outils | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/compaction/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/compaction/changes.md) |
| 13 | [`history-search`](packages/coding-agent/src/core/extensions/builtin/history-search/) | Commande `/history` — recherche dans l'historique des prompts à travers les sessions dans une fenêtre superposée | — |
| 14 | [`websearch`](packages/coding-agent/src/core/extensions/builtin/websearch/) | Outil `web_search` adossé à un fournisseur avec activation contrôlée par configuration, statut TUI et résultats incluant les sources | — |
| 15 | [`webfetch`](packages/coding-agent/src/core/extensions/builtin/webfetch/) | Outil `webfetch` pour récupérer le contenu d'une URL en markdown, texte ou HTML avec des limites de temps et de taille | — |
| 16 | [`nested-agents-md`](packages/coding-agent/src/core/extensions/builtin/nested-agents-md/) | Injecte automatiquement les fichiers `AGENTS.md` proches lorsque l'agent lit dans des répertoires imbriqués | — |
| 17 | [`rules`](packages/coding-agent/src/core/extensions/builtin/rules/) | Découvre automatiquement les fichiers de règles du projet et expose les commandes `/rules` / `/reload-rules` | — |
| 18 | [`goal`](packages/coding-agent/src/core/extensions/builtin/goal/) | Outils de suivi d'objectifs persistants, état dans le pied de page et prompts de continuation | — |

> Les répertoires d'extensions intégrées ci-dessus sont nouveaux par rapport à `pi-mono` upstream — aucun n'existe dans `badlogic/pi-mono`. Les versions vendorisées sont épinglées dans [`external-versions.json`](packages/coding-agent/src/core/extensions/builtin/external-versions.json) et synchronisées depuis le dépôt frère `pi-extensions` avec [`sync-builtin-extensions.mjs`](packages/coding-agent/scripts/sync-builtin-extensions.mjs).

### Dépôts d'extensions autonomes

Ces extensions sont maintenues dans des dépôts publics `code-yeongyu/pi-*` et peuvent être installées via `packages` dans `settings.json` ou avec `senpi install git:github.com/code-yeongyu/<repo>`.

| Extension | Dépôt | Ce qu'elle fait |
|-----------|------------|--------------|
| `pi-comment-checker` | [`code-yeongyu/pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) | Exécute `@code-yeongyu/comment-checker` après `write`, `edit`, `multiedit` et `apply_patch`, avec prise en charge des métadonnées `apply_patch` compatibles OMO et repli sur les patchs bruts Codex ; affiche les avertissements dans un widget au-dessus de l'éditeur |

### Extensions globales par défaut

Non chargées comme extensions intégrées ; écrites une seule fois dans `~/.senpi/agent/extensions/` au premier lancement afin que vous puissiez les modifier ou les supprimer localement.

| Extension | Source | Ce qu'elle fait |
|-----------|--------|--------------|
| `diff` | [`diff.ts`](packages/coding-agent/src/core/extensions/builtin/diff.ts) | Commande `/diff` — sélectionne les fichiers modifiés / supprimés / nouveaux depuis `git status` et ouvre la vue diff de VS Code |
| `files` | [`files.ts`](packages/coding-agent/src/core/extensions/builtin/files.ts) | Commande `/files` — liste les fichiers lus / écrits / modifiés dans la branche de session actuelle et ouvre la sélection dans VS Code |
| `prompt-url-widget` | [`prompt-url-widget.ts`](packages/coding-agent/src/core/extensions/builtin/prompt-url-widget.ts) | Détecte les URL de PR / issues GitHub dans les prompts, récupère le titre via `gh` et définit automatiquement le nom de la session |
| `tps` | [`tps.ts`](packages/coding-agent/src/core/extensions/builtin/tps.ts) | Notification du nombre de tokens par seconde (entrée / sortie / lecture-écriture du cache / total / temps écoulé) après chaque tour de l'agent |

### Paquets upstream modifiés

| Paquet | Modifications | Référence |
|---------|--------------|-----------|
| [`packages/ai`](packages/ai/AGENTS.md) | `originator` et User-Agent Codex aux couleurs de senpi, utilitaire partagé de réparation des paires d'outils, prise en charge des outils personnalisés/libres OpenAI Responses pour `apply_patch`, Claude Opus 4.7 + niveau de réflexion `"max"`, transmission de `extraBody` à tous les fournisseurs, [réécriture du middleware d'appel d'outils](packages/ai/src/tool-call-middleware/AGENTS.md) | [`ai/src/changes.md`](packages/ai/src/changes.md) |
| [`packages/agent`](packages/agent/AGENTS.md) | Émission parallèle des fins d'exécution d'outils (finalisation concurrente, résultats dans l'ordre source), UUIDv7 intégré remplaçant la dépendance `uuid`, diagnostics de harness compatibles ES2021 | [`agent/src/changes.md`](packages/agent/src/changes.md) |
| [`packages/tui`](packages/tui/AGENTS.md) | Optimisation du rendu différentiel : chemin rapide pour le défilement à l'insertion, correctif de rafraîchissement lors du remappage du viewport, tests de régression de scintillement (aucun effacement complet après l'initialisation, DECSET 2026 équilibré) | [`tui/src/changes.md`](packages/tui/src/changes.md) |
| [`packages/coding-agent`](packages/coding-agent/AGENTS.md) | Image de marque `senpi`, contrôles de configuration des modèles (`upstreamModelId`, `serviceTier`, modèles favoris, désactivation/liste blanche/liste noire), découverte non bloquante des outils au démarrage, vérification des mises à jour au démarrage désactivée, [remplacement de `promptSnippet` bash par `rg`](packages/coding-agent/src/core/tools/AGENTS.md), chemin rapide pour les extensions par défaut générées, identité sortante `senpi` | Plusieurs fichiers [`changes.md`](packages/coding-agent/src/) |

### Autres changements d'identité et d'exécution

| Changement | Détails |
|--------|---------|
| **Identité CLI `senpi`** | L'agent de code s'identifie comme `senpi`, utilise `.senpi/agent` pour stocker la configuration et est publié sur npm sous le nom `@code-yeongyu/senpi`. L'exécutable installé reste `senpi`. |
| **Identité sortante `senpi`** | Chaque requête sortante émet `senpi` au lieu de `pi` : `User-Agent` (vérification de mise à jour + Cloudflare + releases GitHub), `X-OpenRouter-Title`, `originator` + User-Agent OpenAI Codex. |
| **Aucune vérification de mise à jour au démarrage** | Suppression de la vérification de version sur le registre npm et des prompts de mise à jour de paquets au lancement. |
| **Regroupement UI des extensions intégrées** | Les extensions intégrées s'affichent sous un groupe `builtin/` dans l'en-tête de démarrage, visuellement distinct des extensions utilisateur et projet. |
| **Registre de modèles mis à jour** | `models.generated.ts` actualisé avec les derniers ajouts et dépréciations de modèles. |
| **Cible d'auto-mise à jour** | `senpi update senpi` interroge les releases de [`code-yeongyu/senpi`](https://github.com/code-yeongyu/senpi), et non celles d'upstream. |

<a id="fork-strategy"></a>

## Stratégie de fork

Ce fork est rebasé périodiquement sur `upstream/main`. Pour réduire les conflits de fusion :

1. **Priorité aux extensions** : toutes les fonctionnalités utilisent le [système d'extensions](packages/coding-agent/docs/extensions.md) de pi sous forme d'extensions intégrées.
2. **Documenter les modifications principales** : chaque modification d'un fichier upstream possède un fichier `changes.md` correspondant dans le sous-répertoire concerné, qui documente ce qui a changé, pourquoi, et les zones de conflit attendues.
3. **Dépôts distants** : `origin` = [code-yeongyu/senpi](https://github.com/code-yeongyu/senpi), `upstream` = [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

Fichiers upstream modifiés (impact élevé, voir les fichiers `changes.md` par répertoire pour le reste) :

| Fichier | Modification |
|------|--------|
| `agent-session.ts` | Appelle `buildDynamicSystemPrompt()` au lieu de `buildSystemPrompt()` ; pipeline de compaction unifié ; mise à jour du prompt système au changement de modèle |
| `resource-loader.ts` | Suppression de la découverte de SYSTEM.md / APPEND_SYSTEM.md ; ajout du chargement des extensions intégrées ; chemin rapide pour les extensions par défaut générées |
| `interactive-mode.ts` | Formatage de l'affichage des extensions intégrées ; désactivation de la vérification des mises à jour ; outils de démarrage non bloquants ; rotation des modèles favoris |
| `model-registry.ts` | `upstreamModelId` et `serviceTier` personnalisés ; désactivation / liste blanche / liste noire par fournisseur ou modèle ; `thinkingLevelMapMode` |
| `settings-manager.ts` | `disabledBuiltinExtensions` ; `favoriteModels` ; `openai.serviceTier` ; pilotage (steering) par défaut sur `"all"` |
| `agent-loop.ts` (`packages/agent`) | `executeToolCallsParallel()` |
| `tui.ts` (`packages/tui`) | Chemins rapides de rendu différentiel + respect du budget de scintillement |
| `package.json` | Renommage du paquet de l'agent de code et de l'identité d'exécution en `senpi` |

## Partagez vos sessions d'agent de code OSS

Si vous utilisez pi ou d'autres agents de code pour vos travaux open source, merci de partager vos sessions.

Les données publiques de sessions OSS aident à améliorer les agents de code grâce à des tâches réelles, à l'utilisation d'outils, à des erreurs et à des correctifs, plutôt qu'avec des benchmarks artificiels.

Pour l'explication complète, consultez [ce post sur X](https://x.com/badlogicgames/status/2037811643774652911).

Pour publier des sessions, utilisez [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Consultez son README.md pour les instructions de configuration. Vous avez simplement besoin d'un compte Hugging Face, de la CLI Hugging Face et de `pi-share-hf`.

Vous pouvez aussi regarder [cette vidéo](https://x.com/badlogicgames/status/2041151967695634619), où je montre comment je publie mes sessions `pi-mono`.

Je publie régulièrement mes propres sessions de travail `pi-mono` ici :

- [badlogicgames/pi-mono sur Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## Tous les paquets

| Paquet | Description |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | API LLM multi-fournisseur unifiée avec streaming de texte, appel d'outils, utilitaires OAuth et génération d'images |
| **[@earendil-works/pi-agent-core](packages/agent)** | Runtime d'agent avec appel d'outils et gestion d'état |
| **[senpi](packages/coding-agent)** | CLI d'agent de code interactif, renommé senpi |
| **[@code-yeongyu/senpi-codemode](packages/senpi-codemode)** | Paquet d'extension codemode (code source uniquement) avec briques de base pour les paramètres, le noyau, le pont et le prélude |
| **[@earendil-works/pi-tui](packages/tui)** | Bibliothèque d'interface utilisateur de terminal avec rendu différentiel |

Pour l'automatisation et les workflows Slack/chat, consultez [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions et conteneurisation

senpi n'inclut pas d'isolation par conteneur intégrée pour restreindre l'accès au système de fichiers, aux processus, au réseau ou aux identifiants. Par défaut, il s'exécute avec les permissions de l'utilisateur et du processus qui l'ont lancé.

Si vous avez besoin d'une isolation plus stricte, conteneurisez senpi. Consultez [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) pour découvrir trois approches :

- **OpenShell** : exécuter l'ensemble du processus `senpi` dans un conteneur contrôlé par des stratégies.
- **Extension Gondolin** : conserver `senpi` et l'authentification des fournisseurs sur l'hôte tout en acheminant les outils intégrés et les commandes `!` vers une micro-VM Linux locale.
- **Docker standard** : exécuter l'ensemble du processus `senpi` dans un conteneur local pour une isolation simple.

## Contribuer

Consultez [CONTRIBUTING.md](CONTRIBUTING.md) pour les directives de contribution et [AGENTS.md](AGENTS.md) pour les règles spécifiques au projet (pour les humains comme pour les agents).

## Développement

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
bun install --ignore-scripts # Bun alternative
bun run build        # Build all packages
bun run check        # Lint, format, and type check
bun run test             # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Live-API integration suite (env-gated; requires API keys)
bun run publish      # Publish npm workspaces, including @code-yeongyu/senpi
```

## Durcissement de la chaîne d'approvisionnement

Nous traitons les modifications de dépendances npm comme des modifications de code soumises à revue.

- Les dépendances externes directes sont figées sur des versions exactes. Les paquets internes de l'espace de travail conservent des plages de versions.
- `.npmrc` définit `save-exact=true` et `min-release-age=2` pour éviter les versions de dépendances publiées le jour même lors de la résolution npm.
- `package-lock.json` est la source de vérité pour les dépendances. Le pre-commit bloque les commits accidentels du fichier de verrouillage, sauf si `PI_ALLOW_LOCKFILE_CHANGE=1` est défini.
- `bun run check` vérifie les dépendances directes figées, la compatibilité native des imports TypeScript et le verrou d'installation généré pour l'agent de code.
- Le manifeste `@code-yeongyu/senpi` publié constitue la liste source des dépendances : les espaces de travail du fork sont résolus via leurs alias `@code-yeongyu/senpi-*` publiés, et seul le code client/protocole embarqué est livré dans l'archive tarball. Aucun fichier `npm-shrinkwrap.json` n'est publié.
- Les smoke tests de publication utilisent `bun run release:local` pour compiler, empaqueter et créer des installations npm et Bun isolées en dehors du dépôt avant de taguer une version.
- Les installations de versions locales, les installations npm documentées et `senpi update senpi` utilisent `--ignore-scripts` lorsque c'est pris en charge.
- La CI effectue l'installation avec `npm ci --ignore-scripts`, et un workflow GitHub planifié exécute `npm audit --omit=dev` ainsi que `npm audit signatures --omit=dev`. Ces mécanismes internes à npm sont inventoriés en vue d'une migration ultérieure.
- La génération du verrou d'installation dispose d'une liste d'autorisation explicite pour les scripts de cycle de vie des dépendances ; les nouvelles dépendances avec scripts de cycle de vie font échouer les vérifications jusqu'à ce qu'elles soient passées en revue.

## Contribuer

Consultez [CONTRIBUTING.md](CONTRIBUTING.md) pour les directives de contribution et [AGENTS.md](AGENTS.md) pour les règles spécifiques au projet (pour les humains comme pour les agents).

## Licence

MIT

## Ganbare Ganbare Senpi

> *Hora, senpi senpi, senpi te kudasai!*
> *Ganbare ganbare senpi, gan ganbare ganbare senpi ora!*

Une toute petite déclaration d'amour pas sérieuse du tout au mème [Ganbare Ganbare Senpai](https://en.wikipedia.org/wiki/Don%27t_Toy_with_Me,_Miss_Nagatoro) auquel le nom du projet rend secrètement hommage. À chaque fois que le rebase est propre et que les tests sont au vert, quelque part une kouhai murmure :

- **Allez senpi, allez !** Envoie la PR.
- **Remarque-moi, senpi.** ...les diagnostics ont remarqué en premier.
- **Fais plus d'efforts, senpi !** *(elle a bien regardé. et le build est bien passé.)*
- **Tu peux le faire, senpi !** Encore un agent, encore un outil, encore un rebase propre.
- **Ganbare, ganbare, senpi! 頑張れ頑張れ先輩!** *Fais de ton mieux, fais de ton mieux, senpai !*

Oui, tout le nom du projet est un jeu de mots sur senpai. Typez strictement, lancez les tests, rédigez un `changes.md`, gardez une surface de merge minuscule — et *gan ganbare ganbare senpi ora!*

Mention spéciale à [plugsuits](https://github.com/minpeter/pss-runtime) : le système de compaction de senpi s'inspire de sa conception.
