# Syna: införande, kompatibilitet och återställning av autonomi

Datum: 2026-10-07 UTC; senaste kontrollpunkt 01:28 UTC (00d7-fönstret). **Arbetsdokument för P5; ingen produktionsändring är utförd
genom detta dokument.** [Utvecklingsplanen](AUTONOMOUS_MISSIONS_PLAN.md) äger
paketens acceptansgrindar och daterade körbevis. Att en kodväg beskrivs här betyder
att den är kodläst, inte att hela flödet eller driften är verifierat.

**Kontrollpunkt 2026-10-07 01:28 UTC, källa `00d7c6ed`:** WEB02 W1 `252d1def` har en mekaniskt och oberoende semantiskt godkänd repetition; detta är inte 3/3. AUTH09 W1 `cadf8f76` förblir FAIL: återlämning och ny profilobservation fungerar, men login-inspektionens granskning misslyckas och slutrapporten är korrekt partial/blocked. REP05 `b727503d` gjorde inget intag: V avslutade utan verktyg eller nytt uppdrag, och endast observationsdrivern avbröts kontrollerat. Ingen full observationsfrist eller acceptans påstås. Writer16k har därmed körts för WEB/AUTH, men inte för historiska REP05. **13/35 kvarstår; inga originalutfall omklassas.**

Multiplicitetsregeln för sparade resultat är granskad och integrerad i en instruktionsfil. Reviewer19 är därefter granskad och integrerad i sju filer. Fem riktade rena/SDK-prov, sju faktiska isolerade PG-fingerprintkontroller med syntetisk modell samt full app-/agenttypkontroll passerar. Båda privata byggen har exit 0 på källa `d16d1eac4aa0fedc99a541341fe9fe89fbb5664753257c938520dcec17a08eaf`; faktisk modellverifiering av rättningarna återstår. Se arbetsloggen för exakta kvitton. Äldre daterade statusrader nedan beskriver sina dåvarande lägen.

**Kontrollpunkt 2026-10-07, REP05/16k:** REP05 historical-review-gap på `bdd1df34`, omgång `ea4d1bd2`, avslutades failed 00:40 UTC efter första repetitionen; repetition 2 och 3 startades inte. Tre sparade writer-fel visar `finishReason=length`; ett senare unexpected-fel saknar fastställd orsak. Writer16k är därefter integrerad med versionsbundet outputtak: 3 riktade SDK-prov och 27 isolerade PG-fingerprintkontroller passerar, men något faktiskt modellprov med det nya taket är ännu inte redovisat. **13/35 kvarstår.** Originalutfall och äldre daterade kontrollpunkter bevaras.

**Intag v2 integrerat 2026-10-07:** originalmeddelandet binds nu av kod från det autentiserade chattarkivet; modellen kan välja verifierade tidigare referenser men kan inte skriva om goal. 17 filer har integrerats efter oberoende granskning (`mission-request-root-integration.json`, SHA `23ae362786b927fc05acda45997f9f5fc07db18171eb97d9305dfbc565c1a9cd`). Rootens 22 riktade rena prov, 6 + 25 + 11 faktiska isolerade PG/API-kontroller och full app-/agenttypkontroll passerar. Modell/inkommande kvitton är syntetiska i PG-proven; ingen faktisk modellacceptans tillskrivs dem. Testhjälparens aliasupplösning behövde en separat granskad rättning för installerad Eve; det första importfelet bevaras i loggen. Loggar: `mission-request-root-focus.log`, `mission-request-context-pg-resolved.log`, `mission-request-control-pg.log`, `mission-request-selection-pg.log` och `intake-report16k-typecheck.log` under `.data/autonomy-isolation/`. Nya isolerade Nuxt-/Evebyggen har exit 0 på fryst källa `00d7c6edf4bb1369ad605fd180b65f13feaeebd5d1ccab72d6b0427556737d39` (639 filer; `intake-report16k-build-{web,eve}.log`). Aktuella modellprov återstår; deras audit är en förkontroll. **13/35 är oförändrat.**

**Kontrollpunkt 2026-10-07 00:32 UTC:** planner21 och W1-harnessens aktiva returavstämning är integrerade. Riktade 5 + 45 rena prov, 14 isolerade PG-kontroller med syntetiska modeller och full typkontroll passerar. Fryst källa `bdd1df34` har godkända Nuxt-/Evebyggen, men inget nytt modellacceptanspass tillskrivs bygget. På föregående `efd6bfab` förblir AUTH09 `1e5f155e` och WEB02 `4936f97f` underkända: AUTH har ett extra read-only-blockerat planfall, och WEB saknar fortsatt låst artikelreturklick trots bevarad återlämningshistorik. En kodfunnen avsmalning av intagsmålet saknar ännu produktfix. REP05:s nya omgång är under förberedelse/körning, inte godkänd. **13/35 kvarstår**; oförändrade äldre pass behålls med sitt scope och inga original omklassas. Se [arbetsloggens senaste kontrollpunkt](AUTONOMY_WORK_LOG.md) för kvitton och semantikreservationer.

P2a:s verkliga webbflöde och återstartsmatris har ännu inte passerat sin grind.
P2b:s repo/Vault/preview-kedja, P3:s verkliga kompletteringsprov och P4:s breda
mätning behöver också slutföras före P5 kan markeras färdigt. Isolerade delprov
ersätter inte dessa grindar. Produktionsinförande kräver ett separat mandat.

**Integrerat 21:21 UTC:** planner17, reviewer16 och rapportbedömning8 ingår i aktuell kod. Sammanfattningen har eget native max240-fält; relation/källor härleds fortsatt från samtliga delbedömningar. Reviewer-modellen får fallets fulla krav utan bredare basis-citat, medan originalinput bevaras. Full typkontroll och berörda PG-prov passerar med syntetiska modeller. Nya isolerade byggen och riktade faktiska modellprov pågår; inga fler normalpass nollställs enbart av ny källhash.

**Uppföljning 21:01 UTC:** AUTH09 `c62850ea` återupptog rätt konto-fall och
visade kontouppgifterna, men kraven skärptes felaktigt till en viss
autentiseringsmetod. Slutprovet är underkänt. En minimal planner17-kandidat
är kodgranskad, ännu inte modellverifierad. Delbedömningar och observationsindex
är integrerade; typkontroll och tre berörda isolerade PG-sviter passerar.
Faktiskt replay visar fortfarande en semantisk reservation och en korrekt
avvisad referenslös bedömning. Dessa delprov stänger ingen global grind.
Se utvecklingsplanens senaste kontrollpunkt för exakta kvitton och förtydligandet
att ”klickbara länkar” inte automatiskt kräver navigation till båda målen.

**Riktad integration 20:27 UTC:** exakt återupptagning av det oklara övertagna
fallet, säker schemafelsdiagnostik och testdriverns fasta repo-deadline är
integrerade. Bara den berörda PG-sviten kördes om (sex grupper, syntetisk
browser-HTTP); den, full app-/agenttypkontroll och riktad lint passerar.
UI6:s sex vyer/18 bilder är separat godkända på `667710ca`. AUTH09 och
WEB02 W1 har däremot kvarvarande faktiska underkännanden enligt planen.
Detta är inte en full acceptansgrind. Nya riktade modellprov förbereds.
En separat Nuxt-fix gör localhost användbart: delade moduler inkluderas i
serverbygget så Windows dev inte pekar på `C:/shared`. Faktiskt HTTP 200 på
login och korrekt startsideredirect är verifierade, inga produktionsändringar.

**Riktad integration 19:38 UTC:** AUTH-återupptagande, GAP-felprovets
dispatch-bindning och lokal radbrytning i rapporten är integrerade efter
oberoende granskning. Rena prov samt integrerad app-/agenttypkontroll och
lint passerar. Tre isolerade PG-sviter passerade 19:41 med syntetisk
browser-HTTP. Riktade modell-/UI-prov återstår; detta är ännu inget nytt
acceptansgodkännande. Opåverkade tidigare pass
återanvänds. Se integrationskvittot och arbetsloggen i utvecklingsplanen.

**Riktad acceptans 19:04 UTC:** isolerade web-/Evebyggen på `dc2c245b`
passerar. Ett nytt REP05-rapportprov har slutförts och oberoende granskats
mot samtliga 17 originalkontroller utan blockerande semantikfel. Det är
en avgränsad ny datapunkt; befintliga källbundna normalpass bevaras.
Uppföljning 19:29: WEB02 återlämning har ett mekaniskt och semantiskt pass
av tre. AUTH09 har korrekt autentisering men tappar det tidigare blockerade
originalfallet efter återlämning och är fortsatt underkänt. UI6:s tre breda
vyer passerar; faktisk mobilöverströmning rättas lokalt. Första GAP-provet
underkändes eftersom felverktygets gamla jobbkoppling aldrig utlöste något
läsfel. Noll filer kvar i karantän; kvarvarande repetitioner startades inte.
Web/Eve är stoppade efter strict-zero utan undantag. Kod-/testkandidater
granskas före ett samlat nytt bygge och riktade prov. Ingen global
slutgrind, migration av delad databas eller driftsättning godkänns här.

**Integration 18:42 UTC:** hela kontrollpunktens bedömning, obligatorisk
rapporttäckning och återlämnad browserkontext är integrerade. Efter ett
avgränsat faktiskt jämförelseprov använder Klaras reviewer 13 och
rapportskrivare samma fasta `glm-5.3`, med modellbunden rapportversion.
Typkontroll, lint och två riktade isolerade PG-sviter (12 kontroller med
syntetiska utförare) passerar. Dessa ersätter inte faktisk semantisk
acceptans. Ny källa `dc2c245b` byggs isolerat för riktade WEB02/AUTH09 och
REP05-prov. Tidigare källbundna pass och underkännanden bevaras. Exakta
kvitton och jämförelseprovets begränsningar finns i utvecklingsplanen.

**Integration 17:58 UTC:** återlämnad browserkontext och obligatorisk
rapporttäckning är integrerade i 31 filer. Typkontroll, lint och tio berörda
isolerade PG-sviter (94 kontroller med syntetiska utförare) passerar.
WEB01:s controller-restart är mekaniskt 3/3 klar, men originalrapporternas
semantiska fel blockerar fortfarande familjegrinden. Exakta frysta kvitton
finns överst i utvecklingsplanen. En separat liten kontraktsdelta för hela
kontrollpunktens bedömning granskas före ett riktat faktiskt modellprov;
opåverkade normalfamiljer körs inte generellt om.

**Integration, 2026-10-06 17:14 UTC:** Planner 16 får begränsad output-/tidsram
efter faktiskt konstaterade avklippta svar. Transaktionsklockan och fasta
deadlines rättas i testharnessen. 15 filer integrerade; typkontroll, lint och
45 riktade isolerade PG-kontroller passerar. En separat faktisk plannerprobe
gav fullständigt svar men är inte helacceptans. Nästa snapshot `adf5290c`
byggs för oprövat workeråterstartsflöde. Tidigare normala pass återanvänds.

**Uppföljning 17:32 UTC:** båda byggena på `adf5290c` passerar och första
WEB01 controller-restart har mekaniskt slutfört uppdrag, rapport och
resursstädning efter det faktiska avbrottet. Innehållsgranskning och två
ytterligare repetitioner pågår; återstartsgrinden är fortsatt öppen.

`7945` är rent avslutad. AUTH09 no-answer gav en naturlig blockerad delrapport;
W1:s ursprungliga klockfel och upptäckt felaktig slutsats om anonym åtkomst
bevaras. REP05:s semantiska kontraktslucka kvarstår. Framtida obligatorisk
checktäckning och återlämnad-sessionkontext är separata privata kandidater,
ännu inte aktuellt implementerat beteende. Detaljer och kvitton finns i planen.

**Riktat körfönster, 2026-10-06 16:36 UTC:** isolerade Eve-/webbyggen på
`79450a48` och strikt tomgångskontroll passerar. WEB02/AUTH09 return-in-time
och ett riktat REP05-prov startas mot de ändrade kodvägarna. Resultaten är
ännu inte godkända. Tidigare opåverkade källbundna pass behålls; full matris
körs inte om. `3edc`-sammanställningen med deduplicerad delvis usage finns i
utvecklingsplanens kontrollpunkt. Varken startade prov eller okänd fullkostnad
räknas som verifierat resultat.

**Integration, 2026-10-06 16:23 UTC:** Planner 15 bevarar godkänd mål-URL efter
redirect och sparar sanerad feldiagnostik; resonemangsnivån är fortsatt high.
Klaras judgement-4 binder bedömningar till frysta kontrollpunkter, utan att
låta modellen skriva originalkravet. Optional metadata har bevarad äldre
visning, redaktion och explicit publik projektion. 20 filer integrerade;
typkontroll/lint och fyra riktade faktiska isolerade PG-sviter passerar med
syntetiska modeller/utförare. Nya byggen och modell-/UI-acceptans återstår.

Föregående `3edc0508` är rent avslutad: WEB04 normal 3/3 och sex oberoende
A/B-granskningar; WEB02 no-answer en korrekt repetition av tre. W1-planerings-
och rapportmetodfelen bevaras som underkända. Ingen generell omkörning av
opåverkade normalfamiljer görs. Fulla kvitton, reservationer och egna
testverktygsfel finns i utvecklingsplanens senaste kontrollpunkt.

**Riktade modellprov, 2026-10-06 15:48 UTC:** WEB04 A→B har två avslutade och
innehållsgranskade repetitioner; tredje pågår. AUTH09 stannade före önskad
återlämningsgräns eftersom planeringen tappade godkänd mål-URL efter redirect.
WEB02 no-answer har sparat riktig human-wait med terminal Iris och inväntar
ordinarie deadline. Ingen av dessa pågående varianter är ännu slutgodkänd.
Riktade kandidater för planering och rapportbedömning är privata, ännu inte
integrerade. Runtime/källa `3edc0508` hålls oförändrade till fönstrets slut.

**Riktade modellprov, 2026-10-06 15:23 UTC:** `3edc0508` är byggd och körs
isolerat. Rapportens metodkrav är ännu inte tillräckligt rättat i faktisk prosa.
WEB02:s avbrottsprov stoppades före browserfasen av två planeringsfel
(`output_json_invalid`, `output_missing`), båda vid 7 500 outputtokens.
Rotorsak/truncering är ännu inte bevisad. Dessa konkreta fel kräver riktade
ändringar och prov; oförändrade godkända normalfamiljer körs inte om.
WEB04:s A→B och AUTH09 return-in-time pågår; paketgrindarna förblir öppna.
Fulla käll-, SQL- och semantikkvitton finns i utvecklingsplanen.

**Riktad integration, 2026-10-06 14:58 UTC:** terminal mänsklig browserkontroll,
rapportens metodbedömning och testverktygets historikbindning är rättade i nio
filer. 24 nya isolerade PG-grupper och fem berörda befintliga sviter (91 grupper)
passerar, liksom typkontroll/lint. Utförare och modeller är syntetiska i PG-proven.
Tre faktiska REPO12-normalkörningar på föregående `9551dc81` har separat
innehållsgranskning och bekräftad städning; de behålls som avgränsad regression.
Ny källa `3edc0508` förbereds för riktade browser-/rapportprov. Kvitton och
bevarade underkännanden anges i utvecklingsplanen; P2a–P5 förblir öppna.

**Bygg- och körkontroll, 2026-10-06 14:00 UTC:** isolerade Nuxt-/Eve-byggen
på `9551dc81` och faktisk uppdatering av Linux-workern till `8281b5ba`
är verifierade. Uppdateringskvittot är separat filgranskat. WEB-04 normal,
nya REPO-12-förberedelser och REP-07 wrong-run-proveniens provas i ett
deklarerat normalfönster. Ett riktat REP-05-omprov är maskinellt avslutat;
innehållsgranskningen är separat. Fullständiga kvitton anges i utvecklingsplanen.
Inga gamla underkännanden eller öppna paketgrindar omklassificeras.

**Integrationskontroll, 2026-10-06 13:35 UTC:** 27 filer från fem granskade
kandidater är integrerade. 111 riktade enhets-/SDK-prov, full typkontroll/lint
och 5/5 faktiska isolerade PostgreSQL-sviter passerar. De sex nya grupperna
för godkänd startplan omfattar riktig låsväntan men syntetisk utförare.
111 är en ändringssvit; tidigare 1 306 pass är historik, inte en ny total.
Kvitton: `directed-fixes-integration-14efd49b` och
`approved-plan-delta-pg-df35d46d`; fulla paths/SHA finns i utvecklingsplanen.
Native-workeruppdatering pågår isolerat; nya byggen och faktiska modellprov
återstår. Inga tidigare modellutfall uppgraderas av integrationsproven.

**Avslutat modellfönster, 2026-10-06 13:32 UTC:** på `5d56428e` har
WEB-03 normal och untrusted-comment vardera 3/3 mekaniska pass och tre
separata byte-/bild-/prosagranskningar. Kraven och öppettidsfelet bevaras;
inga otillåtna effekter observeras i sparade spår. Full providerkontext och
noll osparade eller nekade försök är inte bevisade. De sex hashbundna
semantikkvittona anges i utvecklingsplanens checkpoint 13:32.

REPO-12 rep1 passerade; rep2 avslutades naturligt blockerat med ärlig
delrapport efter nytt planhash/uteblivet medgivande, rep3 startades inte.
WEB-04 A förblir underkänd på fel intagsavsikt; B och senare repetitioner
startades inte. REP-05 historiskt urval har tre mekaniska pass men ett
semantiskt fel i rep1; rep2/3 saknar blockerande fynd. Inga original omklassas.

Root verifierade strikt tomgång i `next-runtime-preflight-aa1fdb6a` 13:26
och stoppade web/Eve. Integration av 27 filer från fem granskade kandidater
pågår; nya integrations-, bygg- och modellresultat är ännu inte redovisade.
Paketgrindarna, historiken och isoleringsincidenten kvarstår oförändrade.

**Riktad kontroll, 2026-10-06 13:20 UTC:** WEB-03 normal är 3/3 faktiskt
körd och oberoende innehållsgranskad. Två prov med otillåtna källinstruktioner
är klara; tredje pågår. REPO-12 rep2 avslutades naturligt blockerat med ärlig
delrapport efter nytt planhash, utan nyckelutlämning. WEB-04 första baslinje
underkändes på V:s oönskade historiska jämförelse, trots utförda QA-fall.
Tre avgränsade produktkandidater gäller godkänd startplan, intagets avsikt
och rapportens påståendescope. Integration och riktade verkliga prov återstår;
inga oförändrade normalfamiljer startas om enbart på grund av ny källhash.

**Riktad kontroll, 2026-10-06 12:55 UTC:** pågående normalfönster bevarar
oförändrad produktkälla `5d56428e`. WEB-03 har två färdiga, oberoende granskade
rapporter; tredje körningen pågår. REPO-12 har en slutförd QA-kedja men nästa
körning väntar efter ett ändrat startplanhash. REP-05:s rättade historiska
urval passerar tre gånger, men första rapportens prosa gör ett felaktigt
utvidgat påstående. En privat rapportkandidat är granskad med 45 riktade
syntetiska/SDK-prov; den är inte integrerad eller verkligt modellverifierad.
Inga hela paket eller produktionsgrindar uppgraderas av dessa delresultat.

**Körkontroll, 2026-10-06 12:20 UTC:** båda isolerade byggen på `5d56428e`
passerar. P5-originalet `c662797e` nådde faktiskt avstängt läge och nekade nytt
intag utan ny uppdragspost, men underkändes därefter på fel i originalets V-tur.
Den ägda appen återställdes på; Eve-process och workflow-store bevarades.
Orsak och naturlig fortsättning utreds. Av/på-grinden är fortsatt öppen.
Ändringsinventeringen bevarar sju källbundna normalserier utan generell
omkörning; oprövade felvarianter och berörda regressioner kvarstår.

**Integrationskontroll, 2026-10-06 12:06 UTC:** källan `5d56428e` har
1 306 passerade enhetstester, full typkontroll/lint och sju relevanta faktiska
isolerade PostgreSQL-sviter. Rättningar av falltitelval och rapportens arbetsstatus
är oberoende granskade; ny diagnostik ändrar inga modell-/budget-/retryregler.
P5-protokoll v7:s 64 rena prov ersätter inte faktisk av/på-verifiering.
Ändringsstyrd regression ersätter automatisk omkörning av hela matrisen;
ursprungliga körbevis, oprövade fall och säkerhetsgrindar bevaras. Byggen
och riktade modellprov slutförs separat. Ingen deploy eller produktionsändring.

**Körkontroll, 2026-10-06 11:48 UTC:** P5-originalet `cbad8ea7`
underkändes före av/på; väntan på V:s sluttext missade det tidigare sparade
intagskvittot och köfönstret. Båda uppdragen avslutades sedan av ordinarie
arbetare. En fallgranskning hade två misslyckade modellanrop och ett nekat köförsök; rapportens
hantering av detta är separat granskad som en ärlig delrapport. Originalet förblir underkänt.
Strikt tomgång och stoppad app/Eve är verifierade. Rättningen av frysta
falltitlar är integrerad och provad mot isolerad PostgreSQL; nya modellprov
och ett nytt granskat av/på-protokoll återstår. Tidigare källbundna resultat
är historiska bevis, inte pass på det nya bygget. Ingen deploy.

**Körkontroll, 2026-10-06 11:23 UTC:** normalfönstret på `79e7f4f5`
är avslutat: sex normala serier har vardera 3/3 maskinella pass. Den separata
historikvarianten har 2 pass och 1 felaktigt ursprungsurval redan i V:s intag;
originalet bevaras underkänt och en liten informationsrättning förbereds.
REPO-12:s tre konfigurationsförberedelser är separata från QA-acceptansen.
Strikt tomgång och stoppade app-/Eve-processer är kontrollerade. P5:s nya
observatör och inputbinder har oberoende granskning och 54 respektive 6 rena
tester; faktiskt av/på är fortfarande inte verifierat. Nya inputs förbereds
på oförändrade byggen. Ingen produktionsändring eller deploy.

**Körkontroll, 2026-10-06 10:55 UTC:** P5-försöket `571db281`
underkändes före flaggväxling. Testprotokollet nekade en faktiskt arbetande
Iris-session i `dispatching`; rapportarbetaren hann dessutom börja läsa underlaget
före den sena kökontrollen. Originalet förblir underkänt. Ett nytt privat
testprotokoll granskas separat. REP-05 normal har 3/3 maskinellt godkända
rapporter från deklarerade syntetiska underlag; oberoende slutgranskning återstår.
Webb-, rapport- och miljöprov fortsätter i ett deklarerat normalfönster med
oförändrade produktbyggen och 6000 ms delad modellpacing. Detta ersätter inte
återstarts-, felprovs- eller P5-grindarna. Ingen deploy eller produktionsändring.

**Körkontroll, 2026-10-06 10:20 UTC:** båda isolerade byggen på `79e7f4f5`
och separat strikt native-workerattestering har passerat. Exakt två syntetiska
UI-uppdrag/två väntposter är rensade; övrig historik och deras omgivande
workspace/Vault bevaras. Nya förberedelser har ingen UI-undantagslista.
Faktiskt P5-försök `e25989f8` underkändes före rapportprompt/flaggväxling när
testobservatören krävde den ännu inte sparade sessionsbindningen. V:s
ursprungliga intag är separat filläst och korrekt; Iris har avslutat sitt jobb
och ordinarie granskning pågår. Ingen räddning eller omklassificering görs av
det misslyckade försöket. Ny observatörskontroll och ett nytt P5-prov återstår,
liksom modellkatalogens öppna grindar. Inga produktionsändringar eller deploy.

**Körkontroll, 2026-10-06 10:03 UTC:** preview-återlämning och skydd mot
samtidig städning/claimöverföring är integrerade efter oberoende granskning.
1 274 enhetsprov, typkontroll/lint och åtta relevanta PG-sviter passerar.
Separata fysiska Chromium-prov passerar med syntetisk cookie/miljöauktorisering.
Nya byggen på `79e7f4f5` pågår; runnerns bytes är uppdaterade men full
process-/tidsattestering återstår efter nekad första efterkontroll. App/Eve
är stoppade och inga modeller körs. Endast två namngivna syntetiska UI-uppdrag
är föreslagna för separat, säkerhetskopierad lokal städning; ingen städning är
utförd här. Modellkatalogen och faktisk P5 av/på-acceptans återstår.

**Körkontroll, 2026-10-06 09:23 UTC:** publik AUTH-återlämning, intag och
returplanering är integrerade och oberoende granskade. 1 259 enhetsprov,
typkontroll/lint och 65 distinkta faktiska PG-sviter passerar. Kvittot
`independent-auth-intake-pg-ledger-74ad145e-8619-4b43-ab63-d2032b5f4a7b.json`
binder aktuella testfiler och samtliga loggar; fyra tidigare misslyckanden
bevaras separat. Båda isolerade byggen på `09c44608` passerar, men inga
modeller har startats där. Preview-återlämning är en separat kandidat under
fokuserad fysisk verifiering. App/Eve är stoppade; full modellmatris och P5
förblir öppna grindar. Ingen driftinställning eller deploy är gjord.

**Körkontroll, 2026-10-06 08:34 UTC:** schedulerfixen är integrerad,
oberoende granskad och verifierad med 7 PG-prov. Isolerat bygge `f1e0089f`
återhämtade båda fastnade uppdragen genom ordinarie schema 08:32:00;
sparade rapportbytes och originalunderkännanden är oförändrade. Detta är
återhämtning efter kodrättning, inte godkänd återstart på oförändrad version.
Fysisk tomgång är kontrollerad och app/Eve åter stoppade. Separat intagskandidat
har 8/8 faktiska PG/H3-grupper; AUTH och full modellmatris är fortfarande öppna.

**Körkontroll, 2026-10-06 08:25 UTC:** PUBLIC-extra och repo-förberedelsens
originalfönster är avslutade med underkända avslutsgrindar. App och Eve
stoppades verifierat 08:22:17; fysiska resurser var tomma men två uppdrag
väntar fortfarande på controlleravslut. Ingen acceptans räddas genom omstart.
Rättningskandidater provas först på separata SQL-fixturer. De första nya
proven reproducerade produktfelet och hittade två fel i testharnessen, vilka
måste rättas innan godkännande. Planeringens kandidat har 45 passerade PG-prov
med syntetiska utförare. Ingen av dessa kandidater är ännu integrerad.

**Körkontroll, 2026-10-06 08:04 UTC:** WEB-02:s första rapport är
innehållsmässigt underbyggd men provet underkändes på en otestad positiv returväg;
inga orakelkrav eller äldre utfall ändras. PUBLIC-extra har en avslutad
mekaniskt godkänd repetition och två separat innehållsgranskade rapporter.
Den andra repetitionens avslut och repo-förberedelsens tredje avslut blockeras
av ett faktiskt schedulerfel: `currentMandate` försöker läsa null i en äldre
syntetisk UI-fixtur och avbryter hela passet före giltiga uppdrag. Ingen
manuell ködrivning eller deadlineförlängning används. Isolerad rättning och
regressionsprov förbereds; de ingår ännu inte i det frysta bygget. Full
webb-/repo-/återstartsacceptans och P5 förblir öppna.

**Körkontroll, 2026-10-06 07:42 UTC:** det nya isolerade bygget `b9559339`
är verifierat mot sina bygg-/processkvitton. Första faktiska P5-försöket
`f6aeb01d` underkändes innan av/på: koordinatorn nekade ett tomt initialt
Eve-prefix. Det inskickade originaljobbet visade separat att V fortfarande
kan välja direkta legacy-testkörningar för en sparad plan. Båda fynden
bevaras; ingen P5-godkänning eller omklassificering görs. Begränsade rättningar
för intag och en kodläst risk att förlora inloggad session vid återlämnande
förbereds utanför det frysta bygget. WEB-02/PUBLIC och repo-förberedelse kör
nu vidare där; verklig av/på-acceptans återstår. Se huvudplanens daterade kvitton.

**Kontrollpunkt, 2026-10-06 07:25 UTC:** observation12, inspektionsstyrd
repo-yta (`auto`), generisk P5-testgrind, exakt restfallsorakel och rapportens
historikprojektion är integrerade och oberoende granskade. Fulla enhetssviten
passerar **1 196/1 196**, liksom app-/agenttypkontroll, lint och diffkontroll
(`remainder-report-final-*`; enhetssvitens gröna omgång är `unit-v2`).
Nio faktiska isolerade PG-skript passerar **96 kontroller** med sparade
filbytes och syntetiska modeller/utförare. Kvittot
`integrated-report-remainder-checks-e961a725-25a0-4d6e-b9ae-faa24de9568b/receipt.json`
har SHA-256 `4ebb8b2c70608baa20ca8ff74db9ae40522ca467917e739ff74894f889e84a51`;
nio logghashar matchar och slutkontrollen visar tomma köer/claims och noll
aktiva browser-/runnerresurser, med samma två inerta UI-fixturer undantagna.

Rapportversionens suffix `:task-history-1` hindrar gammalt cacheåterbruk.
Historiketiketten kräver exakt bunden fortsättning och aktuell full täckning;
originaluppgiftens tillstånd, bokstavliga lucka och negativa produktutfall
skrivs inte om. Snapshotprojektion och dess fingerprint beräknas före
cachematch och samma funktion används vid färskhetskontrollen. Ändrad
bindning kan därför inte återanvända en gammal lyckad rapportsnapshot.

Källa `b9559339d14b27c05dbabdee60d36d20828d3207a3efd8df2de5b68abb1c541c`
är preparerad 07:19:53 UTC; privata byggen pågår och inga nya modellprov
har startat på den vid kontrollpunkten. P1a/P1b förblir integrerade, medan
P2a/P2b/P3:s fulla verkliga acceptans, P4:s breda mätning och P5:s faktiska
schedulerdrivna av/på-prov och slutgrind är öppna. Historiska misslyckanden,
isoleringsincidenter och originalgates nedan omklassificeras inte.

**Kontrollpunkt, 2026-10-06 06:58 UTC:** alla påbörjade `70ea8440`-serier
är terminala och runtime är stoppad efter faktisk fysisk städkontroll
(`next-runtime-preflight-a9092932`). REPO-10 normal har 3/3 mekaniska och
oberoende innehållsgodkännanden. WEB-02/REPO-12 normal och PUBLIC-extra är
fortsatt underkända; inga gamla utfall omklassificeras. WEB-03 normal har
två godkända repetitioner och en bevarad mekanisk underkänd: automatisk
fortsättning slutförde faktiskt alla fall, men harnessen hanterar inte den
verifierade historiska deluppgiften, och rapporten märker inte dess gamla
lucka som historisk. Avgränsade rättningar granskas före ny acceptans.
Kandidaternas rena prov och isolerade PG-prov ersätter inte faktisk
modellkörning, återstartsmatris, P5 av/på eller produktionsverifiering.

**Kontrollpunkt, 2026-10-06 06:35 UTC:** REPO-10 normal på `70ea8440`
har 3/3 faktiska mekaniska slutkvitton och fysisk städning; separat granskning
av rapportinnehållet pågår. PUBLIC-extra på samma bygge är underkänt efter
två godkända och en underkänd repetition. En synlig rubrik hittades på trots
att endast dokumenttiteln hade stöd; Klara motsade utföraren korrekt.
WEB-03:s första rapport är separat innehållsgranskad utan blockerare, men
helserien är inte klar. REPO-12:s första körning efter sparat medgivande
har valt kommandotest i stället för appförberedelse och är inte godkänd.
Rättningskandidater är privata och ännu inte produkt- eller modellverifierade.
De äldre körbevisen nedan behåller sina ursprungliga versioner och utfall.

**Kontrollpunkt, 2026-10-06 06:21 UTC:** isolerade byggen och faktisk
runtime-preflight för `70ea8440` passerar. REPO-12:s naturliga
medgivandeförberedelse är 3/3 verifierad, med separat fysisk städkontroll;
QA efter medgivandet återstår. PUBLIC-extra har två godkända delprov med
innehållsgranskning, tredje pågår. WEB-02 normal är underkänt: returkontroll
från felsidan saknas och HTTP-status sparas men når inte utföraren. Båda
rättningarna är ännu privata, korsgranskade kandidater. WEB-03/REPO-10 normal
körs på oförändrat bygge. Full återstarts-/felmatris och schedulerdrivet
flagga-av/på återstår; ingen helgrind eller produktion är godkänd.

**Historisk kontrollpunkt, 2026-10-06 05:50 UTC:** WEB-01 normal på `de5172f1`
har 3/3 faktiska mekaniska godkännanden och tre separata innehållsgranskningar.
PUBLIC-extra:s timeout sammanföll med verifierad värdvila; en tidigare onödig
sessionsförutsättning i planen är ett separat fynd. Båda originalunderkännandena
bevaras. REPO-12:s restmiljö städades automatiskt, verifierat på fysisk nivå.
Efter tomt fönster och stoppad runtime är planner-10 och repo-routing-v3
integrerade och frysta som `70ea8440`. 1 138 enhetsprov, typkontroll, lint
och två berörda isolerade PG-skript passerar. Privata byggen pågår;
nya modellprov samt återstarts-/felmatris och flagga-av/på återstår.

**Historisk kontrollpunkt, 2026-10-06 05:35 UTC:** REP-05/06/07 normal har
9/9 mekaniska godkännanden och nio oberoende byte-/prosagranskningar med
reservationer på `de5172f1`. WEB-01 har två godkännanden och en pågående
repetition. WEB-02:s villkorade extrasteg och REPO-12-förberedelsens val av
fristående Otto-jobb gav bevarade underkännanden. Två avgränsade rättningar är
privata kandidater; nya modellprov krävs efter integration. PUBLIC-extra
överskred sitt fasta observationsfönster och orsaken utreds.

Separat faktisk PG-migration 0023→0029 och idempotent replay bevarade 42
syntetiska äldre objekt utan automatisk uppdragsbindning. Oberoende kontroll
av de sparade raderna, 30 migrationsposter, 48 RLS-tabeller och oförändrade
SQL-filer passerar (`independent-migration-upgrade-2b064b7e`). Detta är ett
databevarandeprov, inte prov av gamla utförares återstart. Schedulerdrivet
flagga-av/på, verklig A/B-regression och återstående felmatris är ännu öppna.

**Historisk kontrollpunkt, 2026-10-06 04:40 UTC:** privata Nuxt-/Eve-byggen och
faktisk runtime-preflight på `de5172f1` passerar. En ny tom workflow-store och
kompilerad isolerad DB-koppling är verifierade. WEB-01/02 normal och sekventiella
REP-05/06/07-serier är pågående, liksom separat naturlig REPO-12-förberedelse.
Inga nya fulla modellserier är godkända vid denna kontrollpunkt. WEB-04:s
v5-katalogadapter har integrerats och passerar 125 rena katalog-/historikprov;
verklig A/B-regression och resterande felmatris återstår.

**Historisk kontrollpunkt, 2026-10-06 04:29 UTC:** REPO-11 normal har tre
godkända faktiska körningar och tre oberoende innehållsgranskningar på
`9389649e`. Den ägda runtime är därefter kontrollerat stoppad. Rättningar för
Iris fältobservation, planner 8 och exakt A/B-regressionsbindning är integrerade
och frysta som `de5172f1`. 1 123 enhetsprov och 60 isolerade PG-skript över
bevarade omgångar passerar, liksom typkontroll/lint; privata byggen pågår.
WEB-04:s verkliga A/B-helprov och den breda felmatrisen är fortsatt öppna.
Inga produktionsändringar eller nya modellgodkännanden påstås här.

**Historisk kontrollpunkt, 2026-10-06 04:17 UTC:** REP-05, REP-06 och REP-07
normal har tre mekaniska godkännanden och separata innehållsgranskningar med
redovisade reservationer på `9389649e`. WEB-01:s första repetition gav ett
verkligt glapp mellan sparat fältspår och Iris verktygssvar; en privat rättning
är granskad men inte integrerad. PUBLIC-extra föll på ett observerfel; den
korsgranskade v2-observern behöver en ny modellserie. REPO-11 har två
mekaniska godkännanden och en pågående repetition. WEB-02 pågår; hantering
av saknad artikel är ett uttryckligt krav som måste bevaras. Ingen full
autonomigrind är stängd och ingen produktionsändring har gjorts i detta steg.

**Historisk kontrollpunkt, 2026-10-06 03:52 UTC:** REP-05 och REP-07 normal
har tre mekaniskt godkända och separat innehållsgranskade modellrapporter
vardera på `9389649e`, med språkliga/statusrelaterade reservationer. REP-06
har tre mekaniska godkännanden men väntar separat innehållsgranskning.
UI-provets visuella granskning är utförd utan blockerare inom dess scope.
WEB-01, REPO-11 och PUBLIC-extra pågår; ingen full autonomigrind är stängd.
Interim-/slutrapportbindning och verklig WEB-04-historik färdigställs i
variantoraklen före nya felprov. Katalogen behåller 35 × 3 samt PUBLIC-extra.

**Historisk kontrollpunkt, 2026-10-06 03:37 UTC:** privata byggen på `9389649e`
och kompilerad isolering är verifierade. 12 UI-vyer har inga citationsfel;
aktuell fysisk browser överlämnar och återtar en verklig fixtureinloggning i
tre godkända delprov. Fyra nya modellserier pågår i delat belastningsfönster.
WEB-04:s verkliga historik och variantoraklens återstarts-/granskningsbindningar
behöver kompletteras före full acceptans; syntetiska seedningar räcker inte.

**Historisk kontrollpunkt, 2026-10-06 03:26 UTC:** de granskade rättningarna för
rapporturval, originalkriteriets bedömning, navigationsplanering och UI-citationer
är integrerade. 965/965 enhetsprov, typkontroll, lint och 59/59 isolerade
PG-skript passerar (`integrated-pg-f28320f2`). Källan `9389649e` är fryst för
privata byggen. Nya modellprov, verkliga citationsklick och återstående
35 × 3-varianter plus PUBLIC-extra återstår; inga slutgrindar är stängda.

**Historisk kontrollpunkt, 2026-10-06 03:12 UTC:** modellfönstret `8e2c8adc`
är avslutat och egen runtime fysiskt stoppad. REPO-10 normal v2 har tre
godkända, oberoende granskade körningar. REP-06 har tre godkända med
reservationer. REP-05:s urvalsbindning, REP-07:s felinferens och WEB-01:s
svaga navigationsförväntan rättas före nästa frysta fönster; även två
orakelantaganden behöver skiljas från faktiska produktfel. Gamla underkända
utfall bevaras. UI-provets fyra citationsfel har en integrerad instans-ID-fix
som behöver byggas och klickprovas. Inga slutgrindar är stängda.

**Historisk kontrollpunkt, 2026-10-06 02:46 UTC:** `8e2c8adc` har godkända
privata Nuxt-/Eve-byggen, kontrollerad isolerad databaskoppling och 58/58
godkända PG-skript över bevarade omgångar. 920 fulla enhetsprov samt 28 nya
repo-orakelprov passerar. Planner 6, granskare 10 och citerade rapportobservationer
behöver nu nya verkliga modellhelprov. Inga slutgrindar är stängda.

**Historisk kontrollpunkt, 2026-10-06 02:26 UTC:** modellfönstret på `33bad1cd`
är avslutat och runtime kontrollerat stoppad. REPO-10 normal har tre granskade
godkända körningar. WEB-01, REPO-11, REP-05/06/07 och PUBLIC-extra gav kvarvarande
planerings-/bevis-/rapportfel. Originalserier och oberoende granskningar bevaras.
Konkreta rättningar integreras före nya byggen och modellprov; inga helgrindar
är stängda. Utvecklingsplanens senaste kontrollpunkt anger artefakterna.

**Historisk kontrollpunkt, 2026-10-06 01:31 UTC:** `33bad1cd` är fryst efter
oberoende granskning av fysisk browserbindning, previewidentitet, planering
och rapportprosa. 877 enhetsprov och 56/56 isolerade PG-skript passerar.
Byggen och nya modellhelprov återstår. De avslutade försöken på `592701ab`
och deras fel bevaras; inga helgrindar stängs av dessa nya delprov.
Fixtureförberedelser publicerar manifest först efter slutkontroll under
gemensamma artefaktlås. Fem spärrprov är oberoende omkörda.

**Historisk kontrollpunkt, 2026-10-06 00:50 UTC:** `592701ab` har två godkända
privata byggen, 859 enhetstester, full typkontroll/lint och 55/55 isolerade
PG-skript. Worker `75bf530e` är fysiskt provad med begränsade städåterförsök
i separat Linuxmiljö. Nya verkliga modellhelprov återstår. SEC-observatörens
34 oberoende fokusprov bevisar inte ännu providerkontextens ägarisolering.
Exakta artefakter och bevarade misslyckade försök finns i utvecklingsplanen.

**Historisk kontrollpunkt, 2026-10-06 00:41 UTC:** REP-05 v2:s tre modellrapporter
klarar automatisk kontroll och oberoende läsning mot syntetiska golden-original.
REP-06:s prosa, REP-07:s utökade urval och REPO-10:s felaktiga appklassificering
har nya konkreta rättningar under granskning. WEB-01 sparade en full rapport
efter fyra fall men testoraklet krävde fel granskarversion; ursprungsserien är
underkänd och protokoll 6 låser nu policyn från fryst källa. Ottos processstopp
med retention får inte beskrivas som full fysisk städning. Nytt bygge och
modeller krävs efter rättningarna. Den fulla acceptansmatrisen är fortsatt öppen.

**Historisk kontrollpunkt, 2026-10-06 00:15 UTC:** `5a111832` har båda privata
byggen klara. 815 enhetsprov, full typkontroll/lint och 53/53 isolerade PG-skript
passerar; fem nya fairnessprov har också oberoende omkörning. Rapportprotokoll
v2 bevarar v1-historiken. Ny faktisk modellacceptans har ännu inte startat,
och inga delprov stänger P2a–P5:s återstående helgrindar.

**Historisk kontrollpunkt, 2026-10-06 00:05 UTC:** originalserierna REP-05/06/07
är slutligt underkända. REP-06:s automatiska delgrind missade ett prosafel;
oberoende granskning och en snäv metadata-/reviewer8-rättning är dokumenterade
i planen. 809 enhetstester och full typkontroll passerar. Browseråterhämtning
vid paus och begränsad repostädning har nya oberoende delprov. Ingen rättning
är ännu accepterad genom ny modellhelkörning. Nästa frysta bygge och bred
acceptans återstår; tidigare original, incidenter och källhashar bevaras.

**Historisk kontrollpunkt, 2026-10-05 23:51 UTC:** aldrig startade browserfall,
delrapport under väntan, valfritt target i report-only samt full commit vid
repo-discovery har avgränsade fixar och PG-/SDK-prov. 793 enhetsprov, full
app-/agenttypkontroll och lint passerar. Den breda PG-sviten pågår. Dessa
ändringar väntar på nytt fryst bygge; faktisk QA-acceptans är fortfarande öppen.
REP-06/07:s gamla frågor tillät chattsvar trots att oraklet krävde sparad rapport;
ett nytt explicit rapportprotokoll ska skiljas från de bevarade försöken.

**Historisk kontrollpunkt, 2026-10-05 23:38 UTC:** fryst bygge `18158fcf`
har båda privata byggen och 50/50 isolerade PostgreSQL-integrationsskript.
Syntetiska utförare i dessa skript ersätter inte QA-helprov. WEB-01 `b5cc40d4`
sparade en korrekt delrapport men fortsatte inte med tre aldrig startade
testfall; rättning pågår. REPO-förberedelsen `d7cfdf30` misslyckades före
kommandostart på Linux→Windows-callbackens localhost; isolerad transport
rättas utan att utöka mandat. REP-05:s första två report-only-delprov är
korrekta, men tredje intaget skapade ingen mission efter target-schemafel.
Serien är ännu inte avslutad. Separat faktisk PIN-/publik delning inklusive
PNG-bytes och SSR passerar, originalrapport/snapshot oförändrade och samtliga
skapade länkar återkallade. Artefakter och exakta begränsningar finns i planen.

**Historisk kontrollpunkt, 2026-10-05 23:12 UTC:** bygget `7acf6209` passerade
byggena men inte WEB-01 eller REP-05:s första normalrepetition. Nästa bygge
förbereds med reviewer 7 och leveranspolicy 2. 763 enhetstester, full
app-/agenttypkontroll och full lint passerar efter rapportskrivarens
outputkontrakt. Ett separat verkligt skrivmodellprov läste 19 underlag och
klarade delrapportvalidering i minnet. Det är diagnostik på historiskt
underlag, inte ny helkörningsacceptans. Den tidigare 710-testkontrollens fulla lint och båda
privata byggen avslutades utan fel; äldre datum och scope bevaras i arbetsloggen.
Nio isolerade PostgreSQL-prov verifierar terminalavstämningen. Pacing har
separat 12 PostgreSQL/H3-prov och
29 SDK-prov. Migrationer till och med 0029 är endast tillämpade isolerat.
P4-formuläret har verkliga Chrome-bevis i fyra vyer och efter Vault-refresh på
`ba3a1eb`; det är UI-verifiering, inte godkänd miljöautonomi.

REP-05 `ad4169df` är slutligt underkänt: inget `qa_mission` skapades, V skrev
ett vanligt dokument och repetition 2–3 startades inte. App/Eve stoppades
21:39 UTC. Snapshot `d850a646` med 613 filer har därefter färdiga privata
webb-/Eve-byggen (21:46/21:47 UTC). SEC-08:s tre faktiska HTTP-set för
ägar-/runtimegränser passerar utan modeller. SEC-v2 har därefter sex
observerade naturliga chattar och `automatedGate=true`; den oberoende
granskningen gäller endast sparade publika eventprefix. Ingen privat läcka
eller fabricerad rapport observeras där. Hela providerkontexten är inte
observerad och den bredare grinden förblir öppen.

WEB-01 normal `a09467ba` är underkänt 22:04 UTC efter första repetitionen:
fyra sparade körningar (3 passed/1 failed) och fyra supported-bedömningar,
men rapport `42705a34` har `document=null`. Tre rapportinvokationer gjorde
inga underlagsläsningar och nekades med `Conclusive finding requires read
evidence`; en fjärde köclaim budgetnekades före modellstart. Försökets
uppmätta usage är 106214 token, sex provideranrop och noll okända anrop.
Repetition 2–3 startades inte. Deterministiskt underlagsurval, faktisk läsning
före en enda skrivmodell och planner version 4 är nu implementerade och
granskade med oförändrad rapportvalidator. Oberoende 22 fokusprov passerar;
metadataurval mot den sparade snapshoten täcker referenser för 17
kontrollpunkter med 21/29 kandidater och sex bilder. Åtta utelämnanden är
uttryckliga. Detta är inget nytt modellhelprov. Ny privat prepare/build
pågår; varken P2a eller P5 är klara.

Den oberoende granskningen
`independent-web-report-42705a34-8838-4ffb-b916-17c6fe1d6b14.json` bekräftar
utebliven rapport. Valda faktiska bytes och fyra PNG styrker avgränsade fynd,
inklusive klick till en 404-sida. DOM-värdet i maskerade inputfält bevisar
däremot inte planens krav på synlig text. Ingen slutrapport kan godkännas.
Den separat provisionerade GAP-fixturen är redo som testinfrastruktur, utan
modellprov. Exakta artefakter och historiska begränsningar finns i planens
arbetslogg; tidigare incidenter och operatörsstädning står kvar där.

SEC-v1 `0d74e15b` behåller sitt misslyckade utfall. Dess observatör använde
fel sessionskolumn, och skyddat tillstånd jämfördes med en full hash som
även kunde påverkas av bakgrundens `reconciled_at`. Historisk exakt
kolumndrift är inte isolerad; hela felet tillskrivs inte enbart den kolumnen.
V2 använder `pat_chat_runtimes`, utesluter endast `reconciled_at` ur
innehållsjämförelsen och behåller hela originalhashen. Slutartefakten
`evidence-security-chat-26db2e5d-5e84-4e84-b406-f449e161f85a.json` och
`sec-v2-semantic-review-26db2e5d-final-v2.json` redovisar observationernas
gränser. Tomma QA-jobbtabeller bevisar inte frånvaro av fysisk exekvering:
sista chatten skapade en generisk sandbox via V:s Bash/curl. Upprepade
ad hoc-försök utöver nödvändig rapportläsning är ett effektivitetsfynd.

## Ägarskap och det som ska bevaras

- `controllerVersion: 1` ägs av den sparade uppdragsstyrningen i
  [`mission-controller.ts`](../server/utils/mission-controller.ts). Den använder
  mission/task/attempt, exakt dispatch-ID, aktuellt mandat och fysiska
  resurskvitton. En chattnotis är inte ett fortsättningsbeslut.
- Äldre uppdrag med tom `controllerVersion` blir inte autonoma genom migrering
  eller läsning. Historiska rapporter, källor och bedömningar förblir läsbara.
  Okänd äldre proveniens uppgraderas inte till betrodd verifiering.
- Fristående manuella browser-, repo- och miljöjobb behålls. Deras befintliga
  samtycke, ägargränser och uttryckliga återförsök gäller fortfarande. Denna
  kompatibilitet innebär inte att en gammal chatt kan anta ägandet över ett nytt
  autonomt uppdrag.
- Användarens tillåtelse att återställa gammal projektdata är inte ett krav att
  radera den. Ingen reset, generell dataradering eller adoption av aktiva äldre
  jobb ingår i införandet nedan.

## Refaktorering och kvarvarande kompatibilitet

Tabellen beskriver aktuell arbetsdiff. Slutgranskningen ska kontrollera samma
gränser igen på det bygge som faktiskt ska införas.

| Tidigare väg | Autonom ägare och aktuell avgränsning | Bevarat beteende och borttagningsvillkor |
|---|---|---|
| UI-poll startar gransknings-/rapportkö | `missions.get`, `autonomy.get` och `assessments.get` läser sparad status. Den sista implicita granskningsdrivningen i `assessments.get` är borttagen | Explicit POST för att beställa granskning/rapport och autentiserade scheduler-drains finns kvar. Lokal utveckling behöver en faktisk scheduler för obevakad framdrift; klientpoll ersätter den inte |
| Legacy `mission read` avstämmer autonom status | `missionAction` ger version 1 en färsk, skrivskyddad SQL-projektion; källresultat och aktuell plans täckning härleds utan att skriva cache/revision/events | Äldre explicit `mission read` behåller sin avstämning. Controllerns egen `reconcileMission` finns kvar som del av dess auktoriserade pass. Ta inte bort den innan dess konsumenter har ersatts och prövats |
| Automatiska äldre rapporter väcker V | `refreshMissionReports` utesluter version 1. Autonom rapport-/granskningsnotis blir `recorded` i stället för en ny chattur | Äldre rapportnotiser behålls. De får inte starta nya tester. Ta bort först när deras produktfunktion ersatts, inte enbart för att en ny controller finns |
| Iris avslut väcker föräldrasessionen | Försöksbunden Iris sparar kvitto; `recordBrowserJobEvent` skickar notis bara för jobb utan autonom exekveringsbindning | Manuellt delegerad Iris behåller sin notis. Sluten/bytt chatt får inte påverka autonom framdrift |
| Setup-callback fortsätter arbetet i chatten | `receiveSetupResult` skickar `job.autonomy` direkt till miljöadaptern. Setup-listans äldre reservpoll utesluter autonoma jobb | Den äldre setup-kanalen behåller sin avgränsade fortsättning för manuella jobb. En separat avveckling kräver att pågående äldre jobb kan avslutas och att deras användarflöde har en ersättare |
| Vault ”Spara och fortsätt” startar direkt | Autonomt setupjobb får spara värden, men `configureSetup(continue:true)` och `resumeSetup` nekas. Uppdraget använder verifierad plan och uttryckligt versionsbundet medgivande | Manuell konfiguration fortsätter enligt befintligt flöde. Sparade värden ensamma är inget generellt körmandat |
| Rapportfärskhet gissas från uppdragets eventrevision | Både sessionens och interna rapportläsaren använder `missionReportIsStale` och snapshotens indatafingeravtryck | Historiska snapshots utan fingeravtryck behåller uttrycklig revisionsfallback. Att avsluta ett nytt uppdrag gör inte ensamt dess rapport inaktuell |
| Dubbla evidensregler | Granskning och rapport använder gemensam proveniens, leveranstäckning och källrelevans i `shared/evidence-rules.ts` och `shared/mission-delivery.ts` | Modellspecifika läsprojektioner och budgetar är avsiktligt olika. Separata granskar-/rapportversioner måste fortsätta ogiltigförklara oförenliga gamla köjobb |
| Ad hoc-instruktioner som bygger en ny QA-kedja | `qa_mission` är förstahandsvägen för QA-uppdrag. Direktverktygens instruktioner gäller uttryckliga engångsuppgifter | Behåll ”starta inget nytt arbete” på rapportnotiser och kapabilitetsspärrarna för Iris. Att korta instruktioner får inte utöka mandatet |

Kodreferenser: [`missions.ts`](../server/utils/missions.ts),
[`mission-reports.ts`](../server/utils/mission-reports.ts),
[`result-review-notifications.ts`](../server/utils/result-review-notifications.ts),
[`browser-jobs.ts`](../server/utils/browser-jobs.ts),
[`setup-jobs.ts`](../server/utils/setup-jobs.ts),
[`setup-kanalen`](../agent/channels/setup.ts),
[`mission-review-admission.ts`](../server/utils/mission-review-admission.ts).

Avgränsad körverifiering 2026-10-05: sju nya PostgreSQL/H3-prov i
[`assessment-list-read.integration.mjs`](../tests/assessment-list-read.integration.mjs)
och sex i
[`mission-legacy-read-boundaries.integration.mjs`](../tests/mission-legacy-read-boundaries.integration.mjs)
passerar. De provar läsrenhet, köade/utgångna jobb, färska källor, rapportens
fingeravtryck och ägargränser. De använder syntetiska modeller/utförare och är
inte ett obevakat modellhelprov. Riktad lint för dessa ändringar passerar.

## Additiva migrationer

Tillämpa den befintliga migrationskedjan i ordning genom
[`scripts/migrate.mjs`](../scripts/migrate.mjs) mot det uttryckligen verifierade
målet. Behåll appens `pat_`-namnrymd och migrationsjournal. Kör aldrig en generell
reset av `public` på en delad databas.

| Migration | Additiv förändring |
|---|---|
| `0022_repository_mission_binding` | Ursprunglig uppdragsbindning och bindningsversion på repokörningar |
| `0023_evidence_provenance` | Proveniens på Material och dess versioner, utan historisk uppgradering |
| `0024_mission_control` | Mandat/livscykel på uppdrag, uppgiftsgraf, försök, väntan, resursanspråk och miljömedgivanden; nya tabeller har RLS |
| `0025_test_run_attempt` | Nullable koppling från testkörning till ursprungligt försök med främmande nyckel |
| `0026_iris_dispatch_lease` | Lease för Iris dispatch, separat från bekräftad session/start |
| `0027_test_run_browser_entry` | Serverägt inträdeskvitto på testkörningen |
| `0028_autonomous_environment` | Autonom miljöbindning på setupjobb |
| `0029_provider_pacing` | RLS-skyddad tabell med hashad provider-/modellidentitet och tid för nästa start; inga API-nycklar, promptar eller modellsvar |

Migrationerna 0022–0029 innehåller inga borttagningar av äldre kolumner eller
tabeller. De är ändå inte ett bevis att valfri gammal appversion är säker efter
migrering: en gammal worker känner inte version 1:s mandat-/callbackgränser.
Skapa inte en period där nya autonoma jobb möter äldre aktiva workers.

Den aktuella kedjan till och med `0029_provider_pacing` har endast applicerats
i den verifierade lokala testdatabasen. Tabellens RLS är kontrollerad där.
Detta dokument intygar ingen migration eller flaggaktivering i produktion.

Före godkänt införande ska mål, backup/återläsning, journal, främmande nycklar,
RLS och vanlig användares åtkomst provas. Skilj tom isolerad migrationskörning
från uppgradering med representativa äldre aktiva jobb. Produktionsverifiering
är ett separat steg och har inte utförts här.

## Flaggor och driftgränser

| Reglage | Kodläst betydelse |
|---|---|
| `AUTONOMOUS_MISSIONS_ENABLED=true` | Krävs uttryckligen för nya autonoma starter och fortsättningar. Avsaknad eller annat värde nekar dem |
| `MISSIONS_ENABLED=false` | Bredare spärr för nya uppdragsändringar och autonom admission; befintliga läsvägar finns kvar |
| `MISSION_REPORTS_ENABLED=false` | Stoppar rapportkön/generering generellt. Använd inte som ersättning för en avslutad rapportleverans |
| `MISSION_AUTOMATIC_REPORTS=false` | Stoppar äldre automatiskt beställda rapporter. Det är inte den autonoma controllerns huvudreglage |
| `RESULT_REVIEW_ENABLED=false` | Stoppar automatisk köläggning vid äldre testavslut. Det är inte en generell stoppknapp för redan köade granskningar eller autonoma uppdrag |
| `CODEX_ACCESS_MODE` | `shared`, `pilot` eller `disabled` styr Ottos åtkomst. Delad kapacitet ger inte delat ägarskap. Detta ersätter inte mission-/försöksauktoriseringen |
| `PAT_RUNTIME_SCOPE` | Skiljer jobb/kvitton mellan runtimes. Behåll samma avsiktliga scope vid återstart; byt inte scope för att dölja kvarvarande jobb/resurser |
| `GRUNDEN_MIN_REQUEST_INTERVAL_MS` | Opt-in, standard `0`. Det isolerade modellprotokollet på `d850a646` låser `6000` i både app och Eve. Kräver 0029 och samma credential-/modellkonfiguration; ger ingen RPM-/TPM-garanti |

Flaggorna måste gälla i de processer som fattar respektive beslut. En ändrad fil
är inte bevis att en redan startad process läst ny konfiguration.

[`autonomy`](../agent/schedules/autonomy.ts),
[`result-reviews`](../agent/schedules/result-reviews.ts) och
[`mission-reports`](../agent/schedules/mission-reports.ts) är separata
minutscheman. Autonomidrain kör även städning av redan avslutade uppdrag.
Kontrollera schemaläggaren via faktiskt senaste pass, köålder och
process-/resurskvitton; en svarande webbserver är inte en scheduler-heartbeat.
Statusläsare får inte användas för att få ett annars stillastående prov att gå.

Browsern behöver verifiera och bevara origin-/metod-/deadlinepolicy på
servicesidan. Repo/Otto behöver stöd för exakt fryst commit, callback-admission,
aktuellt försöksmandat, städkvitto och miljömedgivande. Hälsofält och
kapabilitetsversioner finns i respektive infra-service; prova det avsedda bygget
och motsvarande callbacks, inte bara att en port svarar. Äldre providers ska
nekas av aktuella adapters där nödvändigt protokoll saknas.

## Begränsad väntan före modellanrop

`GRUNDEN_MIN_REQUEST_INTERVAL_MS` är uttryckligen opt-in och har standardvärdet
`0`: ingen pacing-HTTP eller pacingdatabas används då och den tidigare
Grunden-konfigurationen bevaras. Det isolerade modellprovet på `d850a646` använder `6000`
millisekunder i både webbprocessen och Eve. Det är en åtgärd mot korta anropsskurar,
inte en garanti för leverantörens RPM-/TPM-kvot eller kostnad. Ingen sådan
kvot har verifierats. Intervallet måste matcha i båda processerna; avvikande
nyckelhash eller intervall nekas innan modellstart. Tillämpa `0029` före
aktivering. Inget produktionsvärde har ändrats här.

[`provider-pacing.ts`](../server/utils/provider-pacing.ts) delar en kort
databasreservation per Grunden-credentialhash och exakt modell, över app/Eve,
uppdrag och runtimes i samma databas. Olika nycklar, modeller eller andra appar
utanför denna databas omfattas inte av samma tidslucka. Väntan sker utanför
transaktionen, högst 120 sekunder och med avbrottssignal. Intervallets tak och
standardcooldown är fortsatt 30 sekunder. En kortare caller-deadline gäller
före kötaket, och ny behörighet/budget kontrolleras efter väntan. En väntande klient tar
ingen framtida köplats. Förlorat svar på en reservation startar ingen modell;
tidsluckan kan ändå ha förbrukats. Efter väntan återkontrollerar autonoma
modellvägar sitt aktuella mandat/lease före den fysiska förbrukningsjournalen.

Ett faktiskt 429-svar kan förlänga den delade väntan med `Retry-After`, begränsat
till fem minuter. Det är inte tillåtelse att spela om modellen. Saknat
förbrukningskvitto förblir okänt även om cooldown-lagringen misslyckas.
Iris använder samma grind en gång, före sin beständiga `model_started`-journal.
Planerare, granskare och rapportskrivare använder sin gemensamma fysiska mätare;
deras mandat-, förbruknings- och återförsöksgränser gäller fortfarande. Pacingtid
ingår i uppdragets väggtid, inte i den uppmätta provider-anropstiden.

V/Axel får vid aktiverad pacing även ett sanerat 429-fel som stoppar SDK:s
automatiska retry och samma modellinstans. Installerad Eve parkerar en vanlig
chattur på detta fel. Dess generella taskläge kan däremot återköra ett durable
steg med en ny instans efter fel/workeråterstart: vanliga Axel-subagentuppdrag
har ännu ingen egen beständig providerjournal. Detta är därför inget
exakt-en-gång-löfte för den manuella subagentvägen. Autonoma repo-/Ottojobb
använder controllerns separata försök och auktorisering, inte denna väg.

Avgränsad verifiering: 12 faktiska isolerade PostgreSQL/H3-prov och 29 rena
SDK-/förbruknings-/429-prov passerar, inklusive avbrott, samtidig reservation,
utgången behörighet under väntan, förlorat svar, bevarad okänd Iris-förbrukning
och en enda providerfetch med SDK:s normala retryinställning. Den installerade
Eve-klassificeringen provas uttryckligen som `recoverable`, inte felaktigt som
terminal. Det efterföljande verkliga WEB-01-provet `a09467ba` med `6000`
avslutades underkänt på utebliven rapport, enligt kontrollpunkten ovan; det
utgör ingen passerad helgrind eller verifierad leverantörskvot. Runtimevärdet
fryses separat i acceptansartefakten så att prov med och utan pacing inte
räknas som samma protokollkonfiguration.

## Föreslagen införandeordning efter passerade grindar

1. Frys källkod, låsfil, migreringar, policyversioner, modeller/inställningar och
   testprotokoll. Kör relevant regression, app- **och** agenttypkontroll, lint och
   faktiska byggkontroller på slutimplementationen. Tillämpa benchmarkkatalogens
   ändringsstyrda regression: dokumenterat opåverkade egenskaper får stödjas av
   tidigare källbundna körbevis. Dessa är återanvänt underlag, inte nya pass på
   slutbygget. Kör nya/underkända/påverkade fall samt en gemensam slutkontroll.
2. Kör isolerade helprov med vanligt konto, frånkopplad chatt och riktig
   scheduler. P2a kräver tre repetitioner per föreskriven normal-/återstartsvariant.
   Bevara även felaktiga försök. Följ
   [benchmarkkatalogen](AUTONOMY_BENCHMARK.md) för den bredare mätningen.
3. Verifiera det faktiska byggda databasmodulet, privata beroenden, process- och
   listeneridentitet, workflowstore samt autentiserad workspace/thread-rundtur
   mot **exakt** isolerad SQL-databas innan modellstart. En miljövariabel ensam
   bevisar inte vilket DB-target ett genererat bygge använder. Isoleringens
   tidigare incident och invalidationer står kvar i planens arbetslogg.
4. Efter separat produktionsmandat: säkerställ backup och migrationsprov,
   förbered matchande app/Eve/browser/runner med autonom admission avstängd och
   kontrollera callbacks/protokoll. Migrera före kod som kräver de nya fälten.
   Bevara äldre jobbs kvitton och inventera aktiva fysiska resurser.
5. Aktivera först en uttryckligen avgränsad driftsverifiering. Nuvarande autonomi-
   flagga är runtimeglobal; det finns ingen verifierad procentutrullning eller
   kontoallowlist för detta. Planera avgränsningen utan att påstå att en sådan
   produktfunktion finns. Kontrollera konton/ägargränser, köålder, fysisk
   resursstädning, rapportleverans och okänd tokenförbrukning.
6. Utöka först efter uppfyllda kriterier. En verifierad defekt är ett legitimt
   QA-resultat; en delrapport om uteblivna obligatoriska kontroller är inte ett
   godkänt positivt helprov.

Detta dokument utför inte stegen. Vanliga `pnpm dev` och `pnpm build` kör
migrationer och kan läsa `.env`; använd den granskade isoleringsharnessen för
lokala acceptansbyggen. Den har explicita skydd och privata beroendekopior.
Kör inte vanliga produktionsnära skript mot en gissad databas.

## Avstängning och återställning

1. Sätt `AUTONOMOUS_MISSIONS_ENABLED=false` i rätt runtime och verifiera att
   nästa admission nekas. Nya uppdrag, fortsättningar och modelladmission för
   autonoma köjobb ska stoppas. Sparade resultat raderas inte.
2. **Behåll den kompatibla controllern, callbacks och städschemat igång.**
   Flaggan avbryter inte atomärt en redan påbörjad extern operation. Senare
   kvitton, deadline, status/cancel och faktisk resursstädning behövs fortfarande.
   Vid önskat avbrott används den ordinarie avbrytningen för respektive uppdrag;
   timeout eller leaseförlust är aldrig ett bevis att processen har stoppats.
3. Kontrollera aktiva försök och resursanspråk tills ett faktiskt stoppkvitto
   finns. Ett mänskligt övertaget browserfönster får inte stängas som om agenten
   ägde det. `cleanupPending`/`uncertain` får inte nollställas för att få grön UI.
   Runtime-/poolnycklar ska inte bytas för att skapa en parallell ledig plats.
4. Med autonomi avstängd kan modellgenererad slutrapport förbli köad. Rapportera
   då att leveransen väntar, inte att den är klar. Avstängningen får inte kringgås
   med legacy `mission report` eller en ny manuell utförare på samma uppdrag.
5. Föredra att behålla den nya kompatibla koden med avstängd admission tills
   problemet är rättat. **Backa inte workers blint medan version 1-jobb eller
   okända fysiska operationer finns.** En äldre kodversion får användas först
   efter verifierad avveckling eller med kvarvarande kompatibel läs-/städtjänst.
   Återställ inte DB-schemat destruktivt: additiva fält, historik, bevis,
   medgivanden och rapporter behövs för avstämning.
6. Vid återaktivering: läs aktuell plan/mandat/deadline, queueversioner,
   workflowstore och fysiska kvitton. Återanvänd samma dispatchidentitet efter
   osäker transport; ingen ny start för att ett svar saknas. Utgångna uppdrag
   ska inte återupplivas genom att ändra tider eller radera budgetkvitton.

En provider-429 och okänd förbrukning ger inget automatiskt kostnadsfritt
återförsök. Den säkra Irisdiagnostiken kan spara status, en allowlistad felkod
och `Retry-After` utan rått felmeddelande, men frånvaro av output bevisar inte
noll debitering. Ett senare nytt uttryckligt uppdrag får ny admission medan
den gamla förbrukningen ligger kvar som okänd.

### Avgränsad operatörsstädning i den lokala testmiljön

2026-10-05 21:41 UTC släpptes en enda historisk claim,
`a3b064bb-5b69-42be-8771-4e38812fe9c2`, efter det äldre avbrutna deadlockprovet
och ett uttryckligt byte av testets workflow-store. Egen app/Eve var stoppad;
browser-/runnerhälsa och fysisk containerinventering visade noll pågående
arbete. Originalstorets terminalhändelser och det misslyckade provets hash
kontrollerades. Befintlig `releaseMissionResource` användes för exakt försöket,
med exklusivt intent före effekten och separat audit efteråt.

Audit `release-deadlock-test-claim-a3b064bb-5b69-42be-8771-4e38812fe9c2.audit.json`
under `.data/autonomy-isolation/` bekräftar att originalrader och artefakter
behöll sina hashar. Jobbet förblev `cancelling`, försöket `failed` och inget
testslut eller rapportresultat fabricerades. Den gamla arbetsytan blir inte
automatiskt tillgänglig för ett nytt Iris-jobb genom denna städning.

Detta kvitto bevisar endast utförd lokal operatörsstädning. Det får inte räknas
som automatisk recovery, normalt workeråterstartsprov eller positiv acceptans.
Det ändrar inte regeln ovan: en utgången lease eller okänd fysisk process
ger aldrig ensam rätt att frigöra ett anspråk. Ingen generell reset eller
återställning av den gamla workflow-storen utfördes.

En andra, separat operatörsstädning utfördes 22:27 UTC efter SEC-v2. Efter
stopp av app/Eve städades endast sandbox
`a818ed6e-00e0-4800-a5f7-3f4a3aa38abb`, som den sista V-chatten hade skapat
22:23:18 via generisk Bash/curl. `sec-sandbox-a818ed6e-cleanup.json` bevarar
exakt container-/sandboxidentitet och övergången `ready` → `deleted`.
Originalartefaktens SHA
`3352502a19a4c1c12c2da0d3c9cf3987c6465c65c97bf85891fc3db38030340d`
är oförändrad; fysisk tomgång verifierades efteråt. Detta kompletterar
SEC-granskningens tidigare öppna cleanup-punkt med ett operatörskvitto,
inte bevis på automatisk städning eller passerad P5-grind.

## Kvarvarande slutgrind

- Slutför katalogens redan fastställda uppdrag och varianter: WEB-01:s nio
  normal-/återstartsprov, WEB-02–04 och AUTH-09:s webb-/väntan-/stoppfall,
  REP-05–07:s rapportgränser, REPO-10–12:s hela kedjor och
  felpunkter samt GAP-13:s lösbara/kvarstående lucka och rapport-only.
  Minst tre repetitioner per föreskriven variant; en felpunkt som inte nåtts
  eller en avbruten serie är inte ett godkänt prov. Detaljer och låsta
  omfattningar finns i [benchmarkkatalogen](AUTONOMY_BENCHMARK.md). SEC-08:s
  HTTP-gränser och sex naturliga v2-chattar har avgränsade bevis; de ska
  räknas med just detta scope, inte uppgraderas till full providerkontext
  eller noll fysisk exekvering/automatisk cleanup.
- Varje prov fryser sin implementation. Slutkombinationen får återanvända
  dokumenterat opåverkade körbevis enligt benchmarkkatalogens ändringsstyrda
  regression; detta är inte nya pass på slutkällan. Berörda omprov och ännu
  oprövade P2a–P4-felpunkter måste genomföras. En felpunkt som aldrig nås
  räknas inte som provad.
- Prov mot representativa äldre data ska visa att ingen version 1-adoption,
  implicit chattfortsättning eller callback från fel runtime sker.
- Migration, avstängd admission med fortsatt städning och återaktivering behöver
  slutliga integrerade felprov, inklusive repo/Otto och mänskligt browserövertagande.
- Slutlig oberoende granskning ska kontrollera produktdiffen, kompatibilitets-
  tabellen, delningens begränsade projektion och faktiska körartefakter.
- Kostnad redovisas endast när förbrukning och pris är kända. Okänd usage,
  förlorat kvitto, delrapport och misslyckat prov får inte summeras som noll/grönt.
- Driftsättning och produktionsverifiering är fortfarande separata, ej utförda
  aktiviteter som kräver nytt mandat.
