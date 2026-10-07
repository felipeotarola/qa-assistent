# Syna – beslutsrapport inför paus

Datum: 7 oktober 2026, svensk tid. Rapporten granskar arbetskopian mot `dd3db24c0ed004008355197dfdcfe3a1a4a52061` och redan sparade körbevis. Inga nya tester, modellanrop, migrationer eller produktändringar har utförts för rapporten. Implementation och nya acceptansprov är pausade i väntan på ditt beslut.

## Bedömning

Vi har byggt en betydande del av den nya autonomin: beständiga uppdrag, en schemalagd styrning, gemensamma resultat-/beviskontrakt, repo- och miljöflöden samt begränsade kompletteringar. Flera verkliga flöden från vanlig användarfråga till rapport har fungerat utan att användaren driver varje steg.

**Det är däremot inte visat att hela systemet är stabilt eller färdigt enligt P1a–P5.** Rapportleveransen kan fortfarande fallera. Vissa äldre innehållsfel är inte avskrivna genom godkända nya prov, och stora delar av fel-/återstartsmatrisen saknar färdig acceptans.

Arbetet har förbättrat spårbarheten och kontrollen av vad agenten får kalla verifierat. Striktare kontroller stoppar också felaktiga utkast, vilket ibland ger utebliven rapport i stället för en missvisande rapport. Det är en bättre säkerhetsgräns, men ännu inte tillräckligt bra leveranssäkerhet.

Min rekommendation är att **bevara arbetet, men inte slå på hela autonomin brett eller behandla det som en färdig release**. Om vi fortsätter bör nästa uppdrag vara ett litet stabiliseringspaket med en tydlig slutpunkt, inte nya funktioner.

## 1. Vad ligger öppet i Git?

Inventeringen före denna rapport innehåller **588 individuella filer: 127 ändrade spårade filer och 461 nya ospårade filer**. Inget var staged. HEAD är fortfarande `dd3db24` (`fix(material): contain preview controls within card layers`). Rapporten tillkommer som en ny dokumentfil efter inventeringen.

| Område | Filer | Innehåll |
|---|---:|---|
| Agent | 47 | Nytt QA-intag, planerare, schemaläggning, granskare/rapportskrivare, verktygsbindningar och användningsmätning |
| Frontend | 11 | Uppdragskort, väntan/kontroller, rapport-/kvalitetsvy och miljömedgivande |
| Backend | 106 | Uppdragsstyrning, försök/lås, API:er, underlag, repo/miljö, nya tabeller och migrationer |
| Gemensamma kontrakt | 42 | Mandat, ursprung, resultat, delbedömningar, rapport, komplettering och telemetri |
| Körmiljö | 13 | Browserpolicy/spårning samt Otto-/repo-/preview-kopplingar |
| Tester och teststöd | 360 | Enhets-/integrationsprov, riktiga modellprov, felinjektion, isolering och acceptansdrivare |
| Dokumentation | 7 | Plan, arbetslogg, benchmark, införande och arkitekturdokument |
| AGENTS.md och Nuxt-konfiguration | 2 | Isoleringsregler och rättning av localhost-importer |
| **Totalt** | **588** | **360 är testfiler/teststöd; siffran betyder inte 588 produktfunktioner** |

`git diff` för enbart redan spårade filer visar 4 193 tillagda och 658 borttagna rader. **Det exkluderar de 461 nya filerna** och ska inte beskrivas som hela ändringens storlek. Tidigare uppgift om cirka 469 poster räknade vissa nya kataloger som en post.

Exakt inventering: [öppna ändringar](../.data/autonomy-review-open-changes-2026-10-07.json). Privata körloggar och experiment under `.data/` ligger utanför dessa Git-siffror. Denna rapport är en genomgång av ändringsområden och centrala kodvägar, inte en ny rad-för-rad-granskning av samtliga 588 filer.

## 2. Vad är faktiskt byggt?

| Paket | Vad vi har implementerat | Hur långt verifieringen har kommit |
|---|---|---|
| **P1a – gemensamma kontrakt** | Uppdrag/körning kopplas ihop, bevis får ursprung och version, leveranstäckning kontrolleras. Agenttext blir inte oberoende bevis bara för att den ligger i Material. | Paketets tre interna steg har granskning och godkända enhets-/isolerade databasprov. Historisk integrerad grind: 234 enhetstester och 74 databas-/filkontroller; modeller/runner var syntetiska där. |
| **P1b – mandat och tillstånd** | Beständiga försök, väntan, planrevisioner, budgetar, resursreservationer och miljömedgivande. | Integrerat och granskat; historiskt 253 enhetstester och 68 isolerade PostgreSQL/H3-kontroller. Bevisar kontrakt, inte alla verkliga avbrott. |
| **P2a – autonom webb-QA** | Vanlig fråga tas emot som uppdrag; upptäckt, planering, Iris, Klara och rapport drivs av schemalagd backend. Mänsklig återlämning och deadlines finns. | Flera normala webbserier har tre riktiga körningar med innehållsgranskning. Senaste AUTH-återlämningen klarar ett komplett prov. Återstart/väntan/felvarianter är inte färdiga. |
| **P2b – repo och testmiljö** | Upptäcka repo, köra testsuite eller förbereda/starta app, verifiera readiness, använda godkänt Vault-medgivande och testa preview. | Normala REPO-10/11/12 har vardera tre verkliga modell-/Linux-körningar och rapportgranskningar. Saknad nyckel utan svar är också verifierat som korrekt begränsat stopp. Flera felvarianter återstår. |
| **P3 – kompletteringar** | Klaras konkreta bevisluckor kan ge begränsade nya försök med oförändrade originalkrav och högst två kompletteringsrundor. | Kod och isolerade integrationsprov finns. Den avsedda verkliga kedjan med injicerat bevisfel och automatisk komplettering har inte klarat hela acceptansen. |
| **P4 – presentation och mätning** | Uppdrag/status/rapporter visas gemensamt; användning och tid sammanställs; rapporter kopplas till sparat underlag. | Separata UI-/bildprov och rapportprov finns. Bred kvalitets-/kostnadsmätning är ofullständig. |
| **P5 – införande och återställning** | Berörda läsdrivna fortsättningar har ersatts; feature flags, införandedokument och migrationer finns. | Migration 0023→0029, databevarande och replay har isolerade bevis. Fullt av/på-/återstartsprov och slutgranskning saknas. Ingen färdig releasegrind. |

Centrala kodreferenser: [QA-intag](../agent/tools/qa_mission.ts), [bevarat användarmål](../shared/mission-request-context.ts), [schemaläggning](../agent/schedules/autonomy.ts), [controller](../server/utils/mission-controller.ts), [mandat och livscykel](../server/utils/mission-control.ts), [bevisursprung](../shared/evidence-provenance.ts), [kompletteringar](../server/utils/mission-complements.ts), [miljömedgivande](../server/utils/environment-consents.ts), [rapportkontrakt](../shared/mission-report-output.ts).

Detta är vidareutveckling av befintliga Eve-, Nuxt- och PostgreSQL-vägar. Vi har inte ersatt ramverket. Otto/shared och tidigare rapportdelning fanns redan före detta arbetsblock; hela deras funktionalitet ska inte tillskrivas den öppna diffen.

## 3. Vad har fungerat i verkliga prov?

Den dokumenterade katalogen har **13 av 35 färdigverifierade varianter**, med tre behållna repetitioner och separata innehållsgranskningar. Det är inte 13 nya pass på senaste bygget, inte 37 procent färdig kod och inte en uppmätt generell framgångsfrekvens.

De 13 är normalflödena WEB-01, WEB-02, WEB-03, WEB-04; WEB-03 med otillåtna källinstruktioner; REP-05/06/07 normal; REP-07 med fel körningsbindning; REPO-10/11/12 normal; samt REPO-12 med saknad nyckel och uteblivet svar. REP-normalproven har deklarerat syntetiskt sparat underlag men verklig rapportmodell. Repo-/webbproven har andra bevisnivåer och får inte blandas ihop med dem.

Nyare avslutade prov på källsnapshot `d16d1eac`:

- **AUTH09:** ett komplett godkänt prov av inloggning genom mänskligt övertagande, återlämning, fortsättning och rapport. Oberoende granskning stöder samma session, faktisk profilvisning och samtliga tre kontrollbedömningar. Detta är en repetition, inte en färdig serie.
- **WEB02 återlämning:** senaste körningen avslutades med mekaniskt godkänt resultat och rapport. Den nya oberoende slutgranskningen saknar färdigt kvitto i den granskade katalogen. Äldre två delprov har villkorat återbruk, men jag höjer därför inte totalsiffran till 14 här.
- **REP05 historiska resultat:** två rapporter är oberoende granskade och godkända med angivna reservationer. Den tredje levererade ingen rapport. Serien är underkänd.
- **Senaste tekniska kontroller:** full app-/agenttypkontroll och båda isolerade byggen är sparade som godkända. Reviewer19 har fem riktade rena/SDK-prov och sju faktiska isolerade databasprov med syntetisk modell. Ingen helt ny totalsumma för alla enhetstester har räknats fram i denna genomgång.
- **Localhost:** importfelet mot `C:/shared/repository-request.mjs` är rättat i Nuxt-konfigurationen. Tidigare faktisk HTTP-/UI-verifiering finns; det är inte ett nytt autonomiprov.

Källor: [benchmark](AUTONOMY_BENCHMARK.md), [arbetslogg](AUTONOMY_WORK_LOG.md), [AUTH-kvitto](../.data/autonomy-isolation/independent-AUTH09-d16d-return-bytes-2635bc7c-f70b-4351-8796-237d5e298d9f/semantic-receipt.json), [REP05 slutkvitto](../.data/autonomy-isolation/independent-REP05-d16d-final-f70b9fe5-b165-42fe-a219-761524784134/receipt.json).

## 4. Kända fel och öppna risker

| Prioritet | Fynd | Vad det innebär |
|---|---|---|
| **Blockerande för tillförlitlig leverans** | Klara kan generera bedömningar som rapportvalidatorn nekar. Senaste historiska REP05:s tredje försök slutade `delivery_failed`, utan rapport. | Användaren kan få genomfört underlagsarbete men ingen leverans. Råutkast saknas, så exakt delregel är inte säkert fastställd. En separat privat kandidat för striktare modellformat finns, men är inte färdigintegrerad eller godkänd. |
| **Öppet tidigare innehållsfel** | WEB-01 controller-restart har tre mekaniska pass men ingen godkänd full innehållsserie. | Att processen återstartar och sparar något bevisar inte att slutrapporten är korrekt. Senare policyändringar får inte antas ha löst detta utan riktat prov. |
| **Öppet tidigare innehållsfel** | Regressions-/väntproven har dokumenterade reservationer om blandning av A/B-resultat, planversion och kontrollpunkt/citat. | Vissa normaldelar är godkända, men de aktuella felvarianterna är inte avskrivna. Det är inte belagt att varje reservation fortfarande reproduceras på senaste koden. |
| **Mindre kvalitetsfel** | Två sparade rapportsammanfattningar slutar mitt i mening/hänvisning vid 240 tecken. | Fulla källor och negativa fynd finns kvar, men läsbarheten är dålig. |
| **Öppen säkerhetsverifiering** | SEC-prov har inte observerat hela modellkontexten och alla fysiska effekter. Ett tidigare prov skapade en sandbox trots tomma QA-tabeller. | Vi kan inte dra slutsatsen ”inga otillåtna effekter” enbart från databasen. Den då identifierade sandboxen städades separat; generell effektfrihet är inte bevisad. |
| **Ofullständig mätning** | Full V-/Otto-förbrukning och kostnad saknas i delar av mätningen. | Vi kan inte lova lägre kostnad eller högre hastighet. |

Min tidigare formulering ”ett blockerande fel och ett mindre kvalitetsfel” beskrev de senaste konkreta rapportfynden men var **för snäv som sammanfattning av hela projektet**. Tabellen ovan tar även med tidigare öppna innehållsfel och säkerhetsgrindar.

## 5. Vad återstår enligt hela planen?

**22 katalogvarianter saknar ännu full avslutad acceptans**, plus den separata P5-slutgrinden. Några har delbevis som kan återbrukas. Det betyder inte att samtliga 22 är trasiga eller att allt måste köras om.

1. Slutföra och granska rapportformatets rättning samt verifiera den tidigare fallerande rapporten.
2. Slutföra återlämning, uteblivet svar och sent svar med ärlig del-/slutrapport och korrekt avslut.
3. Verifiera återstart av controller och rapportarbete utan manuella räddningsanrop eller dubbla leveranser.
4. Prova ändrad plan och stopp med oberoende tillåtet arbete som fortsätter.
5. Prova förlorat runnerkvitto, app som dör efter readiness och återkallat Vault-medgivande före nyckelutlämning.
6. Verifiera faktisk Klara-lucka → begränsad komplettering för både lösbar och kvarstående lucka, samt att rapport-only inte startar nya tester.
7. Slutföra rapportens källändrings-/kvittensfel och säkerhetsprov med tillräcklig observation av exekvering.
8. Genomföra P5 av/på/återaktivering, slutgranska integration och sammanställa kvalitet, tid och känd/okänd förbrukning.

Redan godkända, opåverkade prov ska behållas med sin källversion. Endast ändrade, underkända och ännu oprövade egenskaper behöver nya körningar. De gamla underkännandena ska ligga kvar som historik.

## 6. Har det blivit stabilare, snabbare eller smartare?

**Mer kapabelt och bättre kontrollerat: ja, inom verifierade delar.** Det finns nu en faktisk beständig uppdragskedja och flera genomförda normalflöden. Originalmål och kontrollpunkter bevaras bättre, och underlag kopplas hårdare till rätt körning och version.

**Generellt stabilare: inte bevisat ännu.** Den tidiga lilla baslinjen gav 0/3 kompletta QA-kedjor; senare finns fungerande riktiga kedjor. Det visar framsteg, men är inte en rättvis före/efter-benchmark med samma uppdrag, inställningar och felvillkor.

**Snabbare/billigare: inte visat.** Sparade, separata mätserier visar exempelvis ungefär 12 minuters median för WEB-01 och 1,6 minuter för REP-05 på redan förberett underlag. De mäter olika arbete. WEB-01:s tre körningar har cirka 1,84 miljoner kända token inom observerat uppdragsscope; det är varken hela projektets förbrukning eller ett komplett prisunderlag. Kostnad och latens behöver därför behandlas som öppna produktfrågor.

## 7. Risker med arbetsläget och vad en driftsättning kräver

- Diffen är stor och saknar integrerade delcommits. Den bör delas i granskbara logiska delar innan merge; nya ospårade produktfiler och tester får inte tappas bort.
- Privata kandidater och körkvitton ligger i `.data/`. Exempelvis är `next-fixes/writer-native-checks/` påbörjat arbete med felloggar, inte en färdig patch att blint kopiera in.
- Äldre plan-/loggstycken beskriver tidigare lägen. Denna rapport sammanställer det senaste kontrollerade läget utan att skriva om deras daterade historik.
- Migrationerna 0022–0029, feature flags, scheduler, interna API-kopplingar och runner/browser måste hanteras som ett samordnat införande. Att frontend visar agentnamnen bevisar inte att den nya autonomin är aktiv i en viss miljö.
- Det stora implementationsarbetet är inte deployat som en godkänd release. En tidigare oavsiktlig testskrivning till delad databas är dokumenterad i `build-target-incident.json`; det vore fel att säga att all tidigare körning varit isolerad. Senare skydd kontrollerar även den kompilerade databasanslutningen. Incidentens tidigare städning är inte redovisad som utförd. Den separat beställda raderingen av Sebnilsson är en annan, uttryckligen godkänd åtgärd.
- Införande kräver separat beslut, rätt målmiljö, backup/återställningsplan, valda migrationer, verifierade credentials/medgivanden och ett begränsat produktionsprov. Denna rapport gör inget av detta.

## 8. Rekommenderat beslut

**Pausa den stora utbyggnaden här och behåll koden.** Vi behöver inte fler förmågor för att bedöma kärnprodukten.

Om du vill fortsätta föreslår jag en avgränsad leverans:

1. Gör rapportleveransen robust och korttexterna läsbara.
2. Välj ett webbuppdrag och ett repo-/miljöuppdrag som representerar din pilot. Kräv sparad, underbyggd rapport med stängd chatt och ett verkligt avbrott/återstart.
3. Avsluta med en liten rapport över exakt dessa flöden och lämna övrig matris tydligt uppskjuten.

Det är en **medveten minskning av P1a–P5:s acceptansomfattning**, inte ett sätt att kalla den ursprungliga planen klar. Om hela ursprungsplanen fortfarande ska godkännas behöver kvarvarande katalog och P5 slutföras.

Du behöver alltså välja mellan en smal, verifierad pilot och fortsatt full acceptans. Ingen av dem kräver att vi kastar bort det som redan fungerar. Ingen ytterligare implementation startas innan ditt beslut.
