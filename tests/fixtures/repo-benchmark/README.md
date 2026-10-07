# REPO-10/11/12: frysta repo-prov

Detta är tre **simulerade, testägda repositoryn**, inte externa kundprojekt.
Biblioteket har en faktisk kvantitetsregression. Serviceguiden har en synlig
kontaktlänk som leder till HTTP 404 medan startsidan och Hjälp fungerar.
Serviceportalen behöver två privata syntetiska konfigurationsvärden och gör
inga externa anrop. Apparna har små DOM-träd, GET/HEAD och Node 24/npm-lock.

`oracle.json`, detta dokument och `public-candidate.json` finns utanför de
checkoutar som modellen får läsa. Bara respektive underkatalog materialiseras.
README i varje checkout beskriver produktens kontrakt och vanliga startkommandon,
inte facit, fall-ID, agenter, verktyg eller hur en granskning ska utfalla.

## Status och körgräns

Implementerat: normalvariant för samtliga tre uppdrag, tre repetitioner,
vanligt V-intag, frånkopplad klient, faktisk scheduler, läsande SQL samt separat
deterministiskt facit. **Ingen modellacceptans är körd av detta arbete.** Rena
tester bevisar bara fixturebeteende och orakelgränser.

Kvar före körning: verifierad transport till dessa Git-commit från den isolerade
runnern, aktuell worker/dependency/image/processidentitet och, för REPO-12, tre
verkligt förberedda arbetsytor med sparat medgivande. `--execute` nekar när dessa
saknas. En manifestflagga är ingen fysisk verifiering; transportkvittot måste
komma från en faktiskt utförd, oberoende fetch och jämförelse av commit/tree.

Följande obligatoriska katalogvarianter är **inte implementerade** i denna
harness ännu: förlorad runner-kvittens (10), död app efter readiness (11), saknad
nyckel utan svar och återkallat medgivande före fysisk release (12). De nekas
före auth/modellstart. De får varken markeras godkända eller ersättas med fler
normalrepetitioner. `gate` förblir alltid false tills separat slutgranskning;
`automatedGate` avser endast den valda normalvarianten.

## Frys checkoutar utan tjänster

```powershell
node tests/helpers/repo-benchmark-fixtures.mjs --materialize
node tests/autonomy-repository.acceptance.mjs --validate --manifest=.data/autonomy-isolation/repo-fixtures/<uuid>/manifest.json --scenario=REPO-10
```

Materialiseringen skapar nya lokala Git-repon med fasta författaruppgifter/tid,
LF-innehåll och riktig commit/tree-SHA. Inga paket installeras, inga kommandon i
repona körs, inget pushas och existerande kataloger skrivs aldrig över.
Manifestets transport är `unbound`, vilket med avsikt inte kan starta modeller.

För en simulerad transport får en **separat auktoriserad isoleringsåtgärd** bygga
en privat execution-image med exakta Git-URL-omskrivningar för endast dessa tre
GitHub-fixture-URL:er till en läsande lokal Git-server. Ingen global GitHub-DNS,
ingen produktionstransport och ingen ändring av produktkod är tillåten för att
få facit att passera. Checkoutarna ska vara oförändrade och oraklet oåtkomligt.
Använd hellre ett faktiskt publikt repo om ett oberoende belagt facit finns.

Det konkreta verktyget är `tests/helpers/repo-transport.mjs`. `--plan` gör bara
lokala Git-bundles och en ny fryst plan. `--audit` läser redan startad ägd WSL;
den startar inte distributionen, Docker eller andra tjänster. Även en tom men
startad repo-runner blockerar provisionering. Den verkliga läsproben har nekats
av just detta villkor; ingen fysisk transport är ännu skapad.

```powershell
node tests/helpers/repo-transport.mjs --plan --manifest=<nytt-manifest.json>
node tests/helpers/repo-transport.mjs --audit --transport-plan=<plan.json>
```

Efter ett separat samordnat mutationsfönster, när inga repositoryuppdrag väntar
eller kör, måste den vanliga livscykelägaren stoppa den isolerade repo-runnern.
Provisioneraren gör inte detta åt användaren och ändrar inga tjänsters miljö.
Den nekar kvarvarande executorprocesser och repo-/sandbox-/preview-containrar,
främmande Docker-data-root/cgroup, befintlig output/image, upptagen port/adress
och ett tidigare provisionslås. Den kontrollerar detta igen under eget lås.

```powershell
node tests/helpers/repo-transport.mjs --provision --transport-plan=<plan.json> --confirm-plan=<utskriven-planSha256>
```

Effekter: en ny katalog under `/var/lib/syna-autonomy/repo-fixtures/<uuid>`,
read-only bare Git-repon, en separat image från exakt befintlig image-digest,
en `/32`-adress `198.51.100.10` på WSL:s loopback och en begränsad Git-server
på adressens port 18080 som uid 65534. Inga DNS-/brandväggsregler eller
produktfiler ändras. Servern tillåter endast smart-HTTP `git-upload-pack` för
de tre namnen, med eller utan Gits `.git`-ändelse. Andra suffix, råa filer,
path traversal, oracle, receive-pack, cookies och Authorization nekas.
System-Git får exakt tre fullständiga original-URL-mappningar; ingen omskrivning
av hela GitHub eller av en hel ägare. Både mandatory repo-inspektion/check och
deterministisk apply använder vanlig Git i samma image. Ingen av dessa vägar
använder GitHub API. Fri webbresearch av den simulerade GitHub-adressen kan
fortfarande få 404; det maskeras inte och får inte bli ett uppfunnet fynd.

Kvittot skapas först efter **tre verkliga shallow-fetcher** genom den nya
imagen, som user 1000 i runsc och det befintliga `qa-repo-net`. Varje fetch måste
ge exakt vald commit och tree. Ingen checkout, konfiguration eller oracle
monteras i provcontainern. Vid okänd effekt behålls eget lås och delresurser;
ingen blind omkörning, adoption, bred städning eller stopp av andra uppdrag.
Timeout i Windows kan betyda förlorad kvittens: kontrollera då det ägda
Linux-kvittot innan något nytt försök. Återställning/städning kräver separat
verifiering av exakt PID/starttid, egna resursnamn/labels och `/32`-alias.

När livscykelägaren därefter uttryckligen startat om den sysslolösa runnern
med `EXECUTION_IMAGE` satt till den verifierade privata image-digesten:

```powershell
node tests/helpers/repo-transport.mjs --bind --transport-plan=<plan.json>
```

`--bind` återläser verklig server-PID/starttid/argv, listener, serverbytes,
image-identitet och Git-HEAD/tree samt aktuell workeridentitet. Den skriver
en **ny** `bound-manifest.json` och `transport.json` utan att ändra ursprungligt
manifest eller starta modeller. För varje modellrepetition återverifieras samma
transportidentitet. Det faktiska fetch-kvittot får inte ersättas med manuellt
skrivna booleans. REPO-12:s vanliga förberedelser behöver fortfarande genomföras.

En faktisk publik kandidat lästes och låstes i `public-candidate.json`:
`shanep/simple-full-stack` vid angiven SHA. Den saknar en belagd av de avsedda
regressionerna och används **inte** som ersättningsfacit. npm/Node-kompatibilitet
är inte körverifierad och ingen kod därifrån kopieras till våra fixtures.

## Fryst körmanifest

Efter oberoende transportverifiering kompletteras en **ny kopia** av manifestet
med `runtime`, `workerReceiptSha256` och `transport`:

```json
{
  "kind": "simulated-github-transport",
  "isolatedRuntime": "autonomy-test:<fixture-runtime>",
  "scope": "exact-fixture-repositories-only",
  "productionDnsChanged": false,
  "receiptSha256": "<sha256 of sibling transport.json>"
}
```

`transport.json` innehåller `kind`, `runtime`, `workerReceiptSha256`,
`repositories: [{url,commit,tree}]` i manifestets ordning, `verifiedFetch:true`
och `oracleServed:false`. Spara det verkliga fetchunderlaget separat; att skriva
booleans i en fil är inte ett utfört prov. En offentlig transport använder
`kind:public-github` med samma faktiska kvitto. Manifest och kvitto fryses innan
något accepterat modelluppdrag och deras hash sparas i resultatet.

`observeRepoWorker()` kontrollerar WSL-distro, faktisk runner-PID/starttid,
loopback-lyssnare, exakt Node/entry-argv, tillåtna callbackmål, inga runtime
preloads, deployade källfiler, Node/Codex-bytes och execution/preview-image.
Ändrade källfiler efter processstart nekas. Aktuell implementation granskas för
enbart relativa/builtin-modulimporter; detta är inte en generell verifierare för
godtyckliga tredjepartsdependencies. Upprepad läsning måste ge samma identitet.
Web/Eve kontrolleras dessutom av den befintliga fulla isoleringsgrinden.

## REPO-12: sparat medgivande är fördata, inte en räddning

Förbered tre separata arbetsytor genom det vanliga inloggade appflödet innan
mätningen. Låt en riktig förberedelse spara exakt plan/profil/commit. Spara
enbart syntetiska värden via `PUT /api/workspaces/:id/vault` och ge uttryckligt
medgivande via `POST /api/workspaces/:id/setup-jobs/:jobId/consent` med serverns
aktuella `expectedPlanHash`, `expectedVaultRevision`, variabelnamn och nytt
`requestId`. Det är en normal användaråtgärd före mätningen, inte en dold
återkoppling under QA. Ingen direkt SQL-seed av grant eller prepare-resultat.

Förberedelseuppdraget och alla dess resurser måste ha avslutats innan mätstart.
REPO-12 använder en **ny chatt** i samma arbetsyta och samma naturliga prompt
som katalogen plus vald commit. Förberedelsens token/tid sparas som separat
fördata och summeras inte in i mätt QA.

Manifestets `prepared` är tre poster med `workspaceId`, `threadId` (historisk
förberedelse), `setupJobId`, `consentId`, `userId`, `planHash`, `vaultRevision`,
`origin:ordinary-session-api` och `valuesKind:synthetic-local-only`. Ett privat
syskon `values.private.json` mappar workspace-ID till exakt de två syntetiska
värdena. Den filen används endast för artefaktredigering/sekretesskontroll och
skickas aldrig till modellen. Inga verkliga tjänstenycklar behövs.

Harnessen återläser verkliga plan-, owner-, runtime-, repo-, commit-,
Vaultrevision- och grantfält. Grant måste gälla hela observationsfönstret.
Fysisk apply-release ska använda samma sparade consent/revision/hash och skapa
exakt en release-händelse; en användarväntan gör normalvarianten underkänd.

## Senare uttryckligt körkommando

```powershell
node tests/autonomy-repository.acceptance.mjs --audit --manifest=<fryst-manifest> --scenario=REPO-10
node tests/autonomy-repository.acceptance.mjs --execute --manifest=<fryst-manifest> --scenario=REPO-10 --repetitions=3
```

Harnessen startar eller stoppar inga tjänster och läser aldrig root `.env`.
`--audit` kör inga modeller eller autentiserade appåtgärder. `--execute` skapar
ordinarie arbetsytor/chattar via session-API och en separat lokal jämförelseuser
för åtkomstprov. Inga interna drain-API:er anropas; schemaläggarens faktiska
kvittologg måste visa fortsättningen. HTTP-/DB-observation driver inte arbetet.

Resultat sparas som `repository-acceptance-<uuid>.json`, protokoll version 1,
`kind:repository-acceptance`. Varje planerad repetition är antingen startad eller
explicit ej startad efter fel. Bevarade snapshots, faktisk tidslinje, mätta
providerfält och okänd förbrukning hålls isär. Cache läggs inte ovanpå input;
pris och end-to-end-token saknar här komplett mätning. Befintliga webb-/baseline-
benchmarkhjälparen stödjer ännu inte dessa scenario-ID:n och ska neka dem.

För appvarianterna läses verkliga privata trace-/PNG-bytes via owner-API med
digestkontroll samt nekad annan/anonym användare. Samma run/commit/checkpoint
och faktiskt lästa evidens-ID:n måste nå granskning och rapport. Ett enkelt
HTTP 200 eller en rapporttext räcker inte. Positiva länkar kan ingå i ett
övergripande negativt test; känt fel kräver mismatch och bevarat failed-utfall.
Efter stängning kontrolleras även faktiska egna Docker-containeridentiteter.
Rapporten återöppnas utan att modifieras. Fri rapportprosa slutläses separat.
