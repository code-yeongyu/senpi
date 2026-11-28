[English](README.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-br.md) | [Italiano](README.it.md) | [Türkçe](README.tr.md)

# senpi


<p align="center">
  <a href="https://discord.gg/PUwSMR9XNk"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/code-yeongyu/senpi/actions/workflows/ci.yml"><img alt="Build durumu" src="https://img.shields.io/github/actions/workflow/status/code-yeongyu/senpi/ci.yml?style=flat-square&branch=main" /></a>
</p>

> ⚠️ **Deneysel.** senpi, [badlogic/pi-mono](https://github.com/badlogic/pi-mono) projesinin görüş sahibi ve aktif olarak geliştirilen bir çatalıdır (fork). Arka planda [Dori](https://sisyphuslabs.ai)'ye güç verir ve belirli bir yapay zeka asistanının bir kodlama ajanı çalışma zamanından (runtime) neye ihtiyaç duyduğunu yansıtır. Kullanın; ancak bir üretim hattını (production pipeline) buna bağlamayın.

senpi, senpai kelimesine bir kelime oyunu ve ekstra pillerle (özelliklerle) birlikte gelen daha **makul (sane)** bir pi'dir — pi-mono'nun kodlama ajanını `senpi` olarak yeniden adlandıran ve upstream üzerine seçilmiş bir yerleşik eklenti (builtin extension) seti ile çekirdek iyileştirmeler sunan bir TypeScript monorepo'sudur.

> **Upstream**: [@mariozechner](https://github.com/badlogic) tarafından [pi-mono](https://github.com/badlogic/pi-mono) — yapay zeka ajanları oluşturmak ve LLM dağıtımlarını yönetmek için araçlar.

## OMO'dan ilham aldı, Dori'nin kodlama ajanı çalışma zamanı olarak geliştirildi

senpi iki kaynaktan ilham alarak doğdu:

- **[OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent)'dan güçlü etki.** OMO; disiplin ajanları (Sisyphus, Hephaestus, Prometheus), [IntentGate](https://factory.ai/news/terminal-bench), hash sabitli düzenlemeler, Team Mode, skill içine gömülü MCP'ler, Ralph Loop, todo zorlayıcıları (todo enforcers) ve çok daha fazlasını içeren ağır siklet bir opencode altyapısıdır. senpi, OMO'nun öne çıkan fikirlerinin çoğunu (intent gate, dinamik istem, model başına ön ayarlar, paralel araç yönlendirme, todo devamlılığı) yeniden kullanır ancak upstream pi-mono'ya yakın kalabilmek için **yüzeyi olabildiğince hafif tutar**. senpi'yi, bir opencode eklentisi yerine tek bir pi CLI ikili dosyası (binary) olarak çalışan **OMO'nun hafif bir sürümü** gibi düşünebilirsiniz.
- **senpi, [Dori](https://sisyphuslabs.ai) için kodlama ajanı çalışma zamanıdır.** Dori, Sisyphus Labs'ın yapay zeka asistanıdır — bağlam için [OMO'nun README'sindeki Dori bölümüne](https://github.com/code-yeongyu/oh-my-openagent#oh-my-openagent) göz atın. senpi tek başına da kullanılabilir, ancak tasarım kararları (intent gate ifadeleri, yerleşik eklenti seti, model ailesine göre istem ön ayarları, marka kimliği) Dori'nin kod işlerini yürütürken ihtiyaç duyduklarına göre ayarlanmıştır.

Çekirdek kaynak kod değişiklikleri en aza indirilmiştir ve upstream birleştirme (merge) commit'lerinin incelenebilir kalması için değiştirilen her alt dizinin yanında [`changes.md`](#fork-strategy) dosyalarında takip edilmektedir.

| Paket | Açıklama |
|-------|----------|
| **[@earendil-works/chord](packages/chord)** | Servisler, çoğaltılmış durum (replicated state), RPC ve eklentiler için bağımsız uygulama bileşimi çalışma zamanı |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Sağlayıcıdan bağımsız telemetri sözleşmeleri, referans bağdaştırıcı, uyumluluk testleri ve tipli şemalar |
| **[@earendil-works/pi-ai](packages/ai)** | Birleşik çoklu sağlayıcı LLM API'si (OpenAI, Anthropic, Google vb.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Araç çağırma ve durum yönetimine sahip ajan çalışma zamanı |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Etkileşimli kodlama ajanı CLI'ı |
| **[@earendil-works/pi-tui](packages/tui)** | Diferansiyel işlemeye (differential rendering) sahip terminal arayüz kütüphanesi |

## OMO'dan mı geliyorsunuz? Önerilen eklenti kurulumu

[OMO (oh-my-openagent)](https://github.com/code-yeongyu/oh-my-openagent)'dan geçiş yapıyorsanız, "OMO'da ne kullanıyordum" ile "senpi'de ne kurmalıyım" arasındaki pratik eşleşmeyi burada bulabilirsiniz. OMO'nun öne çıkan özelliklerinin çoğu **senpi'ye yerleşik (builtin) olarak zaten bağlanmıştır** (kurulum gerekmez); geri kalanı [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) GitHub depolarında yer alır ve tek bir `senpi install` komutu uzağınızdadır.

> senpi bilinçli olarak OMO'dan daha hafiftir — bir opencode eklentisi değil, tek bir CLI ikili dosyasıdır. Bazı OMO kavramlarının (Discipline Agents, Team Mode, Skills, Hashline, Ralph Loop, `/init-deep`) **senpi'de birebir karşılığı yoktur** ve bu bölümün sonunda belirtilmiştir. Bunlara ihtiyacınız varsa OMO'yu kullanmaya devam edin.

### senpi'de zaten yerleşik — kurulum gerekmez

| OMO özelliği | senpi yerleşiği |
|---|---|
| 🚪 **IntentGate** | [Dinamik sistem istemi](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) — her istem, araç kullanımından önce zorunlu bir niyet kapısı (intent gate) ile açılır. |
| ✅ **Todo Enforcer** | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) + boşta kalan ajanları yeniden devreye sokan devamlılık döngüsü. |
| **Model başına ince ayar** ("Model Setup") | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) — GPT-5.x / Claude Opus 4.{5,6,7} / Kimi K2.6 ön ayarları. |
| **Oturum kurtarma / bağlam yönetimi** | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) — uyarlanabilir eşikler, geri yükleme izleyicisi, acil durum sıkıştırması, araç sonucu kırpma. |
| **GPT modellerinde apply-patch** | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) — Lark dilbilgisi ile Codex tarzı serbest biçimli `apply_patch`. |
| **Yerel web araması** (Anthropic + OpenAI) | `anthropic-web-search`, `openai-web-search` yerleşik eklentileri. |
| **Bash zaman aşımı disiplini** | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) — varsayılan + maksimum zaman aşımı zorlaması, sistem isteminde politika. |
| **Sıkıştırma güvenli araç eşleştirme** | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) — sahipsiz (orphan) `tool_result` bloklarını temizler. |
| **İzin sistemi** (opencode tarzı allow/deny) | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) — kurallar, JSONL depolama, TUI istemleri, ayrıştırıcıya duyarlı kalıplar. |

### OMO kurulumunuz için eklentileri seçin

Senpi yerleşik eklentileri, bağımsız `pi-*` eklentileri ve
[OMO Senpi eklentisi](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-senpi/plugin)
birbiriyle örtüşür. Özellik zaten Senpi veya eklenti tarafından sağlanıyorsa tüm bağımsız paketleri kurmayın.

| Yetenek | OMO eklentisi olmadan Senpi | OMO eklentisi ile Senpi |
|---|---|---|
| LSP | [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client) kurun. | Eklenti, paketlenmiş arka plan hizmeti üzerinden altı LSP aracı kaydeder. `pi-lsp-client`'ı yalnızca özellikle `/lsp` denetçisine ihtiyacınız varsa kurun. |
| AST-grep | [`pi-ast-grep`](https://github.com/code-yeongyu/pi-ast-grep) kurun. | Eklenti bir AST-grep becerisi, yardımcısı ve kurulum betikleriyle gelir. Yerel `ast_grep_search` ve `ast_grep_replace` araçlarını istediğinizde `pi-ast-grep` isteğe bağlı olarak kalır. |
| Yorum denetimi | [`pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) kurun. | Eklenti kendi comment-checker bileşenini kaydeder; bağımsız eklentiyi ayrıca kurmayın. |
| Kurallar ve iç içe `AGENTS.md` | `rules` ve `nested-agents-md` yerleşikleri tarafından zaten sağlanır. | Aynı; bağımsız eklenti gerekmez. |
| Web arama ve getirme | `websearch` ve `webfetch` yerleşikleri tarafından zaten sağlanır. | Aynı; bağımsız eklenti gerekmez. |
| Kalıcı hedefler | `goal` yerleşiği tarafından zaten sağlanır. | Aynı; bağımsız eklenti gerekmez. |
| Alt ajan profilleri | [`pi-agent-system`](https://github.com/code-yeongyu/pi-agent-system), `PI_AGENT_TYPE` veya `SANEPI_AGENT_TYPE` ayarlayan harici başlatıcıları destekler. | Eklenti görev/üye yönlendirmesini ve araç filtrelemeyi yönetir, bu nedenle `pi-agent-system` normalde gereksizdir. Yalnızca başka bir başlatıcı ortam değişkeni sözleşmesine dayanıyorsa tutun. |

OMO eklentisi olmadan bağımsız Senpi için yalnızca ihtiyacınız olan yerleşik olmayan yetenekleri kurun:

```bash
senpi install git:github.com/code-yeongyu/pi-lsp-client            # 🛠️  LSP: rename / goto / refs / diagnostics + /lsp denetçisi
senpi install git:github.com/code-yeongyu/pi-ast-grep              # 🛠️  25 dilde AST-Grep (sg'yi otomatik indirir)
senpi install git:github.com/code-yeongyu/pi-comment-checker       # 💬  Comment Checker — OMO kancasının bağımsız pi portu

# İsteğe bağlı — yalnızca eşleşen OMO yüzeyini kullandıysanız:
senpi install git:github.com/code-yeongyu/pi-cua-integration                 # 🖥️  Bilgisayar kullanımı bağlamaları (masaüstü / tarayıcı)
senpi install git:github.com/code-yeongyu/pi-anthropic-computer-use          #     Claude yerel bilgisayar kullanımı
senpi install git:github.com/code-yeongyu/pi-anthropic-code-execution        #     Claude yerel kod çalıştırma
senpi install git:github.com/code-yeongyu/pi-google-code-execution           #     Google yerel kod çalıştırma
senpi install git:github.com/code-yeongyu/pi-openai-code-interpreter         #     OpenAI Code Interpreter
senpi install git:github.com/code-yeongyu/pi-anthropic-text-editor           #     Claude yerel metin düzenleyici aracı
senpi install git:github.com/code-yeongyu/pi-anthropic-tool-search           #     Claude yerel araç arama
senpi install git:github.com/code-yeongyu/pi-anthropic-web-fetch             #     Claude yerel web getirme
senpi install git:github.com/code-yeongyu/pi-google-google-search            #     Google Search temellendirme (grounding)
senpi install git:github.com/code-yeongyu/pi-google-url-context              #     Google URL temellendirme (grounding)
senpi install git:github.com/code-yeongyu/pi-openai-api-parallel-tool-calls  #     OpenAI parallel_tool_calls yük desteği
```

Tam kurulum / güncelleme / kaldırma akışı için [Senpi Paketleri](packages/coding-agent/README.md#pi-packages) bölümüne bakın.

### Tüm izinlere izin ver (OMO tarzı)

OMO tüm araç izinleri önceden onaylanmış şekilde çalışır. Bu davranışı senpi'de yinelemek için genel ayarlarınıza bir joker (wildcard) izin kuralı ekleyin:

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

Bu, izin sistemine her araç çağrısını sormadan otomatik olarak onaylamasını söyler. `"*"` anahtarı tüm izin adlarıyla eşleşir ve `"allow"` bunları koşulsuz olarak verir. Aynı `settings.json` dosyasını proje kök dizinindeki `.senpi/settings.json` konumuna yerleştirerek bunu proje bazında da ayarlayabilirsiniz.

> **Not:** Bu, tüm etkileşimli izin istemlerini devre dışı bırakır. Bunu yalnızca çalıştırdığınız modele ve çalışma alanına güveniyorsanız yapın.

### Doğrudan senpi karşılığı olmayanlar

Bunlar OMO'nun opencode altyapı yapısının bir parçasıdır ve bilinçli olarak senpi'de **bulunmaz**:

- **Discipline Agents** (Sisyphus / Hephaestus / Oracle / Librarian / Explore / Multimodal Looker) ve tek kelimelik **`ultrawork` / `ulw`** orkestrasyon giriş noktası.
- **Team Mode** — lider + en fazla 8 paralel üye, tmux görselleştirme, `team_*` araç ailesi, bunun üzerinde çalışan `hyperplan` / `security-research` becerileri.
- **Hashline / hash sabitli düzenleme aracı** — senpi, pi'nin standart `edit` / `multiedit` / `apply_patch` araçlarıyla kalır. `pi-comment-checker`, OMO'nun Hashline'ı kullandığı düzenleme sonrası doğrulama yerini doldurur, sadece `LINE#ID` içerik-hash tanımlayıcıları olmadan.
- **Skill sistemi** ve **skill içine gömülü MCP'ler** — birinci sınıf bir kavram olarak beceriler (`SKILL.md`, beceri başına kapsamlı MCP sunucuları) senpi'de mevcut değildir.
- **Prometheus görüşme modu planlayıcısı** ve kendi kendine referans veren **Ralph Loop / `/ulw-loop`** döngüsü.
- **`/init-deep`** — ağaç içi bir oluşturucu yoktur. Hiyerarşik `AGENTS.md` ağacını manuel olarak (veya normal bir ajan istemiyle) oluşturun; yerleşik `nested-agents-md` eklentisi oluşan dosyaları okuyacaktır.
- **Yerleşik `doctor` komutu**, **Claude Code kanca/komut/beceri/eklenti uyumluluk katmanı** ve **ajan kategori yönlendiricisi** (`visual-engineering` / `deep` / `quick` / `ultrabrain`).

## Daha fazlasını mı istiyorsunuz? pi-extensions ekosistemini deneyin

senpi sabit bir yerleşik eklenti seti sunar ve orada durur. [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) GitHub depoları tam eklenti ekosistemini barındırır: bazı paketler yerleşik olarak senpi'ye dahil edilmiştir (vendored), geri kalanı ise LSP veya AST-grep gibi ekstra yetenekler istediğinizde üzerine kurulabilir.

### Kurulabilir eklentiler

Bu [`code-yeongyu/pi-*`](https://github.com/code-yeongyu?tab=repositories&q=pi-) paketleri bağımsız senpi/pi eklentileri olarak kurulmak üzere tasarlanmıştır:

| Eklenti | Ne ekler |
|---|---|
| [`pi-anthropic-code-execution`](https://github.com/code-yeongyu/pi-anthropic-code-execution) | Anthropic yerel kod çalıştırma. |
| [`pi-anthropic-computer-use`](https://github.com/code-yeongyu/pi-anthropic-computer-use) | Anthropic bilgisayar kullanımı bağlamaları. |
| [`pi-anthropic-text-editor`](https://github.com/code-yeongyu/pi-anthropic-text-editor) | Anthropic yerel metin düzenleyici aracı. |
| [`pi-anthropic-tool-search`](https://github.com/code-yeongyu/pi-anthropic-tool-search) | Anthropic yerel araç arama. |
| [`pi-anthropic-web-fetch`](https://github.com/code-yeongyu/pi-anthropic-web-fetch) | Anthropic yerel web getirme desteği. |
| [`pi-ast-grep`](https://github.com/code-yeongyu/pi-ast-grep) | 25 dilde AST duyarlı kod arama/değiştirme. İlk kullanımda `sg`'yi otomatik indirir. |
| [`pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) | Dosya düzenleme araçlarından sonra yorum kalitesi kontrolleri çalıştırır ve TUI'da uyarılar gösterir. |
| [`pi-cua-integration`](https://github.com/code-yeongyu/pi-cua-integration) | Masaüstü/tarayıcı etkileşim yüzeyleri için bilgisayar kullanımı eylem bağlantıları. |
| [`pi-google-code-execution`](https://github.com/code-yeongyu/pi-google-code-execution) | Google yerel kod çalıştırma. |
| [`pi-google-google-search`](https://github.com/code-yeongyu/pi-google-google-search) | Google Search temellendirme. |
| [`pi-google-url-context`](https://github.com/code-yeongyu/pi-google-url-context) | Google URL temellendirme. |
| [`pi-lsp-client`](https://github.com/code-yeongyu/pi-lsp-client) | LSP entegrasyonu: `lsp_rename`, `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics` ve bir `/lsp` denetçisi. |
| [`pi-openai-api-parallel-tool-calls`](https://github.com/code-yeongyu/pi-openai-api-parallel-tool-calls) | OpenAI `parallel_tool_calls` yük desteği. |
| [`pi-openai-code-interpreter`](https://github.com/code-yeongyu/pi-openai-code-interpreter) | OpenAI Code Interpreter. |

Bunlardan herhangi birini şu şekilde kurun:

```bash
senpi install git:github.com/code-yeongyu/pi-ast-grep
senpi install git:github.com/code-yeongyu/pi-lsp-client
# ...yukarıdaki tablodan herhangi bir paket adını yerine koyun.
```

Tam kurulum / güncelleme / kaldırma akışı için [Senpi Paketleri](packages/coding-agent/README.md#pi-packages) bölümüne bakın.

### Zaten senpi yerleşiği olarak sunulan pi-extension paketleri

Normal senpi kullanımı için bu paketleri kurmanıza **gerek yoktur**; işlevleri ikili dosyaya zaten dahildir. Bu tablo bilinçli olarak yalnızca şu anda kayıtlı `builtinExtensions` listesiyle eşleşen paketlerle sınırlandırılmıştır:

| Paket | Şu adla dahil | Yerleşik yetenek |
|---|---|---|
| [`pi-anthropic-bash`](https://github.com/code-yeongyu/pi-anthropic-bash) | `anthropic-bash` | Anthropic yerel bash aracı çeşidi. |
| [`pi-anthropic-web-search`](https://github.com/code-yeongyu/pi-anthropic-web-search) | `anthropic-web-search` | Anthropic yerel web arama desteği. |
| [`pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch) | `gpt-apply-patch` | GPT ailesi çalıştırmaları için Codex tarzı `apply_patch` aracı. |
| [`pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout) | `bash-timeout` | Bash zaman aşımı varsayılanları, maksimum zaman aşımı zorlaması ve istem politikası. |
| [`pi-goal`](https://github.com/code-yeongyu/pi-goal) | `goal` | Kalıcı hedef takibi, TUI durumu ve devamlılık istemleri. |
| [`pi-nested-agents-md`](https://github.com/code-yeongyu/pi-nested-agents-md) | `nested-agents-md` | İç içe dizinler için yakındaki `AGENTS.md` dosyalarını otomatik enjekte eder. |
| [`pi-openai-web-search`](https://github.com/code-yeongyu/pi-openai-web-search) | `openai-web-search` | OpenAI Responses yerel web araması. |
| [`pi-rules`](https://github.com/code-yeongyu/pi-rules) | `rules` | `AGENTS.md` ve `CLAUDE.md` dahil proje ve kullanıcı kural dosyalarını keşfeder. |
| [`pi-todotools`](https://github.com/code-yeongyu/pi-todotools) | `todowrite` | `todowrite` / `todoread`, todo kenar çubuğu durumu, iş akışı istem rehberliği ve devamlılık takipleri. |
| [`pi-webfetch`](https://github.com/code-yeongyu/pi-webfetch) | `webfetch` | URL içeriğini sınırlı süre ve boyutta markdown, metin veya HTML olarak getirir. |
| [`pi-websearch`](https://github.com/code-yeongyu/pi-websearch) | `websearch` | Yapılandırma kapılı etkinleştirme ve kaynağa duyarlı sonuçlarla sağlayıcı destekli web araması. |

`permission-system`, `prompt-preset`, `service-tier`, `tool-pair-guard`, `compaction`, `history-search` ve `session-observer` gibi diğer yerleşikler, kurulabilir kardeş paketleri olmayan senpi'ye özgü yerleşik eklentilerdir.

## Neden "senpi"

`senpi`, **senpai** üzerine küçük bir şakadır ancak aynı zamanda kelimenin tam anlamıyla bir proje konumlandırmasıdır: bu çatal, upstream'in temel tasarımından vazgeçmeden günlük ajan işlerini daha akıcı hale getiren pratik eklemelerle daha **makul (sane)** bir pi olmayı hedefler.

Tüm eklemeler pi'nin önce-eklenti (extension-first) felsefesini takip eder. Upstream birleştirme commit'lerinin incelenebilir kalması için çekirdek kaynak kod değişiklikleri en aza indirilir ve [`changes.md` dosyalarında belgelenir](#fork-strategy).

## Bu çatal neler ekliyor

senpi, pi'nin önce-eklenti tasarımını miras alır — çekirdek minimal kalır, her özellik yerleşik bir eklenti olarak gelir. Buradaki yaklaşım, görüş sahibi bir özellikler kümesinin ikili dosyada bulunacak kadar sık istendiğidir; istemediğiniz her şey `settings.json` içindeki bir ayar bayrağıyla (`disabledBuiltinExtensions`) kapatılabilir.

`git diff upstream/main..HEAD` ve depodaki her `changes.md` dosyasına karşı doğrulanmıştır.

### Yeni çekirdek alt sistemleri

| Alt sistem | Ne yapar | Belgeler |
|---|---|---|
| **Dinamik sistem istemi** | Upstream'in statik istemini uyarlanabilir bir oluşturucuyla değiştirir: senpi kimliği → zorunlu niyet kapısı → görev üzerinde çalışma disiplini (paralel dalgalar, keşif durakları, tek plan bağlılığı) → doğrulama katmanları → kategorize edilmiş araç referansı → politikalar → stil → isteğe bağlı model başına ince ayar. | [`dynamic-prompt/`](packages/coding-agent/src/core/dynamic-prompt/AGENTS.md) · [`changes.md`](packages/coding-agent/src/core/dynamic-prompt/changes.md) |
| **Sıkıştırma hattı (Compaction pipeline)** | Plugsuit tarzı uyarlanabilir eşikler, boş özetleme koruması, dal özetleme kancaları. Geri yükleme izleyicisiyle spekülatif + acil durum sıkıştırması [`compaction` yerleşik eklentisi](#owned-builtin-extensions) olarak yer alır. | [`core/compaction/`](packages/coding-agent/src/core/compaction/) · [`changes.md`](packages/coding-agent/src/core/compaction/changes.md) |
| **Araç çağrısı ara katmanı yeniden yazımı** | Yerel fonksiyon çağırma desteği olmayan modeller için XML / Hermes / YAML+XML / Gemma4 metin-araç protokolleri. Katı ayrıştırma, akış hatası koruma. | [`tool-call-middleware/`](packages/ai/src/tool-call-middleware/AGENTS.md) · [`changes.md`](packages/ai/src/tool-call-middleware/changes.md) |

### Projeye ait yerleşik eklentiler

Ağaç içi (in-tree), senpi iç yapılarına sıkıca bağlıdır. Tam olarak şu kayıt sırasıyla yüklenir:

| # | Eklenti | Görev | Belgeler |
|---|---------|-------|----------|
| 1 | [`permission-system`](packages/coding-agent/src/core/extensions/builtin/permission-system/) | Tam opencode tarzı izin portu — kurallar, JSONL depolama, TUI istemleri, ayrıştırıcıya duyarlı kalıplar (bash argüman sayısı, dosya glob'ları, `apply_patch` gövde yolları), etkileşimsiz geri dönüş | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/permission-system/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/permission-system/changes.md) |
| 2 | [`gpt-apply-patch`](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/) *(vendored)* | Etkin model OpenAI GPT olduğunda `write`/`edit` araçlarını Lark dilbilgisiyle Codex tarzı serbest biçimli `apply_patch` ile değiştirir. [`code-yeongyu/pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch) deposundan senkronize edilir. | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/AGENTS.md) |
| 3 | [`prompt-preset`](packages/coding-agent/src/core/extensions/builtin/prompt-preset/) | Dinamik istemin üzerine katmanlanan model başına sistem istemi ön ayarları (gpt-5.x, claude-opus-4-{5,6,7}, kimi-k2-6). Paylaşılan codex tarzı dosya işlemleri ince ayarı. | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/prompt-preset/changes.md) |
| 4 | [`todowrite`](packages/coding-agent/src/core/extensions/builtin/todotools/) *(vendored)* | Dal duyarlı kalıcılık, kenar çubuğu bileşeni, iş akışı istem rehberliği ve devamlılık döngüsü ile `todowrite` / `todoread` araçları. [`code-yeongyu/pi-todotools`](https://github.com/code-yeongyu/pi-todotools) deposundan senkronize edilir. | — |
| 5 | [`redraws`](packages/coding-agent/src/core/extensions/builtin/redraws.ts) | Kümülatif TUI tam yeniden çizim sayısını bildiren `/tui` komutu. Diferansiyel işleme hata ayıklaması için kullanılır. | — |
| 6 | [`anthropic-web-search`](packages/coding-agent/src/core/extensions/builtin/anthropic-web-search/) | Anthropic yerel `web_search` aracı | — |
| 7 | [`anthropic-bash`](packages/coding-agent/src/core/extensions/builtin/anthropic-bash/) | Anthropic yerel bash aracı çeşidi | — |
| 8 | [`openai-web-search`](packages/coding-agent/src/core/extensions/builtin/openai-web-search/) | OpenAI Responses yerel `web_search` | — |
| 9 | [`service-tier`](packages/coding-agent/src/core/extensions/builtin/service-tier.ts) | Model başına hizmet katmanını veya `openai.serviceTier` ayarını kullanarak OpenAI Responses yüklerine `service_tier` (`auto` / `flex` / `priority`) enjekte eder | — |
| 10 | [`bash-timeout`](packages/coding-agent/src/core/extensions/builtin/bash-timeout/) *(vendored)* | Varsayılan + maksimum bash zaman aşımlarını enjekte eder, politikayı sistem istemine ekler. [`code-yeongyu/pi-bash-timeout`](https://github.com/code-yeongyu/pi-bash-timeout) deposundan senkronize edilir. | — |
| 11 | [`tool-pair-guard`](packages/coding-agent/src/core/extensions/builtin/tool-pair-guard/) | Sahipsiz `tool_result` bloklarını kaldırarak Anthropic istek yüklerini temizler — sıkıştırma güvenliği | — |
| 12 | [`compaction`](packages/coding-agent/src/core/extensions/builtin/compaction/) | Spekülatif + acil durum sıkıştırma politikası: bozulma monitörü, devre kesici, tur başına sınır, todo köprüleme, kontrol noktası durumu, geri yükleme izleyicisi, araç sonucu kırpma | [AGENTS.md](packages/coding-agent/src/core/extensions/builtin/compaction/AGENTS.md) · [changes.md](packages/coding-agent/src/core/extensions/builtin/compaction/changes.md) |
| 13 | [`history-search`](packages/coding-agent/src/core/extensions/builtin/history-search/) | `/history` komutu — bir katman (overlay) içinde oturumlar arası istem geçmişini arar | — |
| 14 | [`websearch`](packages/coding-agent/src/core/extensions/builtin/websearch/) | Yapılandırma kapılı etkinleştirme, TUI durumu ve kaynağa duyarlı sonuçlarla sağlayıcı destekli `web_search` aracı | — |
| 15 | [`webfetch`](packages/coding-agent/src/core/extensions/builtin/webfetch/) | Sınırlı süre ve boyutta URL içeriğini markdown, metin veya HTML olarak getiren `webfetch` aracı | — |
| 16 | [`nested-agents-md`](packages/coding-agent/src/core/extensions/builtin/nested-agents-md/) | Ajan iç içe dizinlerden okuma yaptığında yakındaki `AGENTS.md` dosyalarını otomatik enjekte eder | — |
| 17 | [`rules`](packages/coding-agent/src/core/extensions/builtin/rules/) | Proje kural dosyalarını otomatik keşfeder ve `/rules` / `/reload-rules` komutlarını sunar | — |
| 18 | [`goal`](packages/coding-agent/src/core/extensions/builtin/goal/) | Kalıcı hedef izleme araçları, alt bilgi (footer) durumu ve devamlılık istemleri | — |

> Yukarıdaki yerleşik dizinler upstream `pi-mono`'ya kıyasla yenidir — hiçbiri `badlogic/pi-mono` içinde bulunmaz. Dahil edilen (vendored) sürümler [`external-versions.json`](packages/coding-agent/src/core/extensions/builtin/external-versions.json) dosyasında sabitlenmiştir ve [`sync-builtin-extensions.mjs`](packages/coding-agent/scripts/sync-builtin-extensions.mjs) ile kardeş `pi-extensions` kopyasından senkronize edilir.

### Bağımsız eklenti depoları

Bunlar herkese açık `code-yeongyu/pi-*` depoları olarak sürdürülür ve `settings.json` `packages` veya `senpi install git:github.com/code-yeongyu/<repo>` aracılığıyla kurulabilir.

| Eklenti | Depo | Ne yapar |
|---------|------|----------|
| `pi-comment-checker` | [`code-yeongyu/pi-comment-checker`](https://github.com/code-yeongyu/pi-comment-checker) | `write`, `edit`, `multiedit` ve `apply_patch` sonrasında OMO uyumlu `apply_patch` meta verileri ve ham Codex yama geri dönüşü dahil `@code-yeongyu/comment-checker` çalıştırır; uyarıları düzenleyici üstü bir bileşende gösterir |

### Genel varsayılan eklentiler

Yerleşik olarak yüklenmez; yerel olarak düzenleyebilmeniz veya kaldırabilmeniz için ilk çalıştırmada bir kez `~/.senpi/agent/extensions/` içine yazılır.

| Eklenti | Kaynak | Ne yapar |
|---------|--------|----------|
| `diff` | [`diff.ts`](packages/coding-agent/src/core/extensions/builtin/diff.ts) | `/diff` komutu — `git status`'tan değiştirilen / silinen / yeni dosyaları seçer, VS Code'un diff görünümünü açar |
| `files` | [`files.ts`](packages/coding-agent/src/core/extensions/builtin/files.ts) | `/files` komutu — geçerli oturum dalında okunan / yazılan / düzenlenen dosyaları listeler, seçileni VS Code'da açar |
| `prompt-url-widget` | [`prompt-url-widget.ts`](packages/coding-agent/src/core/extensions/builtin/prompt-url-widget.ts) | İstemlerdeki GitHub PR / issue URL'lerini algılar, `gh` aracılığıyla başlığı getirir, oturum adını otomatik ayarlar |
| `tps` | [`tps.ts`](packages/coding-agent/src/core/extensions/builtin/tps.ts) | Her ajan turundan sonra saniye başına token bildirimi (giriş / çıkış / önbellek okuma-yazma / toplam / geçen süre) |

### Değiştirilmiş upstream paketleri

| Paket | Neler değişti | Referans |
|-------|---------------|----------|
| [`packages/ai`](packages/ai/AGENTS.md) | Senpi markalı Codex `originator` ve User-Agent, paylaşılan tool-pair-repair yardımcı programı, `apply_patch` için OpenAI Responses özel/serbest biçimli araç desteği, Claude Opus 4.7 + `"max"` düşünme seviyesi, her sağlayıcıda `extraBody` geçişi, [araç çağrısı ara katmanı yeniden yazımı](packages/ai/src/tool-call-middleware/AGENTS.md) | [`ai/src/changes.md`](packages/ai/src/changes.md) |
| [`packages/agent`](packages/agent/AGENTS.md) | Paralel araç tamamlama yayımı (eşzamanlı sonlandırma, kaynak sırasına göre sonuçlar), `uuid` bağımlılığının yerini alan satır içi UUIDv7, ES2021 uyumlu altyapı tanılamaları | [`agent/src/changes.md`](packages/agent/src/changes.md) |
| [`packages/tui`](packages/tui/AGENTS.md) | Diferansiyel işleme sıkılaştırması: insert-scroll hızlı yolu, görünüm alanı (viewport) yeniden eşleme boyama düzeltmesi, titreme bütçesi regresyon testleri (başlatma sonrası tam temizleme yok, dengeli DECSET 2026) | [`tui/src/changes.md`](packages/tui/src/changes.md) |
| [`packages/coding-agent`](packages/coding-agent/AGENTS.md) | `senpi` markalaması, model yapılandırma kontrolleri (`upstreamModelId`, `serviceTier`, favori modeller, devre dışı bırakma/beyaz liste/kara liste), engelleyici olmayan başlangıç araç keşfi, devre dışı bırakılmış başlangıç güncelleme kontrolleri, [bash `promptSnippet` değerinin `rg` ile değiştirilmesi](packages/coding-agent/src/core/tools/AGENTS.md), oluşturulan varsayılan eklenti hızlı yolu, senpi markalı giden kimlik | Birden fazla [`changes.md`](packages/coding-agent/src/) dosyası |

### Diğer markalama / çalışma zamanı değişiklikleri

| Değişiklik | Ayrıntılar |
|------------|------------|
| **`senpi` CLI kimliği** | Kodlama ajanı kendini `senpi` olarak tanımlar, yapılandırma depolaması için `.senpi/agent` kullanır ve npm'de `@code-yeongyu/senpi` olarak yayınlanır. Kurulan çalıştırılabilir dosya `senpi` olarak kalır. |
| **Senpi markalı giden kimlik** | Her giden istek `pi` yerine `senpi` yayar: `User-Agent` (güncelleme kontrolü + Cloudflare + GitHub sürümleri), `X-OpenRouter-Title`, OpenAI Codex `originator` + User-Agent. |
| **Başlangıçta güncelleme kontrolü yok** | Başlatma sırasında npm kayıt defteri sürüm kontrolü ve paket güncelleme istemleri kaldırıldı. |
| **Yerleşik eklenti arayüz gruplaması** | Yerleşikler, başlangıç başlığında kullanıcı ve proje eklentilerinden görsel olarak ayrı biçimde `builtin/` grubu altında işlenir. |
| **Güncellenmiş model kayıt defteri** | `models.generated.ts` en son model eklemeleri ve kullanımdan kaldırmalarla yenilendi. |
| **Kendi kendini güncelleme hedefi** | `senpi update senpi`, upstream'i değil [`code-yeongyu/senpi`](https://github.com/code-yeongyu/senpi) sürümlerini sorgular. |

## Fork Stratejisi

Bu çatal düzenli olarak `upstream/main` üzerine rebase edilir. Birleştirme çakışmalarını en aza indirmek için:

1. **Önce eklenti (Extension-first)**: Tüm özellikler pi'nin [eklenti sistemini](packages/coding-agent/docs/extensions.md) yerleşik eklentiler olarak kullanır.
2. **Çekirdek değişiklikleri belgeleyin**: Her upstream dosya değişikliğinin, etkilenen alt dizinde neyin değiştiğini, nedenini ve beklenen çakışma bölgelerini belgeleyen karşılık gelen bir `changes.md` dosyası vardır.
3. **Uzak depolar (Remotes)**: `origin` = [code-yeongyu/senpi](https://github.com/code-yeongyu/senpi), `upstream` = [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

Değiştirilen upstream dosyaları (yüksek etkili olanlar; geri kalanı için dizin bazındaki `changes.md` dosyalarına bakın):

| Dosya | Değişiklik |
|-------|------------|
| `agent-session.ts` | `buildSystemPrompt()` yerine `buildDynamicSystemPrompt()` çağırır; birleşik sıkıştırma hattı; model değişikliğinde sistem istemi güncellemesi |
| `resource-loader.ts` | SYSTEM.md / APPEND_SYSTEM.md keşfi kaldırıldı; yerleşik eklenti yükleme eklendi; oluşturulan varsayılan eklenti hızlı yolu |
| `interactive-mode.ts` | Yerleşik eklenti görüntüleme biçimlendirmesi; devre dışı bırakılmış güncelleme kontrolleri; engelleyici olmayan başlangıç araçları; favori model döngüsü |
| `model-registry.ts` | Özel `upstreamModelId` ve `serviceTier`; sağlayıcı/model devre dışı bırakma/beyaz liste/kara liste; `thinkingLevelMapMode` |
| `settings-manager.ts` | `disabledBuiltinExtensions`; `favoriteModels`; `openai.serviceTier`; varsayılan yönlendirme (steering) `"all"` |
| `agent-loop.ts` (`packages/agent`) | `executeToolCallsParallel()` |
| `tui.ts` (`packages/tui`) | Diferansiyel işleme hızlı yolları + titreme bütçesi zorlaması |
| `package.json` | Kodlama ajanı paketi ve çalışma zamanı kimliği `senpi` olarak yeniden markalandı |

## Açık kaynak kodlama ajanı oturumlarınızı paylaşın

Açık kaynak çalışmaları için pi veya diğer kodlama ajanlarını kullanıyorsanız lütfen oturumlarınızı paylaşın.

Herkese açık OSS oturum verileri, oyuncak kıyaslamalar (benchmark) yerine gerçek dünya görevleri, araç kullanımı, hatalar ve düzeltmelerle kodlama ajanlarını geliştirmeye yardımcı olur.

Tam açıklama için [X'teki bu gönderiye](https://x.com/badlogicgames/status/2037811643774652911) bakın.

Oturumları yayınlamak için [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf) kullanın. Kurulum talimatları için README.md dosyasını okuyun. İhtiyacınız olan tek şey bir Hugging Face hesabı, Hugging Face CLI ve `pi-share-hf`'dir.

Ayrıca `pi-mono` oturumlarımı nasıl yayınladığımı gösterdiğim [bu videoyu](https://x.com/badlogicgames/status/2041151967695634619) da izleyebilirsiniz.

Kendi `pi-mono` çalışma oturumlarımı düzenli olarak burada yayınlıyorum:

- [Hugging Face üzerinde badlogicgames/pi-mono](https://huggingface.co/datasets/badlogicgames/pi-mono)

## Tüm Paketler

| Paket | Açıklama |
|-------|----------|
| **[@earendil-works/pi-ai](packages/ai)** | Metin akışı, araç çağırma, OAuth yardımcıları ve görsel oluşturma ile birleşik çoklu sağlayıcı LLM API'si |
| **[@earendil-works/pi-agent-core](packages/agent)** | Araç çağırma ve durum yönetimine sahip ajan çalışma zamanı |
| **[senpi](packages/coding-agent)** | senpi olarak yeniden markalanmış etkileşimli kodlama ajanı CLI'ı |
| **[@code-yeongyu/senpi-codemode](packages/senpi-codemode)** | Ayarlar, çekirdek (kernel), köprü ve başlangıç yapı taşlarına sahip yalnızca kaynak kodlu codemode eklenti paketi |
| **[@earendil-works/pi-tui](packages/tui)** | Diferansiyel işlemeye sahip terminal arayüz kütüphanesi |

Slack/sohbet otomasyonu ve iş akışları için [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat) deposuna bakın.

## İzinler ve Konteynerizasyon

senpi; dosya sistemi, işlem, ağ veya kimlik bilgisi erişimini kısıtlamak için yerleşik bir konteyner sınırı içermez. Varsayılan olarak, onu başlatan kullanıcının ve işlemin izinleriyle çalışır.

Daha güçlü sınırlara ihtiyacınız varsa senpi'yi konteynerize edin. Üç kalıp için [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) dosyasına bakın:

- **OpenShell**: tüm `senpi` işlemini politika kontrollü bir konteynerde çalıştırın.
- **Gondolin eklentisi**: yerleşik araçları ve `!` komutlarını yerel bir Linux mikro-VM'ine yönlendirirken `senpi` ve sağlayıcı kimlik doğrulamasını ana makinede tutun.
- **Düz Docker**: basit izolasyon için tüm `senpi` işlemini yerel bir konteynerde çalıştırın.

## Katkıda Bulunma

Katkı yönergeleri için [CONTRIBUTING.md](CONTRIBUTING.md) ve projeye özel kurallar için (hem insanlar hem de ajanlar için) [AGENTS.md](AGENTS.md) dosyasına bakın.

## Geliştirme

```bash
npm install --ignore-scripts  # Yaşam döngüsü betiklerini çalıştırmadan tüm bağımlılıkları kurun
bun install --ignore-scripts # Bun alternatifi
bun run build        # Tüm paketleri derleyin
bun run check        # Lint, biçimlendirme ve tip kontrolü
bun run test             # Testleri çalıştırın (API anahtarları olmadan LLM'e bağlı testleri atlar)
./pi-test.sh         # Canlı API entegrasyon paketi (ortam değişkeni kapılı; API anahtarları gerektirir)
bun run publish      # @code-yeongyu/senpi dahil npm çalışma alanlarını yayınlayın
```

## Tedarik zinciri sıkılaştırması

npm bağımlılık değişikliklerini incelenmiş kod değişiklikleri olarak ele alıyoruz.

- Doğrudan harici bağımlılıklar tam sürümlere sabitlenmiştir. Dahili çalışma alanı paketleri sürüm aralıklı olarak kalır.
- `.npmrc`, npm çözümlemesi sırasında aynı gün çıkan bağımlılık sürümlerinden kaçınmak için `save-exact=true` ve `min-release-age=2` ayarlar.
- `package-lock.json`, bağımlılık doğruluk kaynağıdır. `PI_ALLOW_LOCKFILE_CHANGE=1` ayarlanmadıkça pre-commit kazara lockfile commit'lerini engeller.
- `bun run check` sabitlenmiş doğrudan bağımlılıkları, yerel TypeScript içe aktarma uyumluluğunu ve oluşturulan coding-agent kurulum kilidini doğrular.
- Yayınlanan `@code-yeongyu/senpi` bildirimi kaynak bağımlılık listesidir: çatal çalışma alanları yayınlanan `@code-yeongyu/senpi-*` takma adları üzerinden çözümlenir ve tarball içinde yalnızca dahil edilen (vendored) istemci/protokol kodu gönderilir. `npm-shrinkwrap.json` yayınlanmaz.
- Sürüm duman testleri (smoke tests), bir sürümü etiketlemeden önce depo dışında izole npm ve Bun kurulumları derlemek, paketlemek ve oluşturmak için `bun run release:local` kullanır.
- Yerel sürüm kurulumları, belgelenmiş npm kurulumları ve `senpi update senpi`, desteklendiği yerlerde `--ignore-scripts` kullanır.
- CI `npm ci --ignore-scripts` ile kurar ve zamanlanmış bir GitHub iş akışı `npm audit --omit=dev` ile `npm audit signatures --omit=dev` çalıştırır. Bu npm iç yapıları bir takip geçişi için envantere alınmıştır.
- Install-lock oluşturma, bağımlılık yaşam döngüsü betikleri için açık bir izin listesine sahiptir; yeni yaşam döngüsü betiği bağımlılıkları incelenene kadar kontrollerde başarısız olur.

## Katkıda Bulunma

Katkı yönergeleri için [CONTRIBUTING.md](CONTRIBUTING.md) ve projeye özel kurallar için (hem insanlar hem de ajanlar için) [AGENTS.md](AGENTS.md) dosyasına bakın.

## Lisans

MIT

## Ganbare Ganbare Senpi

> *Hora, senpi senpi, senpi te kudasai!*
> *Ganbare ganbare senpi, gan ganbare ganbare senpi ora!*

Projenin adının gizlice selam durduğu [Ganbare Ganbare Senpai](https://en.wikipedia.org/wiki/Don%27t_Toy_with_Me,_Miss_Nagatoro) memesine küçük, tamamen ciddiyetsiz bir aşk mektubu. Rebase ne zaman temiz ve testler yeşil olsa, bir yerlerde bir kouhai fısıldar:

- **Hadi senpi, hadi!** PR'ı gönder.
- **Beni fark et, senpi.** ...önce tanılamalar fark etti.
- **Daha çok çalış, senpi!** *(baktı. ve derleme de geçti.)*
- **Yapabilirsin, senpi!** Bir ajan daha, bir araç daha, bir temiz rebase daha.
- **Ganbare, ganbare, senpi! 頑張れ頑張れ先輩!** *Elinden gelenin en iyisini yap, senpai!*

Evet, tüm proje adı bir senpai kelime oyunudur. Tipleri sıkı yazın, testleri çalıştırın, bir `changes.md` yazın, birleştirme yüzeyini küçük tutun — ve *gan ganbare ganbare senpi ora!*

[plugsuits](https://github.com/minpeter/pss-runtime)'e selamlar: senpi'nin sıkıştırma sistemi tasarımından ilham almaktadır.
