# Kritické review Beast G2

25. října 2026. Rozsah: klient, Even SDK adaptér, manuální i kontinuální režim, PCM/VAD, přepis a chat, brána, testy, balení a diagnostika. Podklad: sloučený PR #3 (`4a76fd0`), přímý Beast adaptér (`a72a374`) a následné lokální změny diagnostiky. Toto je review korektnosti a provozní připravenosti, nikoli samostatný bezpečnostní audit.

## Aktualizace 0.3 podle testování

Průběžný přepis, finalizace po 2 s ticha a automatické desetisekundové hinty nahrazují filtr otázek a ruční inbox. R3 je odstraněn z aktivního toku (každý neprázdný přepis jde do chatu). R5 má automatické FIFO a backpressure bez zahození dokončených odpovědí. R4 zatím řeší explicitní odmítnutí promluvy delší než 30 s místo odeslání neúplných 12s segmentů. R6 rozšířeno o události publikace a expirace hintu; doručení na hardware ověřují samostatné SDK zápisy. Podrobnosti a zbývající limity: CONTINUOUS.md.

## Stav první opravné iterace po PR #4

- R1 opraveno na úrovni SDK fronty: po timeoutu se session označí jako unresponsive, všechny další operace (start, stop, write, exit) jsou odmítnuty bez dalšího nativního volání a diagnostika zapíše `session.unresponsive`. Tím se zabrání tichému zaseknutí i souběhu s nezodpovězeným voláním. Plná obnova session bez znovuotevření pluginu zůstává otevřená; timeout nadále nezaručuje fyzické vypnutí mikrofonu. Čekání na bridge/startup stránku zůstává otevřené.
- R3 částečně opraveno: koncové směrové „right“ a úvodní „Prosím tě / Please“ již neodmítají otázku; oddělený dovětek „, right?“ se dál filtruje. Sémantické posouzení a širší korpus zůstávají otevřené.
- R5 opraveno pro současný prototyp: FIFO inbox tří čekajících odpovědí, explicitní Show next, počet nepřečtených, při overflow odpadne nejstarší čekající odpověď; její ztráta má vlastní čítač i diagnostickou událost. Právě čtená odpověď se nepřepisuje.
- R2, R4, R6, R7 zůstávají otevřené. Níže je původní audit pro zachování kontextu.

Ověření: 51 testů prošlo včetně pozdního dokončení SDK po timeoutu, zamrzlého display, pořadí/overflow inboxu a obou reprodukcí filtru; TypeScript/Vite build prošel. Živé G2 ani Beast v této iteraci netestovány.

## Verdikt

Projekt je prototyp pro řízené testování. Testy ověřují mnoho důležitých stavů, ale nedokládají živý Beast, skutečný mikrofon G2 ani provoz se zamčeným telefonem. Zelený build a `.ehpk` nejsou důkazem použitelnosti na hardwaru. Před delší relací doporučuji vyřešit nedokončená volání SDK a ověřit krátkou skutečnou otázku od mikrofonu až po displej.

## Nálezy podle priority

### R1 · P1 · Nedokončené volání SDK zablokuje ovládání

Místo: `src/even.ts`, serializace operací a `audioControl`; `src/display.ts`, čekání na write.

Pokud nativní `audioControl(true)` nikdy nesplní promise, všechny následné stop operace čekají za ním. Manuální i kontinuální controller zůstanou ve startu/pauze; kontinuální watchdog začíná až po úspěšném startu. Podobně nezodpovězený textový zápis zastaví display frontu. Nejde o pomalý model, nýbrž o nedokončenou komunikaci s hostem. Ověřeno strukturou fronty; dosavadní testy opožděné promise nakonec uvolňují, nekryjí trvalé zamrznutí.

Návrh: sledovat stáří každé nativní operace a po deadline zobrazit jednoznačný stav „SDK neodpovídá / mikrofon neznámý“. Zablokovat nový capture a nabídnout restart session. Samotný Promise.race nesmí rozběhnout další příkaz vedle stále běžícího nativního volání. Pro display lze aktualizaci označit jako nedoručenou a vyžadovat novou session.

### R2 · P1 · Poslech se úmyslně zastavuje při skrytí aplikace

Místo: `src/main.ts`, handler `visibilitychange`.

Při `document.hidden` se volá `pauseAll(true)`. Režim tedy není nepřetržitý při přepnutí aplikace nebo zamčení telefonu, pokud host tuto změnu signalizuje. To je současná konzervativní politika, nikoli doložená neschopnost platformy. V produktu se ale liší od očekávání „nechám telefon v kapse a Aside poslouchá“.

Návrh: oddělit skrytí telefonní obrazovky, odchod z pluginu na brýlích a skutečné uspání hosta. Přidat diagnostický experiment na beta buildu, log životního cyklu a 5minutový lock test. Podporovaný background režim povolit až na základě výsledku pro konkrétní telefon/Even App; při chybějícím PCM zůstat přerušený a neukazovat falešné listening.

### R3 · P2 · Filtr vynechává platné otázky a přijímá některá tvrzení

Místo: `src/continuous.ts`, `isQuestion`.

Reprodukce: `isQuestion('Should I turn right?')` i `isQuestion('Prosím tě, kolik je hodin?')` vrací false. První odmítá koncové „right“, druhou počáteční formulace před otázkou. Naproti tomu věta začínající „Je ...“ může projít jako otázka i bez otazníku. Stávající test směru obsahuje „right“ uprostřed věty, nikoli tento hraniční případ.

Návrh: samostatný testovací korpus českých/anglických přepisů s očekávaným záměrem, větná segmentace a přesnější zacházení s dovětky. Výchozí režim „Beast, ...“ je předvídatelnější. Volitelné modelové posouzení může zlepšit recall, musí mít limit latence a počtu volání. Reportovat precision/recall na syntetickém korpusu i ručně anotovaných reálných přepisech; současnou heuristiku neprezentovat jako porozumění záměru.

### R4 · P2 · Přepis po pevných segmentech ztrácí kontinuitu dlouhé otázky

Místo: `src/vad.ts`, maxSegmentMs=12000; `src/continuous.ts`, jeden filtr pro celý přepis.

Dlouhá promluva se rozdělí i bez ticha. Následující díl je transkribován samostatně a filtr vyžaduje otázkový začátek; doplnění otázky může být ignorováno. Pre-roll pomáhá začátku zvuku, neřeší spojení významu více segmentů. Překryv může naopak vytvářet podobné přepisy.

Návrh: omezený slučovač navazujících přepisů s identitou utterance, timeoutem a celkovým limitem. Oddělit technický audio segment od uživatelské otázky. Zachovat frontu a deduplikaci; neřešit to neomezeným zvětšováním nahrávky.

### R5 · P2 · Nové hotové odpovědi mohou přepsat čekající odpověď

Místo: `src/continuous.ts`, zápis `latest: reply`.

Uživatel čte odpověď A, odpověď B čeká v latest, dokončená C nahradí B. B již nelze otevřít. To je omezená paměťová politika, ale na rozdíl od zahazovaného audia nemá počet ani jasný údaj o ztrátě dokončených odpovědí.

Návrh: omezený inbox například tří odpovědí, čítač nepřečtených a explicitní pravidlo zahazování. Při testu logovat pouze počty a ID, nikoli obsah odpovědí.

### R6 · P2 · Diagnostika je užitečná pro relaci, ne pro pád procesu

Původně chyběl export i průběžná časová osa. Nový panel uchovává 400 událostí pouze v paměti. Reload, ukončení WebView nebo pád telefonu je smaže. Trace ID zatím spojuje jednu operaci; STT a chat nemají společné turn ID. Záznam neobsahuje první token ani původní strukturovaný provider error code. Chybu DNS/TLS/CORS browser zpravidla sjednotí do fetch failure; log je nemůže spolehlivě rozlišit.

Návrh další iterace: turnId od audio segmentu po ACK displeje, stage durations + TTFT a počet nedoručených renderů, podporované provider request ID a výslovně vybrané bezpečné error codes. Volitelný lokální persistentní kruhový log s krátkým TTL a kontrolou uživatele; nepersistovat raw audio a konverzaci. Síťový průvodce má oddělit origin whitelist, CORS, dostupnost hostu, auth, model a skutečnou inference.

### R7 · P2 · CI ani hardwarová regresní sada zatím nechrání merge

Repo neobsahuje automatický workflow test/build ani browser test. Současné unit/integration testy mají syntetické PCM a fake/demo poskytovatele. V tomto review byl doplněn ruční browser test textového toku a exportu diagnostiky; nejde o automatickou regresi.

Návrh: CI pro npm ci, testy, typecheck/build, SSE kontrakty a browser demo s kontrolou overflow na mobilních šířkách. Balení provést se známým vendor floor bez tichého spoléhání na starou CLI mapu. Před tagem verze manuální beta checklist: audio, diakritika, interrupt/resume, BLE reconnect, pět minut lock a delší bateriový test.

## Opravy už provedené v této iteraci

- **P1: restart manuálního mikrofonu po neúspěšném stop.** Před opravou šlo vyvolat dva starty a stav recording, přestože první mikrofon nebyl potvrzeně vypnutý. Nově neznámý stav blokuje restart, dokud explicitní cancel úspěšně nepotvrdí stop. Přidán regresní test.
- **P2: tiché selhání stop při dispose.** SDK adaptér dříve ignoroval návrat false a nastavil capture=false. Nově výsledek kontroluje a zaznamená dispose.stop_failed s neznámým stavem. Dispose tím nezaručuje úspěch na hardwaru; nejistotu již nezamlčuje.
- **Diagnostický panel:** operace SDK/mic, agregované audio bytes/frames/RMS/peak, STT/chat HTTP status a doby, fronta/drop/ignore, display write a runtime chyby. Bounded ring, export a textový fallback; žádný automatický odchozí monitoring.
- **Server gateway:** JSON stdout se stage, request ID, stavem a dobou. Neloguje URL, Authorization ani obsah.
- **Direct Beast:** explicitní režim místo zaměňování Beast API s vlastní /api/* bránou, multipart WAV a streaming SSE, konfigurovatelné modely. User-specified host je jen v lokálním device manifestu a balíčku.

## Konkrétní síťový výsledek

Na tomto Macu se během pokusu nepodařilo přeložit uživatelem zadaný Beast hostname (DNS resolution failure). Neproběhla HTTP odpověď serveru, takže není ověřen endpoint, model, přepis ani CORS. Tento výsledek není chyba modelu 400. Je to aktuální integrační překážka; telefon může mít jinou síť/VPN/DNS a musí se ověřit samostatně.

Lokální browser demo naopak ukázalo: odmítnutý CORS origin → browser network error + server 403; po opravě povoleného testovacího originu úspěšný health a textový dotaz přes skutečné HTTP až do UI, včetně exportu metadat. Testovací origin je lokální konfigurace běžícího demo procesu, nikoli produkční změna CORS.

## Doporučené pořadí

1. Řízený test na G2: ověřit DNS/síť, textový dotaz, jeden český WAV a manuální mikrofon. Exportovat jednu diagnostickou relaci při neúspěchu.
2. Před dlouhou kontinuální relací vyřešit R1 a změřit R2. Zelené syntetické testy tuto dvojici nenahradí.
3. Zlepšit R3/R4 na konkrétním korpusu, doplnit inbox R5.
4. Zavést CI a korelovanou diagnostiku/případný persistentní log R6/R7.

Podrobnosti logů: README → Diagnostics. Ověření hardwaru, mobilního vizuálního layoutu, výkonu a baterie stále zbývá. Příčinu původního sekání Aside toto review neprokazuje.
