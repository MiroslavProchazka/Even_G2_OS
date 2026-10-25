# IRIS jako produktová inspirace

Datum: 25. 10. 2026
Stav: návrh dalšího směřování, ne závazný plán
Zdroj: https://eveniris.com (home, /discover, /getting-started, /agent, /privacy, /accessibility, /vs-conversate)
Metoda: veřejné stránky výrobce, marketingová tvrzení. Nešlo o nezávislý test aplikace ani o ověření na G2.

Tento dokument je produktový rámec, ne náhrada [BACKLOG.md](BACKLOG.md). Backlog B1-B5 zůstává platný. Tady jde o to, co si z IRIS vzít, co nedělat a v jakém pořadí.

Vztah k backlogu: B1 je gate 0, B2 odpovídá P1.3, B3 P1.5, B4 P1.2 a B5 P3.1. P1.1, P1.4 a P1.6 jsou nové. Priority v tomto dokumentu jsou novější; u rozporu platí tento dokument.

## Proč to řešit

IRIS je komerční third-party aplikace pro G2. Conversate je built-in. Náš projekt je třetí cesta: open-source, self-hosted, bez účtu a bez cloudu.

IRIS není zajímavý seznamem funkcí. Je zajímavý tím, že z konverzace udělá uzavřenou smyčku: příprava před schůzkou, klidný průběh na brýlích, souhrn po schůzce a paměť na lidi. Jejich stránky také ukazují, že produkt je placený, ne jen hobby projekt. Pro nás je důležitější to, kde je hodnota: ne v modelu, ale v tom, že konverzace neskončí u jednoho hintu.

Naše dnešní silná stránka je živá část: VAD, průběžný přepis, české hlásky, gateway, limity, testy, CI a CodeQL. Naše největší mezera je po schůzce: končíme u hintu, nemáme souhrn, úkoly, resume ani režim pouze titulků.

## Co je na IRIS dobré

### 1. Zero-config první dojem

IRIS: otevři aplikaci, tap Start, žádný účet. Náš projekt dnes chce URL, token, modely a volby. Self-hosted nemůže být zero-config pro každého, ale může být one-command pro vývojáře.

### 2. Session jako jednotka

IRIS: pauza teď, dokončit později, souhrn, export. Náš projekt má 20 odpovědí v paměti a reload je ztratí. To je špatná jednotka pro reálnou schůzku.

### 3. Trust jako funkce

IRIS má samostatnou sekci Co nebude dělat: neposlouchá napřed, neodesílá nic bez potvrzení, neotvírá zámek bez dotazu, nevymýšlí odpověď. Náš projekt část z toho má, ale není to vidět v UI ani v README.

### 4. Lens-first ovládání

IRIS používá prsten, tap na dismiss, scroll na historii, quick actions a captions-only. Náš projekt má tap, double tap a swipe, ale ne rychlé akce ani jasný stav, co je právě potlačené.

### 5. Úzké režimy

IRIS má Conversation, Listening a Study. Každý režim mění, kdy má mlčet a kdy mluvit. Náš projekt má manual, continuous a simulation, což je technické rozdělení, ne produktové.

### 6. After-value

IRIS stojí na tom, co zůstane po schůzce: souhrn, úkoly, export, paměť, people pages. To je jejich největší hodnota a naše největší mezera.

### 7. Agent bridge

IRIS má /agent a podporuje Hermes. Jejich cesta jde přes IRIS relay a ukládá adresu a klíč. To je pro nás strategicky zajímavé, protože Hermes je náš agent, ale bez relay a bez ukládání.

## Naše pozice

Co máme:

- Vlastní gateway, vlastní klíč, žádný účet a žádný cloud.
- Češtinu jako první jazyk, ne jako překlad.
- Open-source repo, testy, CI, CodeQL a rate limit.
- Explicitní webové hledání s označenými zdroji.
- Žádné ukládání audia ani konverzace na serveru.

Co nám chybí:

- Rozhodnutí, kdy mlčet. Dnes posíláme každou promluvu do modelu.
- Souhrn a úkoly po schůzce.
- Obnovitelná relace po reloadu nebo přerušení.
- Režim pouze titulků bez modelu a bez historie.
- Ovládání za běhu a rychlé akce.
- Nastavení, které jde udělat jedním příkazem nebo průvodcem.
- Viditelná trust vrstva: co se posílá, co se ukládá a co se nikdy nedělá.

## Návrhy podle priority

| ID | Priorita | Návrh | Proč | Odhad |
| --- | --- | --- | --- | --- |
| P1.1 | P1 | Cue policy a režimy Conversation, Listening, Study, Captions, Direct | IRIS na tom stojí: nemluví na vše, mluví jen když to pomůže | 2-3 dny |
| P1.2 | P1 | Souhrn relace, úkoly a lokální export | Nejdražší část IRIS a naše největší mezera | 2-3 dny |
| P1.3 | P1 | Obnovitelná relace s explicitním Resume/End | Reálná schůzka je delší než jedno WebView | 2-3 dny |
| P1.4 | P1 | Režim pouze titulků bez modelu a bez historie | Přístupnost, hluk, přednáška, levné a rychlé | 1-2 dny |
| P1.5 | P1 | Ovládání za běhu a quick actions | Dlouhý rozhovor potřebuje méně nebo více hintů bez zastavení poslechu | 2-3 dny |
| P1.6 | P2 | Setup a connection doctor | Self-hosted nemůže být zero-config, ale může být one-command | 2-4 dny |
| P2.1 | P2 | Šablony relací Meeting, Lecture, Interview, Accessibility | Režim nemá být nekonečný builder | 2-3 dny |
| P2.2 | P2 | Zeptej se relace nad přepisem | Po souhrnu je přirozený další krok | 2-3 dny |
| P2.3 | P2 | Překlad poslední promluvy nebo odpovědi | IRIS to nemá, Conversate ano, pro češtinu diferencátor | 1-2 dny |
| P2.4 | P2 | Náhledy posledních souhrnů na brýlích | Není core, ale uzavírá smyčku | 2 dny |
| P2.5 | P2 | Privacy a trust stránka v README | Pro open-source důležitější než další funkce | 0,5 dne |
| P3.1 | P3 | Agent mode přes Hermes | Dlouhodobě nejsilnější diferenciátor, ale velký rozsah | 5-10 dnů |
| P3.2 | P3 | Lokální paměť na lidi | Jen pokud B1 a P1 ukážou, že to lidé chtějí | 5-10 dnů |

## P1.1 Cue policy a režimy

IRIS na /getting-started popisuje aplikaci, která nemá být chatbot odpovídající na všechno, ale má promluvit, jen když to pomůže. Náš continuous dnes posílá každou neprázdnou promluvu do modelu. To je největší UX rozdíl.

Už máme `show:false` v contextual cues. Návrh je povýšit ho na výchozí a přidat režimy:

- Conversation: odpovídej na otázky, oprav jasnou chybu, nabídni follow-up. U tvrzení a small talku mlč.
- Listening: jemné follow-up otázky a podpora. Jinak ticho.
- Study: definuj termíny, jména a odpovídej na otázky přednášejícího. Nikdy neradí, co říct.
- Captions: jen přepis, žádný chat.
- Direct: současné odpověz na vše pro testy a lidi, kteří to chtějí.

Přijetí: statements a small talk neprodukují hint, questions ano, quiet turn zůstane v kontextu, žádný JSON na sklo, režim je vidět v UI. Direct zachová dnešní chování.

## P1.2 Souhrn relace, úkoly a export

IRIS na tom stojí: odejít se souhrnem. My máme jen 20 odpovědí a žádný souhrn.

Implementace:

- Držet celý přepis aktivní relace v paměti, limit 2 hodiny nebo 100 000 znaků.
- Tlačítko Summarize a nový `POST /api/summarize` s JSON schématem: shrnutí, rozhodnutí, úkoly, otevřené otázky, citace na turn ID.
- Vlastníka a termín u úkolu uvést jen když zazněly, jinak neuvedeno.
- Export Markdown a JSON, žádné automatické zápisy do Google Drive, Obsidianu ani Todoistu.
- Žádné odesílání bez potvrzení.

Přijetí: každý úkol má citaci v přepisu, žádný vymyšlený vlastník ani termín, export funguje bez sítě, limit velikosti je vidět.

## P1.3 Obnovitelná relace

IRIS: pauza teď, dokončit později. My: reload ztratí historii a skrytí aplikace pozastaví capture.

Implementace:

- Session objekt: přepis, hinty, prep, režim, začátek.
- Opt-in lokální persistence, TTL 24 hodin, max 1 MB.
- Explicitní Resume a End. Nikdy automaticky nespouštět mikrofon.
- Smazání relace smaže i persistentní kopii.

Přijetí: reload obnoví správnou relaci bez duplicitních odpovědí, smazání odstraní vše, mikrofon se po obnově nespustí bez vědomého startu.

## P1.4 Režim pouze titulků

IRIS: živé titulky, nic se neukládá, zdarma. My: continuous posílá každou promluvu do modelu.

Implementace:

- Režim CAPTIONS, reuse VAD a STT.
- Žádný chat, žádná historie, žádný obsah v diagnostics.
- Na brýlích malý stav not saved, na telefonu plný text.
- Bez voiceprintů. Případný speakerRole je jen orientační, ne identita.

Přijetí: žádné chat volání, žádná historie, český přepis, jasné označení, že se nic neukládá.

## P1.5 Ovládání za běhu a quick actions

IRIS: only flag numbers, pause cues 10 min, we switched to Spanish. My: jen pauza celého poslechu.

Implementace:

- `commands.ts` s intenty fewer cues, more cues, pause cues 10 min, only numbers, recap, answer that, summarize so far.
- Hlas přes prefix beast v continuous režimu, nebo tlačítka na telefonu.
- Vždy ukázat, co příkaz znamená, a co se potlačilo.
- Přepis se nesmí ztratit.

Přijetí: parser a stav mají testy, změna četnosti nepřeruší poslech, uživatel vidí, že příkaz byl pochopen.

## P1.6 Setup a connection doctor

IRIS: tap Start, žádný účet. My: URL, token, modely.

Implementace:

- Přidat `npm run demo`, které spustí gateway, Vite a otevře browser.
- QR pairing pro origin, token nikdy do QR.
- Test connection po vrstvách: DNS, TLS, CORS, auth, chat model, STT.
- Každá chyba má vlastní hlášku a další krok.

Přijetí: mockované chyby pro každou vrstvu, žádný falešný úspěch, žádný secret v QR ani v logu.

## P2.1 Šablony relací

Meeting, Lecture, Interview, Accessibility. Každý preset nastaví prep prompt, cue style, summary template a jazyk. Začít 3-4 pevnými, ne LLM generátorem módů. LLM builder může přijít později, až budou reálné šablony.

## P2.2 Zeptej se relace

Po souhrnu chat nad přepisem: co jsme rozhodli, kdo má co udělat, co zůstalo otevřené. Lokálně, s citacemi, bez cross-session paměti.

## P2.3 Překlad

Přeložit poslední promluvu nebo odpověď do češtiny a angličtiny. Explicitní akce, test fontu na G2. Pro českého uživatele to je diferenciátor.

## P2.4 Náhledy na brýlích

Poslední souhrny a hinty na brýlích, listování prstenem. Není core, ale uzavírá smyčku.

## P2.5 Privacy a trust stránka v README

Tabulka co se posílá, co se ukládá a co se nikdy nedělá. Pro open-source projekt důležitější než další funkce. IRIS to má jako What she will not do.

## P3.1 Agent mode přes Hermes

IRIS má /agent a podporuje Hermes. Jejich cesta jde přes IRIS relay a ukládá adresu a klíč. Naše verze by mohla být přímé napojení gateway na Hermes, bez relay, s explicitním potvrzením akcí.

Je to P3, ale dlouhodobě nejsilnější diferenciátor, protože Hermes je náš agent. Nedělat před B1 a P1.

## P3.2 Lokální paměť na lidi

Paměť na lidi je moat IRIS, ale také největší privacy plocha. Pokud ji budeme chtít, tak lokálně, opt-in, s explicitním schválením, s možností vidět a smazat, bez cross-mode úniku. Nedělat jako cloud.

## Co nekopírovat

- Voiceprints a who said what. Biometrie, SDK speakerRole není identita. Ne.
- Always-on background a Hey Even. Platforma to neumí spolehlivě, baterie a soukromí. Ne.
- Cloud backup, web app, people pages a cross-session paměť. Proti našemu self-hosted a no-persistence. Pokud někdy, tak lokálně, opt-in, s explicitním schválením a smazáním.
- Home Assistant a Tesla. Security-critical, samostatný projekt, ne do beast-g2.
- Teleprompter, slides, calendar a audience Q&A. Scope creep.
- Automatické live web search za každým hintem. Cena, latence, soukromí. Nechat explicitní search a označit zdroje.
- Předplatné. My jsme free a open source.

## Doporučené pořadí

0. B1 hardware test. 20 českých vět, latence, 5 minut se zamčeným telefonem, BLE reconnect. Bez toho nevíme, jestli summary nebo captions-only mají smysl. IRIS je marketing, ne důkaz.
1. P1.1 cue policy a režimy, P1.2 summary a export, P1.3 resume, P1.4 captions-only, P1.5 steering.
2. P1.6 setup doctor, P2.1 šablony, P2.2 session chat, P2.3 překlad, P2.4 náhledy, P2.5 privacy stránka.
3. P3.1 agent mode a P3.2 lokální paměť jen pokud B1 a P1 ukážou, že to lidé chtějí.

## Otevřené otázky pro iteraci

- Chceme být self-hosted IRIS pro jednoho uživatele, nebo obecná platforma pro více aplikací?
- Je naše výhoda absence cloudu, čeština, nebo otevřenost? Marketing by měl říct jednu věc, ne tři.
- Chceme po P1.2 ukládat přepis, nebo jen exportovat a zapomenout?
- Chceme agent mode jako P3, nebo jako hlavní diferenciátor? Pokud hlavní, musí být v roadmapě dřív než šablony.
- Jaký minimální hardware test musí projít před P1.1? Bez něj jen hádáme, co je použitelné.
- Kdo je cílový uživatel: člověk s G2, který chce soukromí, nebo vývojář, který chce platformu?
- Chceme IRIS použít jako klienta Beastu, nebo konkurovat celé aplikaci?

## Definice úspěchu první iterace

Na skutečném G2, 20 českých promluv, p50 a p95 latence, žádný ztracený hint, souhrn s citacemi, žádný vymyšlený vlastník ani termín, žádný automatický externí zápis. Bez toho je další seznam funkcí jen další kód.

## Zdroje

Navštíveno 25. 10. 2026. Jde o veřejné stránky výrobce, ne o nezávislé ověření.

- https://www.eveniris.com/
- https://www.eveniris.com/discover
- https://www.eveniris.com/getting-started
- https://www.eveniris.com/agent
- https://www.eveniris.com/privacy
- https://www.eveniris.com/accessibility
- https://www.eveniris.com/vs-conversate
