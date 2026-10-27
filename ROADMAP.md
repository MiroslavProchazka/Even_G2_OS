# Roadmap — Even G2: etapy a fáze pro paralelní práci agentů

Verze: 1.0 · Datum: 27. 10. 2026 · Výchozí commit: `49484c2` (`beast-g2` 0.5.0)

Produktové požadavky, jejich stav a rozhodnutí drží [Product_spec.md](Product_spec.md). Tento dokument je prováděcí plán: co se dělá, v jakém pořadí, kdo co vlastní a jak se pozná, že je fáze hotová. Není to závazný harmonogram ani slib, že všechny fáze proběhnou.

## 1. Jak dokument používat

**Etapa** je produktový milník se vstupní a výstupní branou. **Fáze** je jedna jednotka práce pro jednoho agenta: jeden worktree, jedna branch, jeden commit nebo malý PR. Fáze se zadává celá najednou, včetně seznamu souborů, které smí agent měnit.

Pravidla pro každou fázi:

1. Agent pracuje v samostatném worktree `../even-g2-worktrees/<phase-id>` a na větvi `feat/<phase-id>-<slug>`. Do `main` necommituje.
2. Agent mění jen soubory v části **Vlastní soubory**. Ostatní soubory jsou read-only. Nové soubory smí zakládat jen v uvedených adresářích.
3. Sdílený kontrakt (`src/session-api.ts`, `server/sessions/http.mjs`, `server/sessions/db.mjs`, `src/sessions.ts`) mění pouze fáze, která ho vlastní, nebo integrační agent při merge. Ostatní fáze do něj přidávají jen to, co určuje jejich zadání, a konflikt hlásí, nedomýšlí ho.
4. Hotovo znamená: nové i staré testy procházejí, `npm run typecheck`, `npm run lint`, `npx prettier --check .` a `npm run build` procházejí, dokumentace je aktualizovaná a v reportu je přesný výstup příkazů.
5. Agent nesmí použít reálná data, tokeny ani klíče. Fixtury jsou syntetické a výslovně označené.
6. Když zadání narazí na produktové rozhodnutí (OQ v Product_spec.md), agent se zastaví a napíše otázku. Nevymýšlí výchozí hodnotu sám.
7. Chování mimo rozsah fáze se neimplementuje „protože to bylo po cestě“. Patří do jiné fáze nebo do backlogu.
8. Každá fáze končí reportem: co je hotové, jaké příkazy prošly s jakým výsledkem, co zůstalo neověřené a jaké soubory se změnily.

Společná definition of done:

```sh
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"   # Node 20.18 kvůli better-sqlite3
cd beast-g2
npm test && npm run typecheck && npm run lint && npx prettier --check . && npm run build
```

## 2. Stav po I3

MVP je implementované. Tabulka níže je výchozí bod pro plánování, ne nový důkaz.

| Oblast | Stav | Co plán nevyřeší samo |
| --- | --- | --- |
| Serverové relace, segmenty, přepis, revize, mezery, export, mazání | Hotovo, 121 testů | živé Beast STT, provozní zátěž |
| Souhrny a preparation snapshoty | Hotovo, 144 testů | kvalita na živém modelu, lidské hodnocení |
| Klientské UI relací, G2 capture, stavový řádek | Hotovo, 198 testů, simulátor | skutečný mikrofon, zamčený telefon, BLE, baterie |
| Živá pomoc | Původní prototyp | kvalita a četnost hintů, Captions |
| Paměť, hledání, pracovní kontext | Neimplementováno | etapy I4 až I6 |

Testy běží na Node 20.18, protože `better-sqlite3` v tomto checkoutu je kompilovaný pro Node 20. `npm run test:coverage` lokálně neprojde, pokrývá ho CI na novějším Node.

## 3. Etapy

| Etapa | Cíl | Vstupní brána | Výstupní brána |
| --- | --- | --- | --- |
| I3 dokončení | Doplnit důkaz, že MVP funguje na skutečném hardwaru a že souhrny mají použitelnou kvalitu. | I1 až I3 hotové v kódu. | Hardwarový protokol a evaluační report s čísly; rozhodnutí pokračovat do I4. |
| I4 paměť a živá pomoc | Najít v uložených relacích, ptát se nad nimi, schvalovat poznatky, odděleně testovat Captions a hinty. | I3 dokončení nebo výslovné rozhodnutí pokračovat bez hardwaru. | Užitečnost retrievalu, opravy a mazání odvozených dat, přijatelná míra vyrušování. |
| I5 pracovní kontext | Jeden omezený read-only briefing nad povolenými zdroji. | I4.1 a I4.3 hotové, protože briefing staví na paměti a schválených poznatcích. | Ověřené pokrytí, aktuálnost, správné stavy a prokázaná úspora proti ručnímu briefu. |
| I6 otevřená rozhraní | Read-only API, MCP a následně schvalované akce. | I4 a I5 stabilní, přístupový model navržený. | Ověřený přístup, žádný únik mezi prostory, idempotentní akce. |
| I7 provoz | Nasazení, zálohy, retence, observabilita a CI brány. | Může běžet souběžně s I4. | Obnovený test ze zálohy, ověřené mazání, běžící CI na Node 20 i 22. |

Pořadí etap není striktně lineární. I7.1 a I7.2 mohou běžet kdykoli. I5 nesmí začít dřív než I4.1 a I4.3. I6 nesmí začít dřív než I4.3.

## 4. Fáze

U každé fáze je uvedený cíl, závislosti, vlastněné soubory, kritéria přijetí a co je mimo rozsah. Odhad S znamená přibližně jednu agentní session, M jednu až dvě, L dvě až tři s možností rozdělení.

### I3.1 Ověření na skutečném G2

**Cíl:** Změřit, co aplikace dělá na skutečném hardwaru, a zaznamenat to tak, aby se výsledek dal opakovat.

**Závisí na:** nic (může běžet souběžně s I4.0).

**Vlastní soubory:** `beast-g2/docs/HARDWARE-TEST.md` (nový), `beast-g2/scripts/hardware-probe.mjs` (nový, volitelný), `beast-g2/docs/CLOUD-VERIFICATION.md` (jen sekce o G2).

**Kritéria přijetí:** Protokol obsahuje alespoň 20 anotovaných českých promluv, 30 až 60minutovou relaci, pět minut se zamčeným telefonem, výpadek BLE a sítě, návrat do Even App a pozorovanou spotřebu baterie. U každého bodu je zařízení, verze Even App, SDK a provider profil. Nálezy, které vyžadují opravu kódu, jsou zapsané jako samostatné položky, ne provedené potichu v této fázi.

**Mimo rozsah:** změny architektury capture, nové režimy, optimalizace baterie.

**Odhad:** M, závisí na dostupnosti brýlí a uživatele.

### I3.2 Kvalita souhrnů na živém modelu

**Cíl:** Změřit, jestli souhrny obsahují správná rozhodnutí a závazky, a zveřejnit chyby.

**Závisí na:** nic (fixtury jsou syntetické).

**Vlastní soubory:** `beast-g2/scripts/summary-eval.mjs` (nový), `beast-g2/tests/fixtures/summary-eval/*.json` (nové), `beast-g2/docs/EVALUATION.md` (nový).

**Kritéria přijetí:** Sada má alespoň 10 relací s ručně anotovanými rozhodnutími, závazky a otevřenými otázkami. Skript spočítá pokrytí, přesnost tvrzení s oporou, počet vymyšlených vlastníků nebo termínů a dobu běhu. Report uvádí i neúspěšné případy. Čísla se porovnají s cíli v Product_spec.md sekce 12.

**Mimo rozsah:** změny promptu, které nejsou podložené naměřenými chybami. Změna modelu bez záznamu důvodu.

**Odhad:** M.

**Stav:** hotovo 27. 10. 2026, commit `171f7e3`. 11 fixtur, replay režim, 215 testů.

### I4.0 Švy pro paralelní práci

**Cíl:** Rozdělit horká místa tak, aby každá další fáze mohla přidat routu, migraci, kontrakt a UI panel bez editace stejného souboru jako jiná fáze.

**Závisí na:** nic. Tato fáze běží sama a blokuje I4.1 až I4.5, I5 a I6.

**Vlastní soubory:** `beast-g2/server/sessions/http.mjs`, `beast-g2/server/sessions/db.mjs`, `beast-g2/server/sessions/index.mjs`, nové `beast-g2/server/sessions/routes/` a `beast-g2/server/sessions/migrations/`, `beast-g2/src/session-api.ts`, nové `beast-g2/src/session-api/`, `beast-g2/src/sessions.ts`, nové `beast-g2/src/sessions/`, `beast-g2/docs/ARCHITECTURE.md` (nový).

**Co musí vzniknout:**

1. Registr rout: `routeSessions` zůstane tenký a předá části po `api/sessions` modulům, které exportují `match(parts)` a `handle(ctx)`. Nová routa je nový soubor v `routes/`, bez editace ostatních rout.
2. Registr migrací: `db.mjs` načte migrace z `migrations/index.mjs`, každá migrace je samostatný soubor s číslem a SQL. Přidání migrace neznamená editaci `db.mjs`.
3. Klientský kontrakt: `src/session-api.ts` zůstane veřejný barrel, ale typy a metody se přesunou do `src/session-api/<doména>.ts`. Nová doména je nový soubor.
4. UI slot: `initSessions` zůstane skládat sekci, ale nové panely se registrují funkcí `registerSessionPanel({ id, mount })` v `src/sessions/panels/`. `sessions.ts` nesmí růst o další stovky řádků.

**Kritéria přijetí:** Žádná změna chování. Všech 198 testů prochází bez úprav testů. Nové testy dokazují, že registr použije novou routu, migraci i panel, aniž by se měnil centrální soubor. `docs/ARCHITECTURE.md` popisuje švy a pravidla vlastnictví.

**Mimo rozsah:** nové funkce, změny API odpovědí, přejmenování existujících rout.

**Odhad:** L. Když je refaktor rizikový, rozdělit na I4.0a server a I4.0b klient, obě bez změny chování.

**Stav:** hotovo 27. 10. 2026. Server `86526dd` (registr rout a migrací), klient `c5b3eef` (rozdělený kontrakt a registr panelů), v `main` 238 testů.

### I4.1 Fulltext nad přepisy

**Cíl:** Najít relaci a pasáž podle textu, včetně české diakritiky, a použít výsledek pro orientaci.

**Závisí na:** I4.0.

**Vlastní soubory:** `beast-g2/server/sessions/migrations/003-search.mjs` (nový), `beast-g2/server/sessions/routes/search.mjs` (nový), `beast-g2/server/sessions/search.mjs` (nový), `beast-g2/src/session-api/search.ts` (nový), `beast-g2/src/sessions/panels/search.ts` (nový), `beast-g2/tests/search.test.mjs` (nový), `beast-g2/tests/search-http.test.mjs` (nový).

**Kritéria přijetí:** Migrace vytvoří FTS5 tabulku nad finálními turny a indexuje český text. Dotaz s diakritikou i bez ní najde stejnou pasáž. Smazaná relace se ve výsledcích neobjeví. Výsledek nese session ID, turn ID, revizi, čas a omezený výňatek. Limit je 50 výsledků, prázdný dotaz vrací 400. Testy pokrývají diakritiku, pořadí, smazanou relaci a limit.

**Mimo rozsah:** sémantické hledání, embeddings, vyhledávání v souhrnech, UI mimo seznam výsledků.

**Odhad:** M.

### I4.2 Dotazy nad relací

**Cíl:** Odpovědět na otázku typu „co jsme se dohodli o rozpočtu“ s citacemi na konkrétní turny, nebo jasně říct, že opora chybí.

**Závisí na:** I4.0, I4.1 (vyhledání kandidátních pasáží).

**Vlastní soubory:** `beast-g2/server/sessions/qa.mjs` (nový), `beast-g2/server/sessions/routes/qa.mjs` (nový), `beast-g2/src/session-api/qa.ts` (nový), `beast-g2/src/sessions/panels/qa.ts` (nový), `beast-g2/tests/qa.test.mjs` (nový).

**Kritéria přijetí:** Odpověď má vždy seznam citací turnů, ze kterých vychází. Když v relaci opora není, vrátí `insufficient_evidence` a nic nedomýšlí. Selhání dotazu nemění přepis ani souhrn. Testy pokrývají odpověď s citací, chybějící oporu, timeout provideru a omezení délky kontextu.

**Mimo rozsah:** zápis do paměti, externí zdroje, hlasové zadání dotazu.

**Odhad:** M.

### I4.3 Paměťové položky

**Cíl:** Uložit vybrané tvrzení jako kandidáta, nechat ho schválit, umět ho nahradit a smazat spolu se zdrojem.

**Závisí na:** I4.0.

**Vlastní soubory:** `beast-g2/server/sessions/migrations/004-memory.mjs` (nový), `beast-g2/server/sessions/memory.mjs` (nový), `beast-g2/server/sessions/routes/memory.mjs` (nový), `beast-g2/src/session-api/memory.ts` (nový), `beast-g2/src/sessions/panels/memory.ts` (nový), `beast-g2/tests/memory.test.mjs` (nový).

**Kritéria přijetí:** Kandidát vzniká jen z konkrétního turnu a revize. Stav je `proposed`, `approved`, `superseded` nebo `rejected`. Retrieval vrací jen `approved`. Nahrazení zachová historii a označí staré tvrzení. Smazání zdrojové relace smaže i odvozené položky, pokud uživatel výslovně nezvolí ponechání s označením ztráty důkazu. Testy pokrývají schválení, odmítnutí, nahrazení, smazání zdroje a přístup k neschválenému.

**Mimo rozsah:** automatické potvrzování modelen, vektorové hledání, sdílení mezi prostory.

**Odhad:** L.

### I4.4 Captions režim

**Cíl:** Samostatný režim titulků bez archivu a bez chatu, ovladatelný z brýlí i telefonu.

**Závisí na:** I4.0 (kvůli slotu v UI), ne na paměti.

**Vlastní soubory:** `beast-g2/src/captions.ts` (nový), `beast-g2/src/sessions/panels/captions.ts` (nový), `beast-g2/tests/captions.test.ts` (nový), `beast-g2/src/main.ts` (jen napojení režimu), `beast-g2/docs/CONTINUOUS.md` (jen sekce Captions).

**Kritéria přijetí:** Režim nic neukládá na server, neposílá segmenty a po ukončení nezanechá přepis. Stav je viditelný na brýlích i telefonu. Vypnutí je možné gestem i tlačítkem. Testy dokazují, že se nevolá session API a že přepis zmizí po ukončení.

**Mimo rozsah:** ukládání, souhrny, hinty, změny continuous pipeline.

**Odhad:** M.

### I4.5 Opt-in hinty

**Cíl:** Zapnout kontextové nápovědy jen výslovně, s pevným rozestupem, a měřit jejich užitečnost bez ukládání obsahu do telemetrie.

**Závisí na:** I4.0, I4.4 (společný režimový přepínač).

**Vlastní soubory:** `beast-g2/src/hints.ts` (nový), `beast-g2/src/sessions/panels/hints.ts` (nový), `beast-g2/tests/hints.test.ts` (nový), `beast-g2/src/continuous.ts` (jen volání hint policy), `beast-g2/docs/CONTINUOUS.md` (sekce Hinty).

**Kritéria přijetí:** Výchozí stav je vypnuto. Zapnutí je výslovná akce. Nevyžádaný hint má odstup alespoň 30 s a explicitní Ask má přednost. Pauza hintů nemění přepis. Hodnocení užitečné nebo rušivé je lokální a bez obsahu. Testy pokrývají vypnuto, rozestup, pauzu a selhání modelu.

**Mimo rozsah:** automatické ukládání hintů do paměti, hlasové spuštění nástroje.

**Odhad:** M.

### I5.1 Briefing z uložených relací

**Cíl:** Sestavit briefing jen z vybraných relací a souhrnů, bez externích zdrojů, s citacemi a datem.

**Závisí na:** I4.1, I4.3.

**Vlastní soubory:** `beast-g2/server/briefing/briefing.mjs` (nový), `beast-g2/server/briefing/routes.mjs` (nový), `beast-g2/src/session-api/briefing.ts` (nový), `beast-g2/src/sessions/panels/briefing.ts` (nový), `beast-g2/tests/briefing.test.mjs` (nový).

**Kritéria přijetí:** Briefing uvede zdrojovou relaci, datum a stav ověření u každého tvrzení. Když zdroj chybí, uvede `unverified`, ne „nic nového“. Testy pokrývají prázdný výběr, chybějící souhrn a citace.

**Mimo rozsah:** externí systémy, zápis, automatické rozesílání.

**Odhad:** M.

### I5.2 Read-only konektor

**Cíl:** Připojit jeden konkrétní pracovní systém pouze pro čtení a označit dostupnost a čas ověření.

**Závisí na:** I5.1, rozhodnutí OQ-08.

**Vlastní soubory:** `beast-g2/server/connectors/connector.mjs` (nový), `beast-g2/server/connectors/<system>.mjs` (nový), `beast-g2/server/connectors/routes.mjs` (nový), `beast-g2/tests/connectors.test.mjs` (nový), `beast-g2/docs/CONNECTORS.md` (nový).

**Kritéria přijetí:** Konektor má nakonfigurovaný rozsah, čas ověření a chybový stav. Nedostupný zdroj znamená `unverified`, nikoli `done` ani `nothing new`. Testy používají fake HTTP server, ne reálný systém. Žádný zápis, žádné tokeny v logu.

**Mimo rozsah:** zápis, obousměrná synchronizace, více systémů.

**Odhad:** L.

### I5.3 Ověřování aktuálnosti

**Cíl:** U každého externího tvrzení ukázat, kdy bylo naposledy ověřené a jestli je zdroj dostupný.

**Závisí na:** I5.2.

**Vlastní soubory:** `beast-g2/server/connectors/freshness.mjs` (nový), `beast-g2/tests/freshness.test.mjs` (nový), `beast-g2/src/sessions/panels/briefing.ts` (rozšíření).

**Kritéria přijetí:** Odpověď nese `checkedAt`, stav `fresh`, `stale` nebo `unverified`. Stáří se počítá z konfigurace, ne z domněnky. Testy pokrývají nedostupný zdroj, starý záznam a změnu stavu.

**Mimo rozsah:** automatické obnovování na pozadí, webhooky.

**Odhad:** S.

### I6.1 Read-only HTTP API

**Cíl:** Vystavit vybranou paměť a souhrny jinému klientovi s tokenem a rozsahem.

**Závisí na:** I4.1, I4.3, I5.1.

**Vlastní soubory:** `beast-g2/server/api/public.mjs` (nový), `beast-g2/server/api/scopes.mjs` (nový), `beast-g2/tests/public-api.test.mjs` (nový), `beast-g2/docs/API.md` (nový).

**Kritéria přijetí:** Token má rozsah (session read, summary read, memory read). Scope se vynucuje před čtením i před sestavením promptu. Cizí prostor vrací 404, ne data. Testy pokrývají chybějící token, špatný scope a jiný prostor.

**Mimo rozsah:** zápis, MCP, veřejný hosting.

**Odhad:** M.

### I6.2 MCP server

**Cíl:** Nabídnout read-only nástroje MCP nad stejným API.

**Závisí na:** I6.1.

**Vlastní soubory:** `beast-g2/server/mcp/server.mjs` (nový), `beast-g2/tests/mcp.test.mjs` (nový), `beast-g2/docs/MCP.md` (nový).

**Kritéria přijetí:** Server nabízí jen čtení a vrací citace. Neznámý nástroj vrátí chybu, ne prázdný výsledek. Test používá MCP klienta proti lokálnímu serveru.

**Mimo rozsah:** zápisové nástroje, OAuth.

**Odhad:** M.

### I6.3 Schvalované akce

**Cíl:** Umožnit jeden konkrétní zápis do externího systému až po výslovném schválení návrhu.

**Závisí na:** I5.2, I6.1.

**Vlastní soubory:** `beast-g2/server/actions/actions.mjs` (nový), `beast-g2/server/actions/routes.mjs` (nový), `beast-g2/tests/actions.test.mjs` (nový), `beast-g2/docs/ACTIONS.md` (nový).

**Kritéria přijetí:** Návrh má cíl, obsah a zdroj. Potvrzení platí pro konkrétní návrh. Změna obsahu vyžaduje nové potvrzení. Provedení je idempotentní a má dohledatelný výsledek. Testy pokrývají zamítnutí, změnu po potvrzení a opakované provedení.

**Mimo rozsah:** hromadné akce, automatické schvalování.

**Odhad:** L.

### I7.1 Nasazení

**Cíl:** Dostat gateway a klienta do provozu s HTTPS, tokenem, diskem a zálohou.

**Závisí na:** nic, může běžet souběžně s I4.

**Vlastní soubory:** `beast-g2/docs/DEPLOYMENT.md`, `beast-g2/scripts/backup.mjs` (nový), `beast-g2/scripts/restore-check.mjs` (nový), `beast-g2/.env.example` (jen nové proměnné).

**Kritéria přijetí:** Postup pokrývá HTTPS, token mimo balíček, datový svazek, kvótu, zálohu a obnovu. Zkušební obnova proběhne na syntetických datech a je popsaná s výsledkem. Žádné tajemství v dokumentaci.

**Mimo rozsah:** skutečné nasazení, placené prostředky, distribuce dalším lidem.

**Odhad:** M.

**Stav:** hotovo 27. 10. 2026, commit `ac1893b`. Záloha, restore drill a checklist; testy 204.

### I7.2 Observabilita a CI brány

**Cíl:** Doplnit diagnostiku, metriky a CI kontroly tak, aby chyba byla dohledatelná bez obsahu relace.

**Závisí na:** nic.

**Vlastní soubory:** `beast-g2/src/diagnostics.ts`, `beast-g2/server/sessions/http.mjs` (jen logování), `beast-g2/.github/workflows/ci.yml`, `beast-g2/docs/REVIEW.md`.

**Kritéria přijetí:** Logy obsahují ID relace, segmentu a jobu, ne text ani tokeny. CI běží testy, lint, prettier, build a coverage na Node 20 i 22. Nové testy pokrývají chybový stav a redakci logu.

**Mimo rozsah:** externí monitoring, alerting, tracing infrastruktura.

**Odhad:** S.

### I7.3 Retence a obnova

**Cíl:** Ověřit, že expirace, mazání a obnova ze zálohy opravdu fungují.

**Závisí na:** I7.1.

**Vlastní soubory:** `beast-g2/server/sessions/retention.mjs` (nový), `beast-g2/scripts/retention-check.mjs` (nový), `beast-g2/tests/retention.test.mjs` (nový), `beast-g2/docs/SESSIONS.md` (sekce Retence).

**Kritéria přijetí:** Test dokáže, že audio zmizí po přepisu nebo po 24 hodinách, relace po 30 dnech, a že smazaná ID zůstanou nedostupná i po obnově zálohy. Obnova ze zálohy použije seznam smazaných ID.

**Mimo rozsah:** forenzní mazání bloků, právní posouzení.

**Odhad:** M.

## 5. Vlny paralelní práce

Tabulka říká, co může běžet současně. Sdílené soubory v tabulce výše určují, kde vznikne konflikt.

| Vlna | Fáze | Proč spolu | Sdílené soubory |
| --- | --- | --- | --- |
| 0 | I4.0 | Blokuje I4.1 až I4.5, I5 a I6. | `http.mjs`, `db.mjs`, `session-api.ts`, `sessions.ts` |
| 0 | I3.1, I3.2, I7.1, I7.2 | Nemění kód ostatních fází, jen dokumentaci nebo vlastní skripty. | `docs/*`, `scripts/*` |
| 1 | I4.1, I4.4, I4.5, I7.1, I7.2 | Různé domény, po I4.0 bez konfliktu. | `src/main.ts` u I4.4 a I4.5 |
| 2 | I4.2, I4.3, I5.1, I7.3 | I4.2 staví na I4.1, I5.1 na I4.3. | `src/sessions/panels/*` |
| 3 | I5.2, I6.1 | I6.1 potřebuje I4.1 a I4.3. | `server/sessions/routes/*` |
| 4 | I5.3, I6.2, I6.3 | Poslední vrstvy nad hotovým základem. | `server/connectors/*` |

Pravidlo pro `src/main.ts`: v jedné vlně ho mění nejvýše jedna fáze. Když ho potřebují dvě, druhá počká na další vlnu nebo dostane vlastní malý slot.

## 6. Sdílené soubory a kontrakty

| Soubor | Vlastník | Pravidlo |
| --- | --- | --- |
| `server/sessions/http.mjs` | I4.0 | Po I4.0 se nemění; nové routy jdou do `routes/`. |
| `server/sessions/db.mjs` | I4.0 | Po I4.0 se nemění; migrace jdou do `migrations/`. |
| `src/session-api.ts` | I4.0 | Po I4.0 zůstává barrel, nové typy jdou do `src/session-api/`. |
| `src/sessions.ts` | I4.0 | Po I4.0 zůstává skořápka, panely jdou do `src/sessions/panels/`. |
| `src/main.ts` | integrační agent | Fáze ho mění jen v určeném slotu a hlásí diff. |
| `server/sessions/service.mjs` | I4.0 částečně, jinak vlastník domény | Nové domény mají vlastní soubor; service zůstává pro jádro relace. |
| `docs/SESSIONS.md` | průběžně | Každá fáze přidá jen svou sekci, konflikt řeší integrační agent. |

## 7. Rizika a rozhodovací body

| Riziko | Dopad | Jak se projeví | Kde se rozhoduje |
| --- | --- | --- | --- |
| Skutečný G2 mikrofon má jiné vlastnosti než simulátor. | Capture může ztrácet audio nebo mít jiné pauzy. | I3.1 změní parametry segmentace. | Po I3.1, před I4.4. |
| Kvalita souhrnů je nízká. | Paměť staví na chybných tvrzeních. | I3.2 vydá čísla, rozhodnutí o promptu nebo modelu. | Po I3.2. |
| FTS5 nezvládne české tvary. | Hledání bude nepoužitelné. | I4.1 změří a rozhodne o jednoduchém `LIKE` nebo externím indexu. | Po I4.1. |
| Paralelní fáze si rozbijí kontrakty. | Merge konflikty a rozbité UI. | I4.0 a pravidla vlastnictví. | Při každém merge. |
| Externí systém nemá read-only přístup. | Konektor nejde bezpečně použít. | I5.2 skončí s konkrétním důvodem. | Před I5.2. |
| Uživatel nepotvrdí retenci a data. | Nelze ukládat skutečné relace. | OQ-04 zůstává otevřené. | Před prvním reálným použitím. |

## 8. Mapování na požadavky

| Fáze | Požadavky |
| --- | --- |
| I3.1 | FR-03 (hardware část), FR-06, OQ-03 |
| I3.2 | FR-07, FR-08, cíle v Product_spec.md sekce 12 |
| I4.0 | žádné produktové požadavky, jen umožnění I4.1 až I6 |
| I4.1 | OQ-06, FR-01 (rozšíření), FR-09 (rozšíření) |
| I4.2 | FR-02 (dotazy nad přepisem), FR-07 (citace) |
| I4.3 | nové požadavky na paměť, které je potřeba doplnit do Product_spec.md před implementací |
| I4.4 | CR-10 (Captions jako malá iterace) |
| I4.5 | CR-10, sekce 10 |
| I5.1 | sekce 11 |
| I5.2 | OQ-08 |
| I5.3 | sekce 11 |
| I6.1 | sekce 11 |
| I6.2 | sekce 11 |
| I6.3 | sekce 11 |
| I7.1 | FR-10, sekce 9 |
| I7.2 | FR-06, sekce 12 |
| I7.3 | FR-09, sekce 9 |

## 9. Historie

- **1.1, 27. 10. 2026:** hotové I4.0a, I4.0b, I3.2 a I7.1; doplněn stav u fází a rozhodnutí o dalším postupu.
- **1.0, 27. 10. 2026:** první verze. Vychází ze stavu po I3, rozděluje I3 dokončení a etapy I4 až I7 na fáze, určuje vlny, vlastnictví souborů a rozhodovací body.
