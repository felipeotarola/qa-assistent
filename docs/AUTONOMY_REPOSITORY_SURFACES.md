# Repository-QA: ett avgränsat val efter inspektion

Detta kontrakt skiljer användarens önskade testyta från vad en inspektion faktiskt har hittat. Det är ingen ny exekverings- eller modellväg.

| Intag | Ytval | Gräns |
| --- | --- | --- |
| Allmän repo-QA utan vald testyta | `auto`, även när nya intag utelämnar fältet | Inspektera först. Prioritera ett identifierat befintligt test-, lint- eller typecheck-kommando. |
| Uttryckliga biblioteks-, CLI-, testsuite- eller statiska kontroller | `checks` | Ett saknat kommando ger ett hinder. Byt aldrig till webbläsartest. |
| Efterfrågat beteende som kräver en körande app eller webbläsare | `application` | Behåll appens QA-mål även när repot också innehåller tester. Nödvändig, villkorad appstart hör till samma uppdrag. |

En uttrycklig testsuite som kräver en startad app som förutsättning är fortfarande `checks`. Det innebär inte rätt att ersätta testsuiten med en annan browserundersökning. Den aktuella kommandovägen kan behöva redovisa en otillgänglig förutsättning som hinder.

## Ett deterministiskt val

Valet sker en gång per discoveryuppgift och plan efter en sparad, autentiserad inspektion av exakt commit. Samma kontroller för ägare, runtime, uppdrag, försök, mandat, deadline, begäransfingeravtryck och fysisk städning gäller som tidigare. Beslutet sparas med inspektionens hash. Ett förändrat underlag får inte välja om testytan vid återstart.

För `auto` väljs en faktiskt identifierad test-/statikkontroll först. Rapportens leverans begränsas då till det utförda kommandot; enbart lint/typecheck styrker inte funktionell app-QA. Ett underbyggt negativt resultat är fortfarande ett färdigt resultat. Ingen omkörning görs för att få grönt.

Om ingen sådan kontroll finns kan ett sparat Node-projekt med entydigt vald, giltig katalog och ett faktiskt icke-tomt `start`- eller `dev`-script gå vidare till den befintliga miljöförberedelsen. Okänt runtime, oklar projektkatalog, avsaknat startscript eller ofullständig metadata blockerar i stället. Inga kommandon eller sökvägar gissas och inga dokument tolkas som mandat.

Ett startscript bevisar inte att appen kan startas. Det skapar enbart den redan befintliga uppgiften att verifiera startplanen. Exakt plan, Vault-medgivande, variabelnamn, deadline, apply-kvitto, HTTP-readiness och previewbindning måste fortfarande passera sina befintliga grindar innan browser-QA får köras. Själva ytvalet läser inte Vault, startar inte appen och ändrar inte mål eller mandat.

## Kompatibilitet och verifiering

Endast nya intag får standardvärdet `auto`. Sparade mål utan fältet läses fortsatt som `checks`. Uttryckliga värden ändras inte genom tolkning av måltext. Historiska uppdrag, misslyckade acceptansprov, snapshots och rapporter skrivs inte om.

Rena schemaprov, verkliga Eve-deskriptor-/instruktionsprov och isolerade PostgreSQL-prov verifierar kontraktet och dess negativa gränser. Syntetisk transport eller modellutdata i dessa prov är inte verklig executor- eller modellacceptans. En ny faktisk REPO12-serie kräver nya ägda workspaces och ny separat förberedelse; en gammal misslyckad arbetsyta får inte återanvändas som om den vore orörd.
