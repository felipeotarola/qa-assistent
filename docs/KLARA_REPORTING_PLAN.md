# Plan för Klaras uppdragsöversikt och rapporter

Status: Implementerad och lokalt verifierad 2026-10-04. Se [implementation och drift](KLARA_REPORTING.md) för den levererade utformningen, genomförda kontroller och begränsningar. Detta dokument är den ursprungliga planen och bekräftar inte produktionsdrift.

V ska planera, delegera och följa upp arbetet. Klara ska ha en samlad, spårbar bild av uppdraget, granska slutsatser och skriva rapporter med testresultat, källor, tabeller, grafer och diagram. Användaren ska kunna fortsätta prata med V medan Klara arbetar.

Vi bygger ett gemensamt uppdragsunderlag ovanpå befintlig lagring. Testkörningar, VPS-jobb och Material behåller sina ordinarie lagringsplatser. Adaptrar sammanställer deras resultat i ett gemensamt format. Första leveransen ska omfatta både tester och annat arbete.

Rapporter ska från första leveransen kunna delas utan att mottagaren har ett konto: privat med pinkod eller publikt utan pinkod. Delningen är separat från workspace-åtkomsten och avser en uttryckligen vald rapportversion.

## Ansvar och produktbeteende

| Del | Ansvar |
| --- | --- |
| V | Tolka målet, skapa uppdrag och deluppgifter, delegera, hantera beslut och kompletteringar. |
| Iris, Axel och Otto | Utföra avgränsade uppgifter och lämna resultat med underlag och begränsningar. Samma kontrakt gäller när V själv använder ett verktyg. |
| Systemets sammanställning | Koppla data till rätt uppdrag, kontrollera åtkomst och versioner, beräkna statistik och skapa en sparad lägesbild. |
| Klara | Granska påståenden mot underlag, beskriva helheten, förklara luckor och skapa rapporten. |
| V efter rapporten | Presentera en kort status och rapportlänk samt föreslå eller beställa nästa arbete inom användarens uppdrag. |

Klara har två arbetssätt bakom samma identitet: den befintliga avgränsade testgranskningen och den nya uppdragsrapporteringen. Rapportering får begränsade läsverktyg och möjlighet att lämna strukturerade rapportutkast. Testgranskningen fortsätter utan verktyg. Klara startar inte nya tester, ändrar inte uppdragets krav och publicerar inte själv till Linear eller andra externa system.

Tre saker lagras och visas separat:

- **Arbetsstatus:** exempelvis köat, pågår, avslutat, misslyckat eller avbrutet.
- **Rapporterat målutfall:** uppnått, delvis uppnått, blockerat eller okänt.
- **Granskningsbedömning:** underbyggt, behöver kompletteras eller motsägs av underlaget; dessutom kan granskning saknas eller pågå.

Exempel: Otto avslutar sin uppgift och rapporterar HTTP 500. Rapporten kan vara underbyggd, samtidigt som målet att få en fungerande testmiljö är blockerat. Ett tomt arbetsflöde eller en avslutad process räcker aldrig för att ange att målet är uppnått.

## Nuläge att bygga vidare på

| Källa i repot | Vad som redan finns | Vad som behöver tillkomma |
| --- | --- | --- |
| `shared/test-run.ts`, `server/utils/test-runs.ts` | Versionsbundna testfall, körningar, observationer och underlagsreferenser. Lokal ändring köar granskning efter avslut och ger V åtgärden `assess`. | Koppling till uppdrag och deluppgift; gemensamt resultatformat. |
| `shared/result-assessment.ts`, `server/utils/result-assessments.ts`, `result-review-worker.ts` | Separat testgranskning, sparad input, innehållshashar, begränsade omförsök och återhämtning. Kräver idag en avslutad testkörning. | Uppdragsrapport med bredare underlag, utan att försvaga den befintliga testgranskningen. |
| `server/db/schema/browser-jobs.ts` | Iris jobbstatus och textrapport, kopplade till chatt och runtime. | Strukturerade påståenden och underlag från uppgiften. En textrapport räcker inte som oberoende bevis. |
| `server/db/schema/project-environments.ts`, `server/utils/setup-jobs.ts` | Ottos beständiga jobb, startplan, miljöresultat och återrapportering. | Uppdragskoppling och sparade observationer med ursprung, exempelvis faktiska HTTP-kontroller och sanerade loggar. |
| `server/db/schema/repositories.ts`, `server/utils/repositories.ts` | Avgränsade repokörningar och jobbresultat. Repokartor använder också setup-flödet. | Gemensamma resultatreferenser för både dessa jobbvägar, utan dubbelräkning av Axel och Ottos gemensamma arbete. |
| `server/utils/research.ts` | Renderad sidtext, URL, hämtningstid, HTTP-status och valfri sparad skärmbild. | Spara ett begränsat källutdrag även utan skärmbild. Text som bara returneras till chatten är inte tillräcklig rapportlagring. |
| `server/db/schema/workspaces.ts`, `evidence.ts`, `shared/workspace.ts` | Versionshanterat Material, källreferenser, text, bilder, tabeller och stapeldiagram. | Rapportmetadata och bindning mellan rapportblock och verifierbara källor eller beräkningar. |
| `shared/quality.ts` | Projektioner för testresultat, kompatibla mål och versionsskillnader. | Återanvänd reglerna för uppdragets avgränsade urval och rapportens statistik. |
| `server/db/schema/chat-history.ts` | Sparade chatthändelser. | Använd utvalda meddelanden som mål och kontext, aldrig som automatisk ersättning för körningsunderlag. |

Det finns inte ett gemensamt, beständigt resultatkontrakt för allt detta idag. Att återanvända befintliga tabeller innebär därför också att komplettera de flöden som saknar sparat underlag.

## Uppdrag och gemensamt resultatformat

Ett uppdrag är en avgränsad beställning inom ett workspace. Det kan omfatta flera chattar och agentjobb. En chatt är en kommunikationsyta, inte uppdragets identitet. Ett workspace kan innehålla flera samtidiga uppdrag som inte får blandas ihop.

V skapar uppdraget före delegering: mål, avgränsning, kriterier för färdigt arbete, önskat testobjekt och vilka testfall som ingår när det är känt. Ändringar av målet sparas som en ny revision med hänvisning till användarens beslut. Önskad version hålls åtskild från faktiskt observerad version.

`missionId` och `taskId` följer verktygsanrop, underjobb och callbacks. En serverkontrollerad koppling mellan jobb-ID och deluppgift är källa för callbacks; workern får inte välja ett godtyckligt workspace. När Axel delegerar till Otto blir Ottos jobb ett barn till samma deluppgift eller en explicit underuppgift, inte ett fristående dubbelräknat resultat.

Äldre jobb utan uppdragskoppling fortsätter att fungera. De kan kopplas in uttryckligen med dokumenterad källa. Vi gissar inte tillhörighet utifrån liknande namn eller närhet i tid. När flera uppdrag finns i en chatt måste V eller användaren välja det avsedda uppdraget.

Föreslaget gemensamt kontrakt `WorkResultV1`:

| Fält | Innehåll och regel |
| --- | --- |
| Identitet | `schemaVersion`, `resultId`, `missionId`, `taskId`, `attemptId`, `workspaceId`, `runtime`, agentidentitet och föräldrauppgift. |
| Källa | Typ av jobb, ursprungligt jobb-ID, källrevision och serverregistrerad producent. |
| Uppgift | Syfte, typ såsom test, research, miljöstart eller kodanalys och referenser till uppdragets kriterier. |
| Kontext | Repo, URL, observerad miljö, version/commit och start/sluttid. Okända värden förblir okända. |
| Utförande | Arbetsstatus, utförda åtgärder och vad utföraren rapporterar som målutfall. |
| Påståenden | Stabila ID:n, påståendet i text och referenser till kriterier och underlag. Markerat som rapporterat, inte automatiskt verifierat. |
| Observationer | Vad verktyget faktiskt observerade, av vem, när och på vilket objekt. Agentens sammanfattning lagras separat från verktygsobservationen. |
| Underlag | Referens, version/hash, ursprung, åtkomstklass, tidpunkt och begränsningar. Varje referens måste kunna lösas inom rätt workspace. |
| Luckor | Blockerare, ej utfört, antaganden, motstridiga observationer och föreslagna kompletteringar. |

Typade tillägg behåller skillnaderna: testresultat med kontrollpunkter; miljöstart med kommando, process och HTTP-probe; research med källutdrag och hämtningstid; kodanalys med commit, fil och radreferenser. Modellen får inte själv ange att en observation är systemverifierad. Adaptern sätter ursprung från den faktiska insamlingsvägen.

## Lagring och sammanställning till Klara

Föreslagna nya tabeller följer repots `pat_`-prefix och befintliga ägarkontroller:

| Tabell | Syfte |
| --- | --- |
| `pat_missions` | Mål, omfattning, kriterier, ägare, workspace, ursprungschatt och separat revision för rapportunderlaget. |
| `pat_mission_tasks` | Deluppgifter, beroenden och länkar till faktiska jobb/körningar inklusive försök. Senaste arbetsstatus är en projektion från källhändelser. |
| `pat_mission_events` | Oföränderliga händelser om beställning, status, resultat, kriterieändringar och granskningar. Slutresultathändelser bär `WorkResultV1`; råa loggar kopieras inte hit. |
| `pat_mission_snapshots` | Sparad lägesbild med uppdragsrevision, avgränsning, källmanifest, beräknade mått och innehållshash. |
| `pat_mission_reports` | Beställd rapport per snapshot, jobblivscykel, modell/mallversion, läskvitton, validerat rapportinnehåll och länk till exakt Material-version. |
| `pat_report_shares` | Ägare, rapportversion, slumpmässig delningsidentifierare, delningsläge, hashad pinkod vid privat delning, tillåtna bilagor, giltighetstid och återkallningsrevision. |
| `pat_report_share_sessions` | Tidsbegränsade åtkomstbevis efter godkänd pinkod, bundna till en delning och dess återkallningsrevision. Inget appkonto skapas. |

Fullständigt underlag lagras i befintligt Material/privat fillagring. Rapporter visar både referenserna och begränsningar i vad Klara kunnat läsa. Modellåtkomst kontrolleras också vid varje läsning; borttaget eller återkallat underlag får inte återexponeras från en gammal snapshot. Historik behålls enligt produktens raderingsregler, inte som ett undantag från dem.

En adapter per källa översätter till det gemensamma formatet. Databasresultat och händelse sparas i samma transaktion där det går. Externa VPS-resultat tas emot idempotent och kopplas via serverns jobbregistrering. En återhämtningskörning jämför registrerade jobb med mottagna resultat och återhämtar saknade händelser utan att starta om själva arbetet.

Dubbletter stoppas med unik källnyckel, exempelvis `(runtime, sourceType, sourceId, sourceRevision, eventType)`. Sena händelser bevaras men får inte skriva över ett nyare försök eller backa status. Föränderliga externa källor behöver en monoton revision eller ett nytt försök-ID; enbart ankomsttid duger inte för ordning.

### Ett versionsbestämt paket

Servern bygger `MissionSnapshotV1` i en konsekvent databasläsning från de lokalt sparade händelserna. Paketet innehåller:

1. Mål, omfattning, kriterierevision och det uttryckliga testurvalet.
2. Uppgiftsträd med senaste kända status, försök, beroenden och källornas senast observerade tid.
3. Normaliserade resultat och ännu obesvarade kriterier.
4. Källmanifest med referenser till fördjupat underlag.
5. Befintliga testgranskningar, manuella bedömningar och deras giltighet för aktuell källa.
6. Kodberäknad statistik med urval, måttdefinitioner och källor.
7. Blockerare, konflikter, saknade uppgifter och vad som fortfarande pågår.

Klara får hela översikten och kan hämta underlag i delar. Läsningarna är bundna till samma snapshot och sparas som läskvitton med version/hash. För stora filer hanteras med tydliga, begränsade utdrag och sidindelning; avklippt eller oläst innehåll får aldrig framställas som fullständigt granskat.

Senare händelser skapar en ny underlagsrevision. En rapport som slutförs för en äldre snapshot sparas som historisk och markeras att den inte omfattar de nya händelserna. Den får inte ersätta länken till en nyare rapport. Vi lovar inte att en rapport innehåller externa händelser som ännu inte har nått systemet: källornas färskhet visas uttryckligt.

### Statistik som kan kontrolleras

Statistik beräknas i kod från den frysta avgränsningen. Återanvänd och vid behov extrahera regler från `shared/quality.ts` i stället för att skapa en konkurrerande definition av godkänt.

- Visa antal testfall och antal körningsförsök separat. Ett omtest ger inte ett nytt testfall.
- Utgå från valda testfall, inklusive dem som aldrig startades. Okänt urval ger inget påhittat totalantal.
- Använd senaste kompatibla försök för samma fall, definition och testobjekt. Ett nytt pågående försök ska inte visas som färdigt utifrån ett tidigare godkänt försök.
- Blandade miljöer och versioner får egna grupper. Saknad version markeras som okänd och jämförs inte tyst med en känd version.
- Visa rapporterat utfall och granskningsstatus separat. Ett rapporterat godkännande med saknad granskning är inte ett granskat godkännande.
- Manuella bedömningar visas med avsändare och orsak; de ändrar inte historiska originalresultat.
- Grafer binder till ett `metricId` och samma snapshots beräknade data. Klara väljer graf och förklaring, inte siffervärdena.

## Klaras rapportjobb och verktyg

Utöka den befintliga modellen med en separat, beständig rapportkö. Behåll testgranskarens kö och kontrakt så att migrationen inte kräver att gamla bedömningar skrivs om. Återanvänd mekanismer för leasing, avgränsade omförsök, runtime-isolering och sparad input. En stor rapport får inte hindra alla korta testgranskningar.

Första implementationen använder en avgränsad AI SDK-agent bakom rapportkön. Den behöver inte bli ett synkront Eve-subagentanrop som håller V upptagen. Eve används för beställning och deduplicerad återkoppling samt schemalagd återhämtning. Om Klara senare blir en deklarerad Eve-specialist måste standardverktyg, sandbox, minne och anslutningar uttryckligen begränsas enligt den installerade Eve-versionen.

| Föreslagen förmåga | Tillåtet innehåll |
| --- | --- |
| `read_mission_snapshot` | Läsa översikt och sidindelade deluppgifter i jobbets bundna snapshot. |
| `read_mission_evidence` | Läsa tillåtna underlagsreferenser ur manifestet, med begränsad storlek och läskvitto. |
| `read_mission_assessments` | Läsa relevanta testgranskningar och tidigare separata bedömningar. En tidigare rapport är kontext, inte ett nytt oberoende bevis. |
| `prepare_report_visual` | Välja en stödd visualisering från kodberäknade mått eller en lista av källbundna noder och relationer. |
| Strukturerat slutresultat | Lämna rapportavsnitt, citerade påståenden och kompletteringsbehov. Servern validerar och sparar till Material. |

Verktygens uppdrag, ägare, runtime och snapshot binds av servern, inte av modellens argument. Klara får inga godtyckliga HTTP-anrop, browserkommandon, terminalverktyg, Vault-värden eller rätt att skapa nya utförarjobb. Loggar och källor behandlas som opålitliga data. Skrivning till Material sker genom en avgränsad rapporttjänst, inte allmän behörighet att ändra arbetsytan.

V får `mission`-åtgärder för skapa/läsa/uppdatera och knyta deluppgifter, samt `report`-åtgärder för beställa, läsa status och hämta sparad rapport. Verktygsnamn och actions låses när kontrakten implementeras; detta är den avsedda ansvarsfördelningen.

### När rapporten uppdateras

- Användaren eller V kan beställa en rapport under pågående arbete. Den märks som delrapport och visar vad som återstår.
- En blockerare eller avslutad deluppgift gör rapportunderlaget inaktuellt. Händelser inom 60 sekunder samlas till en automatisk uppdatering.
- Ingen modell körs för varje verktygsanrop eller varje loggrad. Efter fem minuter med kontinuerliga relevanta ändringar får en delrapport skapas; därefter används samma begränsning igen.
- Högst ett aktivt rapportjobb per uppdrag. Nya händelser under arbetet skapar högst en efterföljande beställning för senaste revisionen.
- Slutrapport kan skrivas när V avslutat uppdraget och systemet inte ser aktiva deluppgifter. Blockerat eller delvis uppnått är giltiga slututfall. Väntande testgranskningar anges; en rapport kallas inte färdiggranskad innan de är klara.
- Själva rapportskrivningen är ingen ny källhändelse som startar nästa rapport. Sammanfattningar av sparade rapporter startar inga omtester eller ny modellgranskning.

Startvärden för rapportjobbet: högst tre försök vid övergående fel, 150 sekunders arbetsbudget per försök, 240 sekunders lease och högst åtta modellsteg. Underlagsläsning och antal verktygsanrop begränsas dessutom i kod. Gränserna ska verifieras mot verkliga rapporter; ett nått tak ger en uttrycklig begränsning eller ett misslyckat jobb, inte ett påhittat fullständigt resultat.

Rapportpublicering till Material och jobbfärdigställande ska vara idempotenta. Unik nyckel omfattar uppdrag, snapshot, runtime, mallversion och författarversion. Återkoppling till rätt chatt innehåller sparad kortsammanfattning och rapportlänk. Vid osäker chattleverans ska UI fortfarande visa rapporten utan att starta jobbet på nytt.

## Rapportformat och gränssnitt

Standardrapporten innehåller en kort slutsats och därefter mål och avgränsning, testobjekt, genomfört arbete, resultat, granskning, blockerare, underlag och nästa steg. Läsaren kan öppna detaljer per deluppgift och testfall utan att läsa en lång chatt.

| Rapportdel | Presentation |
| --- | --- |
| Lägesbild | Kort sammanfattning, målutfall, tidpunkt, version och pågående arbete. |
| Resultatöversikt | Kodberäknade antal med tydliga nämnare och stapeldiagram för testutfall. Research-uppdrag behöver ingen tom testgraf. |
| Testresultat | Tabell med testfall, observerat resultat, senaste försök och separat granskningsbedömning. |
| Tidslinje | Registrerade start- och sluttider. Hålltider/aktiv tid visas bara om de faktiskt mäts. |
| Diagram | Uppgiftsträd och beroenden från data; repokartor länkas till sin version med antagna samband markerade. |
| Underlag | Klickbara källor och skärmbilder med tidpunkt och koppling till påståendet. |
| Nästa steg | Konkreta kompletteringar att ge tillbaka till V. Inga dolda automatiska åtgärder. |

Återanvänd `WorkspaceCard`, Material-historik, befintliga text-/tabell-/bild-/grafblock och diagramvisningen. Utöka dokumentkontraktet med validerade referensblock för rapportmått och diagram där det behövs; bygg inte en separat dokumenteditor. Renderade rapporter ska ha en läsbar text-/tabellrepresentation även utan grafiken.

I Pågående arbete visas Klaras fas: sammanställer underlag, granskar, skriver eller kunde inte slutföra. Antal som ”3 av 10” visas endast för registrerat avslutade enheter. Rapportkortet visar ”Nya resultat har tillkommit” när källrevisionen ändrats och erbjuder öppning av senaste rapport eller ny beställning.

Klaraägda rapportversioner bevaras. Användaren kan lägga en separat kommentar eller göra en redigerbar kopia; automatiska uppdateringar får inte skriva över användarens ändringar eller återställa en rapport som lagts i papperskorgen. En kopia ska inte framstå som Klaras oförändrade bedömning.

Grafer och rapportverktyg ingår i planen. PDF-export och jämförelser mellan flera uppdrag kommer efter att den första rapporten kan återskapas från sparat underlag. För PDF ska exporten använda samma frysta rapportdata och renderingsmall, utan ett nytt modellanrop.

## Privat och publik rapportdelning

Rapporter är odelade som standard. Rapportägaren väljer **Dela rapport** i Material och får följande val:

| Läge | Mottagarens åtkomst |
| --- | --- |
| Inte delad | Befintlig workspace-behörighet krävs. Ingen extern delningslänk är aktiv. |
| Privat med pinkod | Mottagaren öppnar länken och anger pinkoden. Inloggning eller konto behövs inte. |
| Publik | Alla som har länken kan öppna rapporten utan inloggning eller pinkod. |

Privat betyder här länk plus pinkod, inte identifierade mottagare. Den som fått både länken och koden kan dela dem vidare. Gränssnittet ska beskriva det kort och tydligt. Publik innebär tillgänglig via länken; vi bygger ingen publik rapportkatalog och sätter `noindex` för delningssidor. Det är ingen åtkomstkontroll för publika rapporter.

### Ägarens delningsflöde

1. Välj rapportversion och se en förhandsvisning av exakt det som mottagaren får läsa.
2. Välj privat med pinkod eller publik. Vid privat delning genereras en slumpmässig sexsiffrig kod; ägaren kan välja en annan sexsiffrig kod. Koden överförs endast till serverns verifieringsflöde och visas för ägaren vid skapande/byte, aldrig i rapportinnehållet eller länken.
3. Välj vilka skärmbilder, diagram och andra underlag som ska ingå. Rapporttext och beräknade grafer ingår; råloggar och fristående källfiler är inte automatiskt delade. Ej delade underlag märks som sådana utan brutna interna länkar.
4. Aktivera delningen och kopiera länken. Valbart sista giltighetsdatum, samt möjlighet att byta kod, skapa ny länk eller stänga delningen.

Endast en aktiv extern delning per rapport i första versionen. Att byta läge eller delad rapportversion skapar en ny delningslänk och återkallar den gamla. Det gör att en tidigare publik länk inte tyst blir en fungerande väg in i en privat version. Byte av pinkod återkallar tidigare upplåsta sessioner. Ägaren kan inte hämta en sparad pinkod i klartext senare, men kan skapa en ny.

Automatiska rapportuppdateringar publiceras inte utåt. Den redan delade versionen ligger kvar tills ägaren uttryckligen delar en ny. Klara kan skapa och uppdatera rapporter internt, men får inte aktivera extern delning. Radering av rapporten, delat underlag eller workspace ska omedelbart stoppa åtkomst till den berörda resursen; en senare callback får inte återaktivera den. Återkallning hindrar framtida åtkomst via tjänsten men kan inte återkalla kopior som redan laddats ner.

### Tekniskt kontrakt för delning

- Läsytan får en egen route, exempelvis `/reports/shared/:token`, och separata API:er. Dessa undantas uttryckligen från appens inloggningsredirect men använder alltid delningskontroll på servern. Befintliga workspace-API:er behåller sin autentisering.
- Identifieraren genereras kryptografiskt med minst 128 bitars slump. Privat innehåll, titel, förhandsvisning, grafer, bilageadresser och metadata lämnas inte ut före godkänd pinkod, varken via SSR, sidans data eller API.
- Pinkoden lagras med en saltad lösenordshash och verifieras server-side. Försöksbegränsning måste fungera över flera serverinstanser, med gränser både per delning och per klient. Startvärde: fem misslyckade försök per klient/delning på 15 minuter samt separat samlad begränsning per delning. Ett temporärt skydd får inte bli en permanent låsning som vem som helst kan orsaka.
- Efter godkänd kod ges en högentropisk åtkomstcookie med `HttpOnly`, `Secure` och `SameSite=Lax`, avgränsad till delningsytan och med högst två timmars giltighet eller delningens tidigare sluttid. Servern sparar bara hash av sessionstoken och kontrollerar delningens aktuella revision på varje begäran. Detta ger inte en vanlig appsession eller åtkomst till andra rapporter.
- Skapa, ändra och återkalla delning kräver rapportägarens vanliga autentisering och samma skydd för ändrande anrop som övriga appen. Pinkodsverifieringen tar koden i en POST-body, aldrig i URL. Kod, sessionsvärden och delningsidentifierare maskeras i loggar.
- Delningssidan använder ett separat tillåtet dataformat med endast valda rapportblock och resurser. Ingen generell serialisering av snapshots, jobbrader, chatthistorik, användaruppgifter, Vault eller interna länkar. Sanera text, länkar och diagram; tillåt inte godtycklig HTML, script eller externa bildanrop i delningsrenderingen.
- Bilder, skärmbilder, diagramdata och senare PDF går genom samma åtkomstkontroll som rapporten. En bilagereferens måste finnas i den delade versionens manifest. Inga permanenta publika blob-URL:er eller workspace-filvägar skickas till mottagaren.
- Rapport och bilagor svarar med `Cache-Control: no-store`, så gemensam cache inte läcker privat innehåll eller fortsätter servera en återkallad version. Använd `Referrer-Policy: no-referrer` och undvik tredjepartsanrop som kan läcka länken. Utgången eller återkallad länk visar ett neutralt meddelande utan rapportmetadata.
- Logga ägarens skapande, lägesbyte och återkallning som revisionshändelser utan pinkod. En anonym mottagares upplåsning bevisar inte vem som läste rapporten.

UI ska återanvända rapportens gemensamma renderare med en separat läsmodell och utan workspace-navigation, redigering eller agentverktyg. Testa delningssidan i en ny webbläsarsession utan appcookies; ägarens redan inloggade session får inte dölja fel i delningsskyddet.

## Etapper och verifiering

| Etapp | Leverans | Klar när |
| --- | --- | --- |
| 0 | Avsluta och versionshantera den lokala korrigeringen av testgranskningen som separat ändring. | Befintliga prov för autogranskning, behörighet, deduplicering och återkoppling går igenom. |
| 1 | Uppdrag, deluppgifter, händelser och `WorkResultV1`. Adaptrar för test, Iris, Otto, repojobb och research. | Samma uppdrag kan innehålla flera typer av arbete med korrekt ursprung, återhämtning och inga dubbletter. |
| 2 | `MissionSnapshotV1`, underlagsläsning och kodberäknade mått. | En given snapshot kan återskapas och granskas utan att vara beroende av chatthistoriken eller levande VPS-processer. |
| 3 | Klaras rapportkö, begränsade verktyg och första rapport i Material med testtabell, källor och stapeldiagram. Privat och publik delning av vald rapportversion. | Ett verkligt blandat uppdrag ger en spårbar rapport medan V fortsätter vara tillgänglig. En mottagare utan konto kan öppna en publik rapport eller låsa upp en privat med pinkod; återkallning fungerar även för bilagor. |
| 4 | Automatiska uppdateringar, status i Pågående arbete, rapporthistorik och diagram. | Förändringar, pågående arbete, äldre rapporter och återhämtade jobb visas rätt utan en rapportstorm. |
| 5 | Rikare rapportmallar, tillgänglig export och jämförelser med uttryckliga avgränsningar. | Export och UI visar samma innehåll och siffror; jämförelser döljer inte versions- eller miljöskillnader. |

Första kompletta produktleveransen omfattar etapp 1–3. Den ska kunna besvara både ”hur gick testerna?” och ”vad fick vi gjort med hela uppdraget?”.

### Acceptansfall

1. **Surdeg och HTTP 500:** installation lyckas, appen svarar 500, planerade tester startar aldrig. Rapporten visar avslutad setupuppgift, blockerad miljö och ej körda tester. Inget godkännande härleds från exitkod 0.
2. **Research utan tester:** tre sparade källutdrag ger en källbunden sammanfattning; saknad källa anges och inga testsiffror uppfinns.
3. **Klick jämfört med direkt URL:** misslyckat navigeringsklick följt av lyckad direktöppning får inte beskrivas som verifierad navigering.
4. **Två uppdrag i samma workspace:** samtidiga jobb och rapporter blandas inte, även om repo och agentnamn är samma.
5. **Omtest och versionsbyte:** gamla godkännanden, ett nytt pågående försök och en annan commit ger rätt urval, historik och graf.
6. **Gammal eller borttagen källa:** rapporten visar luckan; en hash eller länk räknas inte som läst bevis. Borttaget innehåll återexponeras inte.
7. **Callback två gånger eller i fel ordning:** ett resultat och en rapportversion; status backar inte och inga externa jobb startas om.
8. **Avbrott under generering:** nytt försök återhämtar jobbet; en worker med gammal lease kan inte publicera över en senare rapport.
9. **Nytt resultat under rapportskrivning:** gamla rapporten får korrekt avgränsning, markeras inaktuell och följs av högst en uppdatering.
10. **Secret och promptinjektion i logg:** credentials tas bort före lagring i rapportunderlag och modellåtkomst; instruktioner i underlaget kan inte ge Klara nya verktyg eller ändra mål.
11. **Behörighet och runtime:** fel användare, annat workspace eller annan runtime nekas vid läsning, publicering och referensupplösning; cookies och interna credentials når inte modellen.
12. **Fel på modellen eller saknat underlag:** rapportfelet är synligt, ursprungsresultatet bevaras och V kan läsa den strukturerade lägesbilden. Inga automatiska omtester.
13. **Rapportredigering och radering:** en användarkopia eller borttagen rapport skrivs inte över/återskapas av sena callbacks.
14. **UI och export:** källor går att öppna med rätt behörighet, siffrorna stämmer och rapporten fungerar i smala/breda paneler, ljust/mörkt tema och med tangentbord.
15. **Privat delning utan konto:** rätt pinkod öppnar vald version. Fel eller saknad kod ger inget rapportinnehåll via sida, API, metadata, graf eller direkt bilagelänk. En upplåsning ger ingen åtkomst till andra delningar eller workspace-API:er.
16. **Publik delning utan konto:** text, inkluderade bilder och grafer fungerar i en ren session utan kod. Ej valda underlag, interna mål och senare rapportversioner exponeras inte.
17. **Återkallning och kodbyte:** gamla upplåsta sessioner och bilageanrop nekas efter återkallning, utgång, kodbyte eller resursradering. Delat läge/version byts via ny länk; gammal publik länk slutar fungera.
18. **Kodgissning och cache:** parallella försök mot flera serverinstanser begränsas, skyddet återhämtas och privat innehåll läcker inte mellan mottagare eller via cache, referrer och loggar.
19. **Delad version:** nya resultat ändrar den interna rapporten men inte den delade versionen. Förhandsvisningen motsvarar mottagarens vy och automatisk rapportering kan inte aktivera eller återaktivera delning.

Enhetstester täcker kontrakt, källordning, urval, mått och validering. Integrationstester använder tillfälliga fixtures för transaktioner, ägarskap, köåterhämtning och idempotent Material-publicering. Modellutvärdering använder märkta scenarier med både underbyggda misslyckanden och felaktiga godkännanden. Ett avgränsat verkligt uppdrag verifierar hela vägen V → utförare → snapshot → Klara → Material → återkoppling.

## Berörda filer och införande

Föreslagna nya kontrakt: `shared/mission.ts`, `shared/work-result.ts` och `shared/mission-report.ts`. Nya scheman och tjänster ligger under `server/db/schema/` och `server/utils/`, med interna API:er enligt repots befintliga HTTP-mönster. Källadaptrar placeras i ett gemensamt område, exempelvis `server/utils/mission-sources/`.

Rapportdelning tillför ett avgränsat kontrakt i exempelvis `shared/report-sharing.ts`, schema för delningar/sessioner, ägarautentiserade hanteringsrutter samt separata läs- och upplåsningsrutter under `/api/report-shares/`. Anpassa `app/middleware/auth.global.ts` endast för den uttryckliga delningsytan. Delningsvyn återanvänder rapportblock och får ett eget Nuxt UI-formulär för pinkod.

Integrationspunkter är `test-runs.ts`, `setup-jobs.ts`, `repositories.ts`, browserjobbens avslut och `research.ts`. Agentverktyg tillkommer under `agent/tools/` och rapportförfattaren under `agent/lib/`; befintliga `result-reviewer.ts` och testbedömningar behålls. Ny återhämtning följer mönstret i `agent/schedules/result-reviews.ts`. UI byggs i befintligt Material och `AgentActivityPanel.vue`, och agentöversikten uppdateras när förmågan är implementerad.

Införandet är additivt. Nya tabeller, index och befogenhetskontroller verifieras före aktivering. Äldre körningar får inte fabricerade uppdrag eller metadata; en avgränsad import måste markera vad som saknas. Börja med intern verifiering och därefter ett valt workspace innan automatisk rapportering slås på bredare.

Registrering av uppdrag/resultat, manuell rapportbeställning och automatisk rapportgenerering får separata driftreglage. Automatiken kan stoppas utan att underlag eller befintliga testgranskningar försvinner. Mät kötid, jobbfel, återförsök, dataluckor och modellförbrukning utan att logga känsligt innehåll.

Nuxt/Eve, migreringar och eventuella nya VPS-callbackfält driftsätts i bakåtkompatibel ordning. Kontrollera först den faktiska VPS-versionen och befintliga callback-/loggfunktioner; installera eller bygg inte om sådant som redan finns. Gamla workers får fungera med tydligt begränsade resultat tills nya fält stöds.

Planen kräver ingen ny databasleverantör, meddelandekö eller UI-komponentfamilj. Storleksgränser, kostnad och samtidighet justeras först efter mätning. Arbetsordningen är att säkra informationskedjan och sedan ge Klara fler sätt att presentera den.
