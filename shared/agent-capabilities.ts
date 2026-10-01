import { agent } from './agent';

export const mainAgentGuide = {
  id: 'main', title: `${agent.name} · Huvudagent`, icon: agent.avatar.icon,
  summary: 'Ditt mål, ett gemensamt sammanhang.',
  description: 'Din kontakt i chatten. Huvudagenten samordnar uppdraget, använder verktygen och tar hjälp av Axel när en undersökning behöver ett eget sammanhang.',
  needs: 'Beskriv målet i en chatt och välj det workspace vars material och krav ska användas.',
  steps: ['Förstå målet och läs relevant underlag.', 'Använd verktyg direkt för enkla uppgifter; delegera repo-undersökningar vid behov.', 'Sammanfatta resultat, begränsningar och vad som sparats.'],
  result: 'Chatten, aktivitetspanelen och de material eller testresultat som uppdraget skapar.',
  boundary: 'Agenterna använder Eve och chattens modell- och resonemangsval. Modellen körs hos modellleverantören; repo-kod körs isolerat på VPS:en.',
  example: 'Läs vårt underlag och föreslå vad vi behöver verifiera härnäst.', related: ['repository', 'testing', 'material'],
};

/** Product guide to the implemented tools, not a runtime health or permission report. */
export const agentCapabilities = [
  {
    id: 'repository', title: 'Axel · Repository & kodtester', icon: 'i-lucide-git-branch', summary: 'Undersök kod och kör projektets testkommandon.',
    description: 'Huvudagenten hanterar enkla repo-uppgifter direkt. Axel kan ta över undersökning och val av testkommando i ett eget sammanhang och lämna tillbaka resultatet.',
    needs: 'Ett workspace och ett publikt GitHub-repo. Ange gärna branch och script. Stöder npm samt pnpm@10.33.4 med låsfil. Publika repo-URL:er behöver ingen GitHub-koppling.',
    steps: ['Ge huvudagenten repo-URL och vad du vill undersöka eller testa.', 'Agenten använder ett känt kommando direkt eller delegerar undersökningen till Axel.', 'Koden körs i en isolerad Docker-miljö på VPS:en. Resultatet sparas med körnings-ID, commit och kommando.'],
    result: 'Sammanfattning i chatten. Be agenten hämta den sparade körningen via dess körnings-ID för status och tillgängliga loggar.',
    boundary: 'Privata repos och installationsscript stöds inte i piloten. Ett lyckat kommando betyder inte automatiskt att alla testfall är verifierade. Agenternas modell körs via modellleverantören; VPS:en kör projektets kod.',
    example: 'Undersök https://github.com/felipeotarola/surdeg och ta reda på vilket script vi kan använda för att verifiera projektet. Kör det och sammanfatta resultatet.', related: ['testing', 'integrations'],
  },
  {
    id: 'testing', title: 'Testning', icon: 'i-lucide-clipboard-check', summary: 'Från testfall till spårbara resultat.',
    description: 'Agenten läser testfallet och dess krav, startar en körning och sparar det som faktiskt observerades separat från testplanen.',
    needs: 'Ett workspace, en testplan och en tydlig testmiljö. Webbtester behöver en fungerande webbläsarsession.',
    steps: ['Läs testfall, förutsättningar och förväntat resultat.', 'Genomför testet i webbläsaren eller samla den manuella verifieringen.', 'Spara utfall, observationer, begränsningar och tillgängliga skärmbilder.'],
    result: 'Testning → testfallet → körningsresultat och historik.',
    boundary: 'Beskrivna testfall är inte körda tester. Saknade fakta ska synas som en begränsning eller ett behov av bedömning.',
    example: 'Kör testfallet för felaktigt lösenord och spara resultat och skärmbilder.', related: ['browser', 'requirements'],
  },
  {
    id: 'browser', title: 'Iris · Webbläsartester', icon: 'i-lucide-globe', summary: 'Testar i webbläsaren medan du fortsätter chatta.',
    description: 'Iris får ett avgränsat testuppdrag och arbetar i en egen live-webbläsarsession. Huvudagenten är tillgänglig under tiden. Följ verktygssteg och rapport i Pågående arbete.',
    needs: 'Webbchatten och en tillgänglig webbläsartjänst. Inloggning kan göras genom att du tar över sessionen.',
    steps: ['Be huvudagenten köra en testplan eller kontrollera ett flöde.', 'Följ Iris i Pågående arbete och fortsätt chatta under körningen.', 'Öppna live-webbläsaren vid behov. Stoppa uppdraget eller läs rapporten i samma panel.'],
    result: 'Live-session i workspace. Skärmbilder kan sparas som material och kopplas till en testkörning.',
    boundary: 'Ett Iris-uppdrag åt gången per workspace. Vid manuell kontroll pausar Iris arbetet och rapporterar vad som återstår. Skriv inte lösenord i chatten. Den här sidan kontrollerar inte tjänstens driftstatus.',
    example: 'Öppna vår testsida i webbläsaren så att jag kan logga in manuellt.', related: ['testing', 'research'],
  },
  {
    id: 'research', title: 'Research', icon: 'i-lucide-search', summary: 'Undersök publika sidor och samla källor.',
    description: 'Agenten söker på webben och läser publika webbsidor i en separat bakgrundswebbläsare. Den kan samla text, länkar och skärmbilder.',
    needs: 'En webbchatt, en publik adress eller sökfråga och en tillgänglig webbläsartjänst.',
    steps: ['Utgå från en adress eller sök efter relevanta källor.', 'Läs originalsidor och följ relevanta länkar.', 'Spara underlaget med källor och markera vad som inte är verifierat.'],
    result: 'Källor i chatten och, när du ber om det, dokument eller bilder i Material.',
    boundary: 'En lista med URL:er bevisar inte hur sidor länkar till varandra. Inloggade sidor kräver live-webbläsaren.',
    example: 'Undersök våra publika sidor och skapa ett diagram över de samband du kan verifiera.', related: ['material', 'browser'],
  },
  {
    id: 'material', title: 'Material & sammanhang', icon: 'i-lucide-folder-open', summary: 'Gemensamt underlag mellan chattar.',
    description: 'Agenten kan skapa och uppdatera dokument, tabeller och diagram, samt använda sparade filer och bilder. Chattar i samma workspace delar underlaget.',
    needs: 'Ett valt workspace. Ange vilket objekt som ska ändras, eller skriv direkt från dess kort.',
    steps: ['Läs det aktuella objektet och dess version.', 'Ändra det efterfrågade innehållet och behåll resten.', 'Spara en ny version med källor och bildreferenser.'],
    result: 'Material → samma objekt, med versionshistorik och kopierbart material-ID.',
    boundary: 'Profil och personligt minne är separata från projektets material. Ett diagram skiljer verifierade samband från antaganden.',
    example: 'Läs tabellen med våra publika sidor och gör ett diagram av den.', related: ['research', 'requirements'],
  },
  {
    id: 'requirements', title: 'Krav & bedömning', icon: 'i-lucide-book-open-check', summary: 'Ge agenten grunden för rätt bedömning.',
    description: 'Otydliga krav kan förtydligas och kopplas till testfall. Du kan också bedöma en sparad körning utan att skriva över agentens ursprungliga observationer.',
    needs: 'Ett testfall och ett konkret kravbeslut. Publicering kräver en Linear-koppling och ett valt ärende.',
    steps: ['Öppna Krav & kontext i testfallet och besvara det som saknas.', 'Granska förslaget och koppla rätt Linear-ärende innan publicering.', 'Använd det uppdaterade testfallet vid nästa körning; bedöm äldre körningar separat.'],
    result: 'Krav & kontext i testfallet, publicerat kravavsnitt i Linear och spårbar bedömning av körningen.',
    boundary: 'En observation är inte automatiskt ett fel. En kravändring gör inte tidigare körningar automatiskt godkända.',
    example: 'Ett generiskt felmeddelande är acceptabelt här. Förbered ett kravförtydligande för testfallet.', related: ['testing', 'integrations'],
  },
  {
    id: 'integrations', title: 'Linear & GitHub', icon: 'i-lucide-plug', summary: 'Koppla krav och resultat till era ärenden.',
    description: 'Agenten kan läsa information via ditt anslutna konto och, på din begäran, skapa eller uppdatera ärenden och lägga till kommentarer i workspacets valda destination.',
    needs: 'Anslut ditt konto under Integrationer. Välj sedan Linear-team/projekt eller GitHub-repository under workspace → Kopplingar.',
    steps: ['Anslut och kontrollera ditt personliga konto.', 'Välj destination i det workspace där ni arbetar.', 'Be om en konkret publicering och följ länken till det sparade ärendet.'],
    result: 'Ett ärende hos leverantören och en sparad länk/publiceringshistorik i workspacet.',
    boundary: 'Ingen automatisk tvåvägssynk eller publicering av privata bildbilagor. Kopplat konto betyder inte att workspace-destinationen är vald.',
    example: 'Skapa ett felärende i vårt valda Linear-projekt för den bekräftade avvikelsen.', related: ['requirements', 'testing'],
  },
] as const;
