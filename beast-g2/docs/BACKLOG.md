# Beast G2 — backlog dalších iterací

Aktualizováno: 27. října 2026. Výchozí verze: 0.5.0, PR #5 sloučen.
Stav níže uvedených položek: navrženo, neimplementováno/neověřeno, pokud není uvedeno jinak. Pořadí je návrh pro další iterace, nikoli závazný harmonogram.
Prováděcí členění na etapy a fáze pro paralelní práci agentů je v [ROADMAP.md](../../ROADMAP.md); tento backlog zůstává seznamem konkrétních položek.
Produktový rámec a priority z porovnání s IRIS jsou v [IRIS-COMPARISON.md](IRIS-COMPARISON.md). Tento backlog zůstává seznam konkrétních iterací.

## IRIS: srovnávací test a inspirace

### B1 · P1 · Porovnat IRIS a Beast G2 na skutečném hardwaru

- Stejné české věty: jména, čísla, odborné názvy, tichá řeč a hluk; alespoň 20 anotovaných nahrávek nebo opakovatelných promluv.
- Změřit chyby přepisu, latenci prvního přepisu, dokončení odpovědi a doručení hintu; sledovat ztracené odpovědi.
- Ověřit pět minut se zamčeným Androidem, přerušení/spojení BLE a obnovení relace. Zaznamenat telefon, verzi Even App, pluginu a konfiguraci modelů.
- Výstup: tabulka výsledků a konkrétní reprodukce. Oddělit vliv přepisu, modelu, sítě a displeje. Marketingová tvrzení IRIS nepovažovat za výsledky testu.

### B2 · P1 · Obnovitelná relace

- Zachovat přepis a dokončené hinty po přerušení nebo reloadu; nabídnout Resume / End session.
- Navrhnout opt-in lokální ukládání, omezení velikosti a doby uchování, export a smazání. Raw audio neukládat automaticky.
- Přijetí: restart aplikace obnoví správnou relaci bez duplicitních odpovědí; smazání odstraní i persistentní kopii. Mikrofon se po obnově nespustí bez vědomého spuštění uživatelem.
- Stav: I1 ukládá relace, segmenty, finální přepis, revize, mezery a export na serveru; I3 přidává klientské UI se seznamem, detailem a Resume/End a capture z G2 mikrofonu do stejného úložiště. Ověření na skutečném G2 zůstává.
- Samostatně ověřit běh se zamčeným telefonem; persistence sama nezajišťuje background listening.

### B3 · P2 · Méně / více nápověd během rozhovoru

- Ovládání četnosti kontextových hintů bez zastavení mikrofonu, včetně dočasné pauzy nápověd.
- Definovat minimální rozestup a potlačení opakovaných témat; příkazy uživatele a chyby nesmí zmizet v potlačených hintech.
- Výchozí chování je předmětem P1.1 v [IRIS-COMPARISON.md](IRIS-COMPARISON.md); Direct zachová odpověď na každou promluvu. B3 řeší regulaci uvnitř zvoleného režimu.
- Přijetí: změna četnosti za běhu neztratí přepis, nepřeruší poslech a nevyprázdní historii; jasně ukázat stav pauzy nápověd.

### B4 · P1 · Souhrn po skončení relace

- Na vyžádání vytvořit rozhodnutí, úkoly, otevřené otázky a krátký souhrn přes Beast.
- U úkolů uvádět vlastníka/termín pouze tehdy, když zazněl; chybějící údaje označit. Umožnit dohledat podklad v přepisu a opravit výsledek.
- Přijetí: exportovatelný souhrn; žádné automatické rozesílání nebo zakládání úkolů v externích službách.
- Stav: I2 implementuje souhrn vázaný na revizi přepisu, citace na konkrétní turny, kandidáty úkolů s explicitním vlastníkem/termínem nebo `null`, ruční opravu a export; I3 přidává klientské UI souhrnu včetně ruční opravy. Ověření kvality na reálném Beast zůstává.

### B4b · P1 · Preparation na další rozhovor

- Z vybraného minulého souhrnu sestavit kontext pro novou relaci: rozhodnutí, otevřené otázky, kandidáty úkolů a zdrojové citace.
- Preparation je neměnný snapshot; výběr jiného souhrnu vytvoří nový snapshot, nepřepíše starý.
- Přijetí: preparation nese zdrojovou relaci, datum, focus a citace; změna přepisu zdrojového souhrnu označí preparation jako stale.
- Stav: I2 implementuje API a uložení; I3 přidává klientské UI s výběrem zdrojového souhrnu, focusem a citacemi a krátký stavový řádek na brýlích. Ověření na hardwaru zůstává.

### B5 · P2 · Prověřit IRIS → Beast / Hermes jako alternativní klient

- Ověřit v aplikaci skutečnou cestu požadavků pro Other model a Hermes, podporovaný protokol, práci s klíčem a fallback.
- Kandidátní konfigurace: stávající Beast base URL s `/v1`, přesný alias `beast/big`; klíč nezapisovat do dokumentace.
- Dokumentace IRIS uvádí relay pro agent bridge. Interní Beast je dostupný jen přes firemní VPN; VPN na telefonu proto nemusí stačit. Dostupnost zatím neověřena.
- Zdokumentovat 12s limit průběžných agentních nápověd a přepnutí na IRIS; nesmí vzniknout mylný dojem, že odpověděl Beast.
- Před použitím posoudit cloud backup, quality review a přenos přihlašovacích údajů. Nevystavovat interní Beast veřejným tunelem jako automatický krok.
- Výstup: ověřená kompatibilita a datový tok, nebo konkrétní důvod nekompatibility. Agent bridge je podle dokumentace funkce Pro.

## Otevřené položky dosavadního vývoje

- **P1 · Skutečný streaming STT a přesnost:** potřebujeme dokumentovaný endpoint/protokol služby za `whisper-live`; HTTP preview není streaming STT. Změřit přesnost a přínos slovníku na korpusu B1.
- **P1 · Telefon v kapse:** ověřit zamčený Android, lifecycle, reconnect a delší poslech. Aktuální appka při skrytí capture pozastavuje.
- **P2 · Zprovoznit web gateway:** implementace je v 0.5.0; zbývá nasazení gateway s přístupem k Beastu i Internetu, serverový Brave klíč, přesná HTTPS adresa v whitelistu balíčku a živý integrační test. Dodaný build má pouze dosavadní Beast origin.
- **P2 · Diagnostika a CI:** navázat na otevřené R6/R7 v REVIEW.md; korelace celého tahu, odolnost diagnostiky při pádu a automatické test/build kontroly.

## Podklady

Zkontrolováno 25. října 2026; jde o dokumentaci dodavatele, nikoli nezávislé ověření funkčnosti:

- Funkce IRIS: https://www.eveniris.com/discover
- Agent bridge, Other model, relay a timeout: https://www.eveniris.com/agent
- Soukromí a nastavení uchování: https://www.eveniris.com/privacy
- Lokální stav: CONVERSATION.md, CONTINUOUS.md, WEB.md a REVIEW.md.
