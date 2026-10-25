# Audit Beast G2: bezpečnost a kvalita kódu

Datum: 25. 10. 2026. Verze: 0.5.0, commit `f254517`.
Rozsah: `beast-g2` klient, Even SDK adaptér, manuální a kontinuální režim, PCM/VAD, přepis a chat, brána, testy, balení, CI a dokumentace.
Metoda: čtení celého zdrojového kódu, spuštěné testy, měření pokrytí, statická analýza a čtyři spustitelné důkazy proti reálnému kódu. Nejde o penetrační test živého zařízení.

Doplňuje `REVIEW.md`, který řeší korektnost a provozní připravenost. Tento audit se soustředí na bezpečnostní plochu a kvalitu kódu.

## Co jsem ověřil

- `npm test`: 80/80 prošlo, 756 ms.
- `npx tsc --noEmit`: bez chyby, `strict` zapnutý.
- Pokrytí: 96,05 % řádků, 87,09 % větví, 90,56 % funkcí. `src/main.ts` v reportu vůbec není, protože ho žádný test neimportuje.
- Důkaz A1: kontinuální režim bez potvrzení doručení. Po čtyřech promluvách `unread = 3`, `reply id = 1`, po 1,5 s s `replyMs = 500` beze změny, po explicitní pauze `unread = 0`.
- Důkaz A2: 12 MB tělo odpovědi STT bylo přijato a zpracováno, HTTP 200, text měl 2 znaky.
- Důkaz A4: `options.redirect` je u chatu a STT `undefined`, u hledání `error`.
- Důkaz A5: při `DEMO_MODE=1` a exportovaném `GATEWAY_TOKEN` použije brána tento token, ne `local-demo-token-only`.
- Důkaz C1: chybějící `BEAST_CHAT_URL` vyhodí `TypeError: Invalid URL`; `PORT=abc` dá `NaN`; `ALLOWED_ORIGINS` s lomítkem zůstane `["http://localhost:5173/"]`.

## Co jsem neověřil

- Živé brýle G2, živý Beast, skutečný provider a chování při zamčeném telefonu. Bez hardwaru to nejde.
- Reálný dopad A1 na brýlích. Důkaz je na úrovni controlleru a `LatestDisplay`, ne na BLE.
- Výkon, baterii a latenci.
- CodeQL hlásí 0 nálezů pro JavaScript a TypeScript. Nekryje runtime, konfiguraci ani závislosti.

## Souhrn

| ID | Priorita | Oblast | Nález |
| --- | --- | --- | --- |
| A1 | P1 | Dostupnost | Kontinuální režim se zasekne, když brýle nikdy nepotvrdí doručení hintu |
| A2 | P1 | Odolnost | Odpověď STT se čte bez limitu velikosti |
| A3 | P1 | Diagnostika | Export diagnostiky hlásí verzi 0.4.0 místo 0.5.0 |
| A4 | P2 | Bezpečnost | Chat a STT následují redirecty, hledání ne |
| A5 | P2 | Bezpečnost | Demo režim přebírá exportovaný `GATEWAY_TOKEN` |
| A6 | P2 | Bezpečnost | HTTP na LAN posílá token v otevřeném textu bez varování |
| A7 | P2 | Bezpečnost | Brána nemá žádný rate limit |
| Q1 | P2 | Testy | `src/main.ts` nemá test ani pokrytí |
| Q2 | P2 | Testy | Živá cesta STT nemá test |
| Q3 | P2 | Kvalita | Duplikace transportní logiky mezi `api.ts` a `beast.ts` |
| Q4 | P3 | Kvalita | `gateway.mjs` má řádky přes 900 znaků |
| Q5 | P3 | Kvalita | Chybí linter a formátter |
| T1 | P3 | CI | CI neměří pokrytí ani nestanovuje práh |
| T2 | P3 | CI | CI nespouští `npm audit` |
| T3 | P3 | CI | Actions nejsou pinnuté na SHA |
| C1 | P3 | Konfigurace | Konfigurace nemá validaci vstupů |
| C2 | P3 | UI | Několik slepých uliček v ovládání |
| D1 | P3 | Dokumentace | `SECURITY.md` tvrdí „no persistence", ale nastavení se ukládá |
| D2 | P3 | Manifest | `supported_languages` obsahuje jen `en` |
| D3 | P3 | Dokumentace | `docs/` nemá rozcestník a míchá aktuální a historické soubory |

## Nálezy

### A1 · P1 · Kontinuální režim se zasekne bez potvrzení doručení

Místo: `src/continuous.ts:69-75` (`acknowledgeHint`), `src/continuous.ts:63-68` (`showReply`), `src/continuous.ts:128` (backpressure), `src/display.ts:39-47` (retry a dispose), `src/main.ts:171` (callback `failed`).

`showReply` nastaví `reply`, ale `hintStarted` zůstane `undefined`, dokud nepřijde potvrzení z brýlí. `tickHint` proto nic neudělá, hint neexpiruje a `replies` se naplní na tři. `drain` pak čeká na `hintSpace`, který se uvolní jen v `showReply` nebo v `pause`. Když `LatestDisplay` po timeoutu zavolá `dispose`, žádné potvrzení už nepřijde. Výsledek: mikrofon dál běží, ale nové hinty se přestanou doručovat, dokud uživatel explicitně nepauzne nebo neopustí plugin.

Dopad: přesně selhání, které projekt řeší, tedy „poslouchám, ale nic nevidím". Není to pád, ale tichá ztráta funkce.

Návrh: v `main.ts` při `failed` z displeje zavolat `continuous.pause(true, 'Displej nedostupný, poslech pozastaven.')`. V `showReply` přidat pojistku na potvrzení, například 5 s, po které se hint považuje za nedoručený, zvýší se `repliesDropped` a pipeline postoupí. Přidat test, který simuluje chybějící potvrzení a ověří, že se stav nezasekne.

### A2 · P1 · Odpověď STT se čte bez limitu velikosti

Místo: `server/gateway.mjs:96`.

`const result = await response.json()` načte celé tělo odpovědi do paměti. Chat je přitom pečlivě omezený na 12 000 znaků a 1 MB rámec, `web.mjs` omezuje odpověď na 256 KB. STT cesta nemá nic. Důkaz: 12 MB tělo s krátkým `text` vrátilo HTTP 200 a bylo celé zpracováno.

Dopad: chybně nakonfigurovaný nebo kompromitovaný provider endpoint může alokovat libovolné množství paměti. Při více požadavcích to shodí proces. Jde o nekonzistenci s ostatními cestami, ne o chybu, kterou by šlo zneužít bez tokenu.

Návrh: číst tělo s pevným limitem, například 1 MB, stejně jako `web.mjs`, a potom parsovat. Překročení vrátit jako 502 `invalid_transcription`. Přidat test s 2MB tělem.

### A3 · P1 · Export diagnostiky hlásí špatnou verzi

Místo: `src/diagnostics.ts:34`, `package.json:3`, `app.json:5`, `src/main.ts:13`.

Export má `version: '0.4.0'`, package.json a manifest mají `0.5.0`, hlavička v UI má `0.5.0` natvrdo. Diagnostika z buildu 0.5.0 tedy tvrdí, že je 0.4.0.

Dopad: při hlášení chyby se podporuje špatná verze a rozbor se zdrží. Podkopává to důvěryhodnost celého diagnostického exportu.

Návrh: jedno zdrojové místo. Importovat `version` z `package.json` přes `resolveJsonModule`, použít ji v `diagnostics.ts` i v hlavičce `main.ts`. Test, že export neobsahuje natvrdo zapsanou verzi.

### A4 · P2 · Chat a STT následují redirecty, hledání ne

Místo: `server/gateway.mjs:58-66` a `server/gateway.mjs:111`, srovnej s `server/web.mjs:7`.

`upstream()` předává `options` bez `redirect`. Výchozí chování `fetch` je `follow`. `searchWeb` má `redirect: 'error'`. Důkaz: u chatu je `options.redirect` `undefined`, u hledání `error`.

Dopad: kompromitovaný nebo špatně nastavený provider může přesměrovat požadavek na jiný host. Při změně originu undici `Authorization` odstraní, při stejném originu ho ponechá. Pořád jde o požadavek na cizí host s tělem konverzace.

Návrh: `redirect: 'error'` v `upstream()` pro chat i STT. Přidat test, který ověří `options.redirect === 'error'` u obou cest.

### A5 · P2 · Demo režim přebírá exportovaný token

Místo: `server/gateway.mjs:9`.

`const token = env.GATEWAY_TOKEN || (demo ? 'local-demo-token-only' : '')`. Když má operátor `GATEWAY_TOKEN` exportovaný v shellu, demo použije tento token. Tlačítko „Use local demo" v UI posílá natvrdo `local-demo-token-only`, takže dostane 401.

Dopad: demo přestane fungovat přesně u toho, kdo ho potřebuje nejvíc, tedy u vývojáře s nastaveným prostředím. Matoucí chyba, ne bezpečnostní díra.

Návrh: v demo režimu vždy použít pevný demo token a `GATEWAY_TOKEN` ignorovat. Přidat test.

### A6 · P2 · HTTP na LAN posílá token v otevřeném textu

Místo: `src/api.ts:11`, `src/main.ts:22`.

`gatewayUrl` povolí `http:` pro localhost a RFC1918 adresy. To je rozumné pro vývoj, ale v balené aplikaci to znamená, že token i celý dotaz jdou po Wi-Fi v otevřeném textu. UI na to neupozorní, text říká jen „Use HTTPS, or HTTP on a local development network."

Dopad: na sdílené Wi-Fi může kdokoli na stejné síti odečíst token a obsah dotazů.

Návrh: při `transport === 'gateway'` a `http:` mimo loopback zobrazit v `connection` varování. Volitelně HTTP mimo loopback v produkčním buildu odmítnout. Přidat čistou funkci `isInsecureGateway(url)` a test.

### A7 · P2 · Brána nemá rate limit

Místo: `server/gateway.mjs:83`.

`active >= 2` omezuje souběžnost, ale ne počet požadavků v čase. Kdokoli s tokenem může spálit kvótu providera nebo držet oba sloty dvěma dlouhými požadavky.

Dopad: zneužití tokenu, ať už uniklého nebo opsaného, je levné. Pro osobní bránu jde o nízké riziko, pro tunelově vystavenou bránu o reálné.

Návrh: jednoduchý token bucket v paměti, například 20 požadavků za minutu na token, 429 s `Retry-After`. Bez závislosti, přidat test.

### Q1 · P2 · `src/main.ts` nemá test ani pokrytí

Místo: `src/main.ts`, 211 řádků.

Pokrytí ho vůbec neuvádí, protože ho žádný test neimportuje. Přitom obsahuje veškeré propojení: přepínání režimů, aplikaci nastavení, render historie, ovládání tlačítek a lifecycle. Chyby v této vrstvě odhalí až hardware.

Dopad: největší soubor je nejméně ověřený. Regrese se projeví až na brýlích.

Návrh: vytáhnout čisté funkce (`busyState`, `historyLabel`, `connectionMessage`, `modeSwitchAllowed`) do `src/view.ts` a otestovat je. DOM propojení nechat bez testu, ale zmenšit. Volitelně přidat `happy-dom` jako dev závislost a smoke test.

### Q2 · P2 · Živá cesta STT nemá test

Místo: `server/gateway.mjs:14-19`, `94-95`, `97-98`.

Pokrytí ukazuje nepokryté právě tyto řádky: validace konfigurace a úspěšná živá transkripce. Testy pokrývají jen demo STT. Přitom živá STT cesta je ta, která se používá v provozu.

Dopad: chyba v multipartu, modelu nebo jazyce se projeví až s reálným providerem.

Návrh: test s falešným `fetch`, který vrátí `{text:'Ahoj'}`, a kontrola multipart polí `model`, `language`, `file`. Druhý test s `text` delším než 4000 znaků očekává 502. Tím se pokrytí `gateway.mjs` dostane na 100 %.

### Q3 · P2 · Duplikace transportní logiky

Místo: `src/api.ts:16-35` a `src/beast.ts:10-25`, dále `src/api.ts:44-70` a `src/beast.ts:44-70`.

Oba klienti mají stejnou kostru: timeout, propojení abort signálů, hlavička `Authorization`, mapování chyb, čtení streamu. Liší se jen formátem (NDJSON vs SSE) a kontraktem chyb. Dvě kopie znamenají, že oprava v jedné snadno zapomene na druhou.

Dopad: údržba a riziko rozdílného chování mezi přímým a gateway režimem.

Návrh: `src/transport.ts` s `withDeadline`, `readNdjson` a `readSse`. Protokolová validace zůstane v klientech. Refaktorovat po A4, ne před ním, aby se nemíchaly změny chování a struktury.

### Q4 · P3 · `gateway.mjs` má nečitelné dlouhé řádky

Místo: `server/gateway.mjs:11`, `33`, `41`, `95`, `111`, `113`.

Řádek 11 má přes 1000 znaků, `validateWav` je jeden boolean výraz na 700 znaků, `send` má 900 znaků. V takovém výrazu chybí podmínka snadno.

Dopad: review diffu je pomalý a náchylný k přehlédnutí.

Návrh: `parseWavHeader` vracející typovaný výsledek, `buildMessages`, `sendEvent`. Beze změny chování, testy zůstanou zelené.

### Q5 · P3 · Chybí linter a formátter

Místo: repo root.

`tsc --noEmit` hlídá typy, ne floating promises, nepoužité parametry v runtime ani konzistenci stylu. `noUnusedLocals` je zapnutý, ale např. `void promise` nebo zapomenutý `await` neodhalí.

Návrh: ESLint flat config s `typescript-eslint` a `no-floating-promises`, Prettier. Spustit v CI. Pozor: první běh odhalí reálné nálezy, které bude potřeba opravit, ne jen potlačit.

### T1 · P3 · CI neměří pokrytí

Místo: `.github/workflows/ci.yml:46-50`.

CI spouští testy a build, ale ne pokrytí. Pokrytí je dnes 96 %, ale nic nebrání tomu, aby spadlo.

Návrh: samostatný job na Node 22 s `--experimental-test-coverage` a prahem, například 90 % řádků a 80 % větví. Node 20.18 prahy nepodporuje, proto jen v jednom jobu.

### T2 · P3 · CI nespouští `npm audit`

Místo: `.github/workflows/ci.yml:43-50`.

`npm ci` nehlásí zranitelné závislosti. Přitom běží životní cyklus skriptů závislostí.

Návrh: `npm audit --omit=dev --audit-level=high` po instalaci. Runtime závislost je jedna, šum bude nízký.

### T3 · P3 · Actions nejsou pinnuté na SHA

Místo: `.github/workflows/ci.yml:32`, `37`, `.github/workflows/codeql.yml:30`, `35`, `42`.

`@v7` a `@v4` jsou pohyblivé tagy. CodeQL job má `security-events: write`.

Návrh: pinnout na commit SHA s komentářem verze, aktualizovat Dependabotem. Pro osobní repo nízká priorita, pro veřejné repo standard.

### C1 · P3 · Konfigurace nemá validaci vstupů

Místo: `server/gateway.mjs:15-18`, `server/index.mjs:4`, `server/gateway.mjs:11`.

- Chybějící `BEAST_CHAT_URL` vyhodí `TypeError: Invalid URL`, ne „Set BEAST_CHAT_URL".
- `PORT=abc` dá `NaN` a `listen(NaN)` selže nesrozumitelně.
- `ALLOWED_ORIGINS` s lomítkem na konci tiše odmítne správný origin.
- `HOST=0.0.0.0` bez TLS nemá varování.

Dopad: operátor tráví čas hledáním chyby v konfiguraci, ne v aplikaci. U posledního bodu jde i o bezpečnost.

Návrh: validovat přítomnost a tvar URL, `Number.isInteger(port)`, normalizovat originy a odmítnout cestu, query a fragment. Přidat varování při ne-loopback `HOST` bez TLS. Testy pro každý případ.

### C2 · P3 · Slepé uličky v ovládání

Místo: `src/main.ts:154`, `src/main.ts:110`, `src/main.ts:106`.

- Odeslání textového dotazu v kontinuálním režimu tiše nic neudělá, protože formulář je povolený jen v manuálním režimu.
- Sekce „Continuous hint history" je v manuálním režimu prázdná, protože čte archiv kontinuálního režimu.
- Přepnutí režimu při neznámém stavu mikrofonu se odmítne bez vysvětlení, dokud se nepovede pauza.

Dopad: uživatel neví, proč se nic nestalo.

Návrh: formulář v kontinuálním režimu zakázat nebo zobrazit „přepni na manuální režim". Historii v manuálním režimu skrýt nebo přejmenovat. Při blokovaném přepnutí zobrazit důvod a nabídnout pauzu.

### D1 · P3 · `SECURITY.md` tvrdí „no persistence"

Místo: `SECURITY.md`, `src/main.ts:88`.

`localStorage` ukládá gateway URL, jazyky, transport, názvy modelů a `sttPrompt`. Token ne, to je pravda. Ale „no persistence" je nepřesné a `sttPrompt` může obsahovat jména.

Návrh: upravit formulaci: „No conversation, audio or token is persisted. UI preferences, including optional vocabulary, are stored in the WebView's localStorage." Doplnit přímý Beast klíč do rozsahu.

### D2 · P3 · `supported_languages` obsahuje jen `en`

Místo: `app.json:9-11`.

Aplikace je česky první, UI je česky, ale manifest nabízí jen angličtinu.

Návrh: doplnit `cs`, pokud pole řídí nabídku v obchodě. Ověřit význam pole v dokumentaci Even, ne hádat.

### D3 · P3 · `docs/` nemá rozcestník

Místo: `beast-g2/docs/`.

Jedenáct souborů, část historická, část aktuální. Nový čtenář nepozná, co platí.

Návrh: `docs/README.md` s tabulkou soubor, stav (aktuální nebo historický), téma. Historické přesunout do `docs/archive/`. Není potřeba mazat, jen označit.

## Co je v pořádku

- Ověření tokenu je před routingem, `timingSafeEqual`, bez early return na obsahu.
- CORS má allowlist, `Vary: Origin`, žádné credentials, `no-store` a `nosniff`.
- WAV validace je přesná: mono, 16 kHz, PCM16, 30 s, konzistentní velikosti chunků.
- Tělo požadavku má limit, chat má limit 120 000 B, audio 960 044 B.
- Chat stream má limit 1 MB na rámec, 12 000 znaků na odpověď, timeout a abort.
- Chybová odpověď providera nevrací jeho tělo, jen stage, status a request ID.
- Prompt injection z webu je řešená jako nedůvěryhodná data v uživatelské zprávě, ne v system promptu.
- Hledání má pevný host, `redirect: 'error'`, limit 256 KB a validaci URL.
- Diagnostika má allowlist polí, žádný obsah, žádné klíče, žádné URL, kruhový buffer 400.
- Token není v `localStorage`, pole je `type="password"` s `autocomplete="off"`.
- UI používá `textContent`, odkazy mají `rel="noopener noreferrer"`.
- Testy pokrývají VAD, frontu, backpressure, pozdní promise, timeout displeje a SDK serializaci.
- `private: true`, `engines`, `.nvmrc`, lockfile a CI matrix 20.18 a 22 jsou v pořádku.

## Plán

1. P1 před dalším testem na hardwaru: A1, A2, A3. Odhad 2 hodiny.
2. P2 bezpečnostní hardening: A4, A5, A6, A7, C1. Odhad 2 hodiny.
3. Testy: Q2, Q1. Odhad 3 hodiny.
4. Kvalita: Q4, Q3. Odhad 2 hodiny, bez změny chování.
5. CI a hygiena: T1, T2, T3, Q5, D1, D2, D3. Odhad 2 hodiny.

A1 a A2 jsou malé změny. A3 je triviální. A4 je jeden řádek. A5 je jedna podmínka. C1 je validace na začátku, která se snadno testuje.

## Ověřovací příkazy

```
cd beast-g2
npm test
npx tsc --noEmit
node --import tsx --test --experimental-test-coverage tests/*.test.ts tests/*.test.mjs
node ~/.hermes/cache/scratch/audit-gateway.mjs
node --import tsx ~/.hermes/cache/scratch/audit-continuous.ts
```

Skripty jsou v scratchi, ne v repu. Po opravách je přesunu do `tests/` jako regresní testy.
