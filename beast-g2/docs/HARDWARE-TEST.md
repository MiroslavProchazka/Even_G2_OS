# Test na skutečném G2 (I3.1)

Protokol měří, co aplikace dělá na skutečném Even G2, a zapisuje to tak, aby se běh dal zopakovat. **Tento dokument neobsahuje žádná měření ani výsledky** — ty se zapisují do šablony v části 4. Chování continuous režimu popisuje [CONTINUOUS.md](CONTINUOUS.md), uložené relace [SESSIONS.md](SESSIONS.md), gateway [DEPLOYMENT.md](DEPLOYMENT.md).

Cíle: **FR-03** (dlouhá řeč se dělí na zpracovatelné segmenty), **FR-06** (známé výpadky jsou součástí relace), **OQ-03** (je přijatelný aktivní telefon).

## 1. Kde se co dokazuje

| Plocha | Co na ní uvidíš |
| --- | --- |
| Brýle | přepis a hint, stavový řádek `REC 00:12 S3`, `PAUSED S5`, `ERR MIC`, `ERR UPLOAD`. Potvrzený zápis displeje není důkaz, že text skutečně přečteš. |
| Telefon → Conversations | seznam relací, přepis po turnsech, `coverage gaps` s časem a důvodem, stav jobs, souhrn s citacemi, `Export Markdown`. |
| Gateway | `GET /api/health` (`ok`, `mode`, `models.chat`, `models.stt`, `sessions`, `summaries`) a JSON log na stdout (request ID, stage, status, duration). |
| Diagnostics | `Diagnostics · local metadata only` → `Export diagnostic JSON`; nese `buildId`, `sdk`, `version` a 400 událostí, žádné audio ani text. |

## 2. Podmínky před startem

- **Brýle:** Even G2, nabité; zapiš procenta baterie před a po.
- **Telefon:** Even App **2.2.10+** (`min_app_version`), SDK **0.0.16** (`min_sdk_version`, závislost `@evenrealities/even_hub_sdk`). Skutečnou verzi Even App opiš z obrazovky; dokument ji nepředpokládá.
- **Balíček:** `beast-g2-0.7.0.ehpk`, `package_id` `com.prochmi.beastg2`, verze `0.7.0` z `app.json`. V repozitáři není (`*.ehpk` je gitignored), musíš ho sestavit z `beast-g2/`:

```sh
npm run pack:device -- https://llm.corp.sldev.cz/v1
```

  Vznikne `app.device.json` (gitignored) a `beast-g2/beast-g2-0.7.0.ehpk`. Skript ověří manifest a do whitelistu zapíše jen předané originy.
- **Uložené relace:** vyžadují transport **Custom gateway**, protože `/api/sessions` obsluhuje Node gateway, ne Beast. Do whitelistu přidej i její origin, jinak WebView požadavky zablokuje a Conversations zůstanou nedostupné:

```sh
npm run pack:device -- https://llm.corp.sldev.cz/v1 https://<gateway-origin>
```

  Druhý argument musí být holý `https://` origin bez cesty, query a fragmentu.
- **Gateway:** `ALLOWED_ORIGINS` musí obsahovat skutečný origin Even WebView; `403 origin_denied` znamená, že chybí. `GET /api/health` musí vracet `sessions:true` a `summaries:true`.
- **Klíč:** v Direct Beast se zadává Beast klíč, v Custom gateway `GATEWAY_TOKEN`; oba až v aplikaci do `API key / gateway token` a zůstávají v paměti session. Nikdy do URL, `VITE_*`, manifestu, screenshotu ani issue.
- **VPN:** Direct Beast vyžaduje firemní VPN na telefonu. Wi-Fi bez VPN nestačí; otevři base URL v prohlížeči telefonu — DNS chyba nebo timeout znamená, že VPN neběží.
- **Čistý start a časová osa:** `Clear logs` v Diagnostics, čerstvé spuštění aplikace; u každého kroku zapiš čas startu a konce a procenta baterie, aby šly gapy dohledat.
- **Souhlas:** testovací promluvy neobsahují citlivá data; audio se nahrává na gateway.

## 3. Průběh testu

Každý krok má čtyři řádky: co udělat, co pozorovat, kritérium PASS/FAIL a plochu, která výsledek dokazuje.

### 3.1 Instalace a první start

- **Udělej:** nahraj `.ehpk` do privátního projektu nebo developer preview, nainstaluj do brýlí, otevři aplikaci.
- **Pozoruj:** aplikace se otevře, `Connection` ukáže stav, Diagnostics obsahuje `sdk.bridge.connected`; v exportu zkontroluj `buildId` a `sdk`.
- **PASS:** aplikace běží a `buildId` odpovídá nainstalovanému balíčku. **FAIL:** aplikace se neotevře, `sdk.bridge.failed` nebo `sdk.session.unresponsive`.
- **Důkaz:** telefon (`Connection`, Diagnostics export).

### 3.2 Spojení a Test connection

- **Udělej:** `API connection: Direct Beast API`, base URL `https://llm.corp.sldev.cz/v1`, klíč, chat `beast/big`, speech `whisper-live`, jazyk `Čeština` → `Apply connection` → `Test connection`.
- **Pozoruj:** stav hlásí chat i speech model; při chybě přečti text (`401`, `403`, timeout).
- **PASS:** test projde a hlásí oba modely. **FAIL:** chyba i po správném klíči a zapnuté VPN. Test `/models` nedokazuje STT.
- **Důkaz:** telefon (stav u `Connection`), Diagnostics `chat.request.*`.

### 3.3 První textová otázka

- **Udělej:** do `Text question · also works without glasses` napiš českou otázku (např. „Co umí Beast G2?“) a odešli; bez mikrofonu.
- **Pozoruj:** přepis otázky, streamovaná odpověď, `ANSWER` na brýlích, ovládání se odemkne.
- **PASS:** odpověď dorazí na telefon i brýle. **FAIL:** chyba, prázdná odpověď nebo timeout.
- **Důkaz:** telefon (transcript, answer), brýle, Diagnostics `chat.request.start` a `request.end`.

### 3.4 První mluvená otázka

- **Udělej:** `Listening mode: Manual · tap to ask`, klepni na brýle, polož krátkou otázku, klepni znovu.
- **Pozoruj:** `REC` na brýlích, po stop přepis a odpověď; Diagnostics `audio.pcm.received` s `bytes`, `frames`, `rms`.
- **PASS:** jeden finální přepis odpovídá řeči a dorazí odpověď. **FAIL:** prázdný přepis, `ERR MIC`, chyba mikrofonu.
- **Důkaz:** brýle, telefon, Diagnostics.

### 3.5 Dvacet anotovaných promluv

- **Udělej:** `Listening mode: Continuous G2 · live transcript + hints`, `Speech sensitivity: Normal`, `Resume listening`. Přečti všech 20 promluv z tabulky níže, jednu po druhé, mezi nimi 2 s ticha; u #9–#11 mluv potichu, u #12–#14 pusť hluk z TV nebo rádia. Před #9 přepni v pauze na `Quiet speech`, před #12 na `Noisy room`, před #15 zpět na `Normal`; citlivost měň jen v pauze.
- **Pozoruj:** průběžný přepis, po 2 s ticha finální přepis a hint; do tabulky zapiš doslovný přepis a chyby.
- **PASS:** každá promluva má právě jeden finální přepis a jeden hint, žádná nezmizí bez chyby; přesnost zapiš, nestanovuj práh. **FAIL:** promluva bez finálního přepisu nebo bez chybového hlášení.
- **Důkaz:** brýle, telefon (`Continuous hint history`, posledních 20), Diagnostics `continuous.answer.ready`/`answer.shown`/`answer.expired`, `continuous.segment.dropped`.

| # | typ | promluva | musí zaznít | přepis | chyby |
| --- | --- | --- | --- | --- | --- |
| 1 | jméno | Zítra se sejdeme s Petrem Dvořákem a Janou Novákovou. | Petr Dvořák, Jana Nováková | | |
| 2 | jméno | Marek Böhm potvrdí rozpočet, Lucie Šťastná pošle zápis. | Marek Böhm, Lucie Šťastná | | |
| 3 | číslo | Rozpočet je tři sta dvacet tisíc korun. | 320 000 | | |
| 4 | číslo | Schůzka je čtrnáctého listopadu ve čtrnáct třicet. | 14. listopadu, 14:30 | | |
| 5 | číslo | Faktura má číslo dva nula dva šest nula čtyři sedm jedna. | 20260471 | | |
| 6 | mix | Pošli mi ten draft na Slack do pátku. | draft, Slack, pátek | | |
| 7 | mix | Zkontroluj latency na gateway a error rate. | latency, gateway, error rate | | |
| 8 | mix | Meeting posouváme na Thursday, čas zůstává. | Thursday | | |
| 9 | tichá | Tohle říkám potichu, ale potřebuju to v zápisu. | potichu, zápis | | |
| 10 | tichá | Další krok je revize smlouvy, termín v pátek. | revize, smlouva, pátek | | |
| 11 | tichá | S tím návrhem souhlasím. | návrh, souhlasím | | |
| 12 | hluk | V téhle místnosti je hluk, ale rozhodli jsme se pro variantu B. | varianta B | | |
| 13 | hluk | Kávu si dám později, teď řešíme rozpočet. | kávu, rozpočet | | |
| 14 | hluk | Zapiš to jako úkol pro Adama. | úkol, Adam | | |
| 15 | rychlá | Nejdřív shrnutí, potom další body a nakonec termíny. | shrnutí, body, termíny | | |
| 16 | jméno + číslo | Pan Procházka volal na sedm sedm šest dva jedna čtyři devět nula tři. | Procházka, 776 214 903 | | |
| 17 | mix | Deadline je Friday, owner je Petra. | Friday, Petra | | |
| 18 | číslo | Zopakuju to jen jednou: čtyři sta dvacet. | 420 | | |
| 19 | hluk | I přes hluk potvrzujeme termín devátého. | devátého | | |
| 20 | jméno | Pošli to prosím Markétě, ne Martinovi. | Markéta, ne Martin | | |

### 3.6 Uložená relace 30–60 minut

- **Udělej:** `Conversations` → `New session`, název `G2 I3.1`, jazyk `Čeština`, `Start recording`. Na začátku přednes 90 s souvislý text bez pauzy, pak mluv 30–55 min s přirozenými pauzami (limit serveru je 60 min), nakonec `End`; před začátkem a na konci zapiš procenta baterie brýlí i telefonu.
- **Pozoruj:** `REC mm:ss S<n>` na brýlích roste, segmenty přibývají; po `End` se přepis dočítá, jobs dobíhají, coverage je `Complete coverage` nebo gapy s časem a důvodem.
- **PASS (FR-03):** 90 s úsek je celý v přepisu (0–30, 30–60, 60–90 s) nebo má explicitní gap s časem a důvodem; žádný potvrzený segment nezmizí bez záznamu. **FAIL:** konec 90 s textu chybí bez gapu.
- **Důkaz:** telefon (segmenty, turny, gapy), `Export Markdown`, gateway log.

### 3.7 Pauza a resume uprostřed relace

- **Udělej:** uprostřed relace `Pause`, mluv 10 s (nahrávat se nemá), `Resume`, mluv dalších 10 s.
- **Pozoruj:** brýle `PAUSED S<n>`, po resume `REC`; v přepisu jsou obě poloviny v pořadí a nic není dvakrát.
- **PASS (FR-05):** částečný segment se při pauze dokončil, po resume pořadí pokračuje a žádný turn není duplicitní. **FAIL:** ztracený konec věty bez gapu nebo duplicitní turn.
- **Důkaz:** telefon (turny, segmenty), Diagnostics `session.session.paused`, `session.segment.uploaded`.

### 3.8 Pět minut se zamčeným telefonem

- **Udělej:** během relace zamkni telefon bočním tlačítkem, nech ho 5 minut zamčený, celou dobu mluv, pak odemkni a vrať se do aplikace. Pro spuštění z menu brýlí a test se zámkem použij beta build s aktivním testerstvím.
- **Pozoruj:** co dělá stavový řádek na brýlích, počet segmentů před a po, `app.visibility.changed phase:hidden`, zda po odemknutí přišly segmenty za zamčenou dobu a co je v `coverage gaps`.
- **PASS (FR-06):** zamčený interval je nahraný, nebo zapsaný jako gap s časem a důvodem (`unknown` je přípustné), a stav je viditelný. **FAIL:** pět minut chybí bez gapu a bez hlášení. Výsledek je měření pro **OQ-03**, ne rozhodnutí.
- **Důkaz:** telefon (gapy, turny), Diagnostics, brýle.

### 3.9 Výpadek BLE

- **Udělej:** během relace vypni Bluetooth na ~30 s (nebo odnes brýle z dosahu), pak ho zapni a vrať se.
- **Pozoruj:** `ERR MIC`/`ERR UPLOAD`, stav spojení, `sdk.bridge.failed` a `sdk.bridge.connected`, zda po obnovení přijdou segmenty a zda interval tvoří gap.
- **PASS (FR-06):** výpadek má viditelný stav a časový interval, capture po obnovení pokračuje bez restartu aplikace. **FAIL:** tichá ztráta bez gapu nebo aplikace zůstane viset.
- **Důkaz:** brýle, telefon (gapy), Diagnostics `sdk.bridge.*`, gateway log.

### 3.10 Výpadek sítě

- **Udělej:** během relace vypni na ~30 s Wi-Fi i mobilní data (Bluetooth nech zapnutý), mluv, pak je zapni; totéž jednou během continuous inference.
- **Pozoruj:** viditelnou chybu místo tichého čekání, `session.segment.upload_failed`, gap s důvodem `network`, po obnovení retry a další promluvu.
- **PASS (FR-06):** výpadek má stav, čas a důvod `network`, po obnovení se uploady doberou. **FAIL:** segment zmizí bez gapu nebo se aplikace zablokuje.
- **Důkaz:** telefon (gapy, jobs), Diagnostics, gateway log (`status`, `duration`).

### 3.11 Návrat do Even App

- **Udělej:** přepni z pluginu na domovskou obrazovku Even App, počkej ~1 min, vrať se do pluginu; pak zkus `Resume` a `Start` bez mluvení.
- **Pozoruj:** zda se WebView načetl znovu, zda relace zůstala `active`/`paused`, zda se capture sám nespustil, zda se načetl seznam relací.
- **PASS (FR-01, OQ-03):** relace má stejné ID a serverem potvrzené turny, poslech se sám nespustí a capture vyžaduje explicitní akci. **FAIL:** relace zmizí, stav se ztratí nebo se mikrofon spustí sám.
- **Důkaz:** telefon (seznam, detail, stav), Diagnostics `app.visibility.changed`, `app.session.started`.

### 3.12 Ukončení, souhrn a export

- **Udělej:** `End`, počkej na dokončení přepisu, pak `Request summary`; otevři citace, `Export Markdown`, `Export diagnostic JSON`.
- **Pozoruj:** stav jobs, `Complete`/`Partial`/`Unknown coverage`, souhrn s citacemi, zda má některé tvrzení oporu, dobu do ready.
- **PASS (FR-07, FR-09):** souhrn má citace na konkrétní turny a coverage odpovídá mezerám. Kvalitu souhrnu zde nehodnoť číslem, to je I3.2; zapiš jen tvrzení bez opory. **FAIL:** souhrn bez citací, `failed` nebo tvrzení bez opory.
- **Důkaz:** telefon (souhrn, citace, export), gateway log.

## 4. Šablona výsledků

### 4.1 Jeden běh

| Položka | Hodnota |
| --- | --- |
| Datum a čas startu / konce | |
| Místo a prostředí (ticho / kancelář / hluk) | |
| Brýle: model, sériové číslo, firmware | |
| Telefon: model, OS | |
| Even App | |
| SDK | 0.0.16 |
| Balíček | beast-g2-0.7.0.ehpk |
| `buildId` z Diagnostics exportu | |
| Provider profil | Direct Beast / Custom gateway, chat, speech, origin |
| Baterie brýlí start / konec | |
| Baterie telefonu start / konec | |
| Délka běhu | |
| Pozorované mezery (čas, důvod) | |
| Chyby přepisu (počet, příklady) | |
| Poznámky ke kvalitě souhrnu | |
| OQ-03: vydržel telefon aktivní? co se ztratilo? | |

### 4.2 Mezery

| # | od–do | důvod (`network`, `missing_segment`, `stt_failed`, `unknown`) | kde je vidět |
| --- | --- | --- | --- |
| | | | |

Nález, který vyžaduje změnu kódu, zapiš jako samostatnou položku (BACKLOG.md nebo issue) s časem, krokem a diagnostickým exportem. V této fázi kód neměň.

## 5. Co tento protokol nedokazuje

- Kvalitu souhrnů a extrakce; to měří I3.2 na anotované sadě.
- Obecnou přesnost STT nebo VAD; jeden mluvčí, jedno prostředí a jeden kus hardwaru nejsou statistika.
- Že SDK potvrdil fyzické zobrazení textu; úspěšný zápis displeje je jen potvrzení, čitelnost ověřuje pohled.
- Bezpečnost, izolaci prostorů, retenci a cenu; to řeší DEPLOYMENT.md a OQ-02/OQ-04/OQ-05.
- Jiný telefon, jinou síť, jiný provider, jinou zemi nebo jiné brýle.
- Dlouhodobou stabilitu v řádu dní a běžné nošení.

## 6. Známé limity

- **Aktivní telefon:** aplikace potřebuje otevřený WebView; při skrytí se pauzuje continuous poslech (`pauseAll(true)`), uložená relace se explicitně nepauzuje. OQ-03 se tím měří, ne řeší.
- **Bez záruky na pozadí:** chování při zamčeném telefonu a po přepnutí app je pozorování, ne slib. Nativní capture klient není součástí této fáze.
- **Simulátor není důkaz:** `npm run simulate` ověří gesta a tok PCM, ne mikrofon, BLE, baterii ani uzamčený telefon.
- **Continuous limit:** promluva nad 30 s se viditelně odmítne a capture pokračuje po 2 s ticha; uložená relace dělí na 30 s segmenty a server přijímá až 60 s.
- **Manifest:** `supported_languages` je `["en"]`, přestože UI i přepis jsou české; pozoruj, zda to omezuje český text na brýlích.
- **Direct Beast:** neumí `/api/sessions`; uložené relace vyžadují Custom gateway s whitelistem.
- **Data:** audio se maže po přepisu nebo do 24 h, relace po 30 dnech.
