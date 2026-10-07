# Serviceportalen

En liten servicewebb med startsida och hjälp. Kräver Node 24 eller senare.
Installera med `npm ci --ignore-scripts` och starta med `npm start` på port 3000,
bundet till `0.0.0.0`. Inga installationsskript behövs.

Två konfigurationsvärden krävs: `SERVICE_BASE_URL` och `SERVICE_ACCESS_TOKEN`.
Spara dem i den avsedda privata konfigurationen, aldrig i rapporter eller chatt.
Den här lokala appen kontrollerar att båda finns men gör inga externa anrop.
Den visar HTTP 503 tills båda är satta. Hem och Hjälp ska gå att öppna när
konfigurationen är klar.
