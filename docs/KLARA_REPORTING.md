# Klaras uppdrag och rapporter

Klara sammanställer ett uttryckligt uppdrag i ett workspace. V registrerar mål, kriterier och deluppgifter före delegering. Utförarnas ursprungliga resultat och testgranskningar bevaras. En rapport är en separat, versionsbestämd bedömning.

## Användning

Exempel till V:

> Skapa ett uppdrag för Surdeg. Sammanställ miljöns status, sparade researchkällor och de tre viktigaste testfallen. Knyt utförarnas arbete till uppdraget och be Klara skriva en rapport med underlag, luckor och nästa steg. Starta inga nya tester ännu.

`mission` skapar/läser/uppdaterar uppdrag, registrerar deluppgifter och kopplar sparade källor. `mission report` beställer asynkront och `report` läser den sparade versionen. Iris testkörningar ärver serverns uppdragskoppling. Axel skickar kopplingen vidare till repo-/VPS-verktygen. Äldre jobb kopplas endast uttryckligen; saknad runtime eller version redovisas.

Uppdrag visas i Översikt och Pågående arbete. Rapporten sparas i Material. Där finns historik, delning, jämförelse, redigerbar kopia och en fristående utskriftsvy. PDF skapas via webbläsarens utskriftsfunktion och samma rapportkomponent; ingen separat modell skriver exporten. Jämförelsen visar separata avgränsningar och mått, inte ett automatiskt regressionspåstående.

## Informationskedja

1. `shared/mission.ts` definierar uppdrag, normaliserat arbetsresultat och fryst snapshot.
2. `server/utils/mission-sources.ts` läser befintliga test-, browser-, setup-, repo- och Materialposter. Research sparar ett källutdrag även utan skärmbild när uppdragskoppling finns.
3. `server/utils/missions.ts` validerar ägare/workspace/runtime, registrerar idempotenta källkopplingar och jämför sparade källrevisioner. Återhämtningen startar inga externa jobb.
4. `shared/mission-metrics.ts` återanvänder kvalitetsreglerna: explicit testurval, senaste kompatibla försök, separata miljöer/versioner, manuella bedömningar och aldrig startade testfall.
5. `server/utils/mission-reports.ts` leasar ett rapportjobb. `agent/lib/mission-reporter.ts` får hela den begränsade översikten och ett enda verktyg: läsa tillåtet underlag. Därefter skriver ett separat verktygslöst modellsteg det strukturerade utkastet från samma översikt och de faktiskt lästa texterna/bilderna. Källor är data och kan inte ge henne nya verktyg.
6. Läskvitton binder källa, version, hash/digest, lästid och eventuell avklippning. Servern kontrollerar citerade referenser, kriterietäckning och att underlaget fortfarande är tillgängligt före publicering.
7. Materialpublicering och färdigställande sker atomiskt under worker-lease. En återkoppling med rapportlänk köas till rätt Eve-chatt med verktyg avstängda.

Agentens berättelse kan citeras som ett påstående. En underbyggd slutsats kräver också läst oberoende underlag. HTTP 500 innebär blockerad miljö även om själva setupjobbet avslutats. En lyckad direkt-URL verifierar inte ett navigeringsklick.

## Presentation och oföränderlighet

Rapporten visar mål och kriterier, faktisk omfattning, kodberäknade grafer, testtabell med separat granskningsstatus, arbetsstatus och rapporterat målutfall, start/sluttider, uppgiftskarta, citerade källor och kompletteringsbehov. Tiderna visar registrerade händelser, inte mätt aktiv arbetstid.

Nya resultat ger en ny underlagsrevision. Äldre rapporter märks som inaktuella men ändras inte. Automatiskt skapade Materialrapporter kan inte redigeras som original; en redigerbar kopia märks uttryckligen som kopia. Borttagna rapporter återställs inte av återförsök.

## Delning

- Odelad är standard. Endast ägaren kan aktivera delning av en färdig rapportversion.
- Publik länk kräver inget konto eller kod. Privat länk kräver sexsiffrig PIN, men inget appkonto.
- Privat innehåll och metadata lämnas inte ut före upplåsning. PIN lagras med saltad scrypt-hash och serverhemlighet; koden visas endast vid skapande/byte.
- Slumpmässiga sessionsbevis lagras hashade och gäller högst två timmar. Varje läsning kontrollerar delningens aktuella revision, giltighet och radering.
- Kodbyte återkallar upplåsta sessioner. Lägesbyte eller ny delad version ger ny länk och återkallar tidigare länkar för uppdraget. Automatisk rapportering ändrar aldrig den externt delade versionen.
- Ägaren väljer bildbilagor. Rapporttext, mått och uppgiftsdiagram ingår. Råloggar/fria källfiler publiceras inte som bilagor i denna version. Ej inkluderade bilagor är märkta; förhandsvisning och mottagarsida använder samma läsmodell.
- Bilder hämtas genom samma behörighetskontroll. Workspace-API:er blir inte åtkomliga via rapportens cookie. Rapport- och bildsvar är `no-store`, med `no-referrer`, `noindex` och utan sidanalys.
- Försöksräknare finns i databasen: fem försök per klient/delning och 50 sammanlagt per delning under 15 minuter. Ägarens delningsändringar har separat revisionslogg utan koder.

## Drift

Additiva migreringar `0019`–`0021` skapar uppdrags-/rapport-/delningstabeller, aktiverar RLS, lägger till runtime för nya test-/repokörningar samt sparar läskvitton och modellförbrukning. Befintliga tabeller och resultat behålls. Applicera migreringarna före ny app/agent. Inga nya VPS-program eller callbackfält krävs: adaptrarna använder befintliga sparade resultat och den befintliga oberoende HTTP/commit-kontrollen.

| Variabel | Funktion |
| --- | --- |
| `MISSIONS_ENABLED=false` | Pausar nya uppdragsändringar. Läsning kvarstår. |
| `MISSION_REPORTS_ENABLED=false` | Pausar nya rapportbeställningar och rapportworker. Befintliga testgranskningar påverkas inte. |
| `MISSION_AUTOMATIC_REPORTS=false` | Pausar automatisk beställning; manuella rapporter fungerar. |
| `REPORT_SHARE_PEPPER` | Separat serverhemlighet för PIN/klienthashning; annars används befintlig `INTERNAL_API_SECRET`. Behåll stabil mellan instanser. |
| `GRUNDEN_API_TOKEN` | Befintlig modellanslutning för Klara. |

Reglagen är aktiva om de inte uttryckligen sätts till `false`. Varje uppdrag kan också stänga av automatiska rapporter. Börja produktionsinförandet med `MISSION_AUTOMATIC_REPORTS=false` och verifiera ett valt workspace före bred aktivering.

Eve sveper kön varje minut. Aktiv app hämtar uppdragsstatus och kan också väcka workern. Relevanta ändringar samlas i 60 sekunder, högst fem minuter vid kontinuerlig förändring. Högst ett aktivt rapportjobb per runtime och en väntande revision per uppdrag; testgranskningen har en separat kö. Om en chattleverans är osäker upprepas den inte automatiskt; rapporten finns fortfarande i Material.

Rapportjobb har högst tre försök, 150 sekunders arbetsbudget, 240 sekunders lease, åtta modellsteg och 24 underlagsläsningar. Varje fil är högst 4 MiB; högst sex bilder/12 MiB bilddata. Textutdrag begränsas till 32 000 tecken. Översikten är högst 180 000 tecken. Ett uppdrag har högst 200 deluppgifter, 50 kriterier och 500 valda testfall. Uppgiftskartan visar högst 150 noder/400 relationer; textlistan bevarar hela urvalet. Nådd gräns ska visas som lucka eller synligt rapportfel.

Jobbrader lagrar kö-/arbetstid, försök, modell, tokenförbrukning, läskvitton och felstatus. Modellkostnad i kronor beräknas inte utan en versionsbestämd prislista. Begränsade sanerade observationer finns i snapshots; originalfiler ligger kvar i privat Material. Vaultvärden används enbart för bortmaskering, aldrig som modellinput.

## Verifiering

Enhetstester: `pnpm test:unit`. Typkontroll: `pnpm typecheck`. Kodkontroll: `pnpm lint`. Agent- och produktionsbygge: `pnpm build:agent`, `pnpm build`.

Det uttryckligen aktiverade `tests/mission-reports.integration.mjs` skapar tillfälliga konton, privata filer och verkliga modelljobb. Kör mot lokal server med `RUN_MISSION_REPORT_TESTS=1`. `RUN_LIVE_MISSION_RESEARCH=1` lägger till verklig läsning av example.com. Testet tar bort sina fixtures om inte `KEEP_MISSION_FIXTURE=1` används för efterföljande UI-verifiering. Testfixtures är tydligt märkta och är inte verifieringsresultat för Surdeg.

Med behållen fixture kan följande köras med `pnpm exec node --env-file=.env <testfil>`:

- `tests/mission-report-boundaries.integration.mjs`: automatisk beställning, uppdragsisolering och direkt nekad databasåtkomst. Kräver `RUN_MISSION_REPORT_TESTS=1`.
- `tests/mission-orchestration.integration.mjs`: riktig V-chatt skapar uppdrag/deluppgift, läser en publik källa med uppdragskoppling, beställer Klara och tar emot en rapportlänk utan att starta nya verktyg. Kräver samma flagga och modellanslutning.
- `tests/mission-reports.browser.mjs`: Material, bred ljus/smal mörk vy, PDF, PIN med tangentbord, omladdning och återkallning. Kräver installerad Chrome och `RUN_MISSION_REPORT_UI=1`.
- `tests/mission-fixture-cleanup.mjs`: stoppar testkontots sandboxes och tar bort dess privata filer, workspace-data, konto och lokala sessionscookie. Kräver `RUN_MISSION_REPORT_TESTS=1`; kontots genererade testadress kontrolleras först.

Genomförd lokal verifiering 2026-10-04: 167 enhetstester, app-/agenttypkontroll, lint, agentbygge och produktionsbygge. Integrationsproven omfattar verkliga modellkörningar, research, bild-/textläsning, motsägande testunderlag, originalresultatets bevarande, samtidiga PIN-försök, ägar-/runtimegränser, RLS, återkallning, köåterhämtning och faktiskt V→Klara-flöde. Webbläsarprovet och en tre sidors PDF har granskats. Uppdragsverktyget validerar även JSON-kodade objekt från modellanslutningen; ogiltiga kriterier och ID:n avvisas fortfarande.

Produktion är inte verifierad av lokala testresultat; separat driftsättning och kontroll krävs.
