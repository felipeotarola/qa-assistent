// Exact immutable WEB02 source; no expected model labels or rewritten original text.
export default {
  "runId": "bfc9a6d2-9346-431b-99bf-e3d53c35defa",
  "snapshot": {
    "id": "f14bba48-178a-475a-bfef-79d7e4baa910",
    "type": "browser",
    "basis": {
      "kind": "explicit_requirement",
      "quote": "hantera en saknad artikel",
      "source": null
    },
    "steps": "1. Utgå från http://qa-benchmark.test/help. Öppna http://qa-benchmark.test/help och notera frågelänkarna. Urval för detta fall: de två observerade artikellänkarna http://qa-benchmark.test/help/artiklar/lana-bocker och http://qa-benchmark.test/help/artiklar/fornya-lan. Förväntat: Båda frågelänkarna är synliga och klickbara på hjälpcenetersidan.\n2. Klicka på 'Hur lånar jag böcker?' och notera sidans faktiska svar. Förväntat: Svaret dokumenteras utifrån faktiskt mål och innehåll: antingen en fungerande artikelvy eller en saknad-artikelvy/felstatus. HTTP-status bedöms tillsammans med faktiskt sidinnehåll.\n3. Gå tillbaka till http://qa-benchmark.test/help (t.ex. med webbläsarens bakåtknapp som förberedelse) och klicka på 'Hur förnyar jag ett lån?'. Notera sidans faktiska svar. Förväntat: Också denna sidas faktiska svar dokumenteras: antingen en fungerande artikelvy eller en saknad-artikelvy/felstatus.\n4. På den sida inom urvalet som faktiskt svarade med en saknad-artikelvy: inspektera felvyens text och dess egna kontroller. Förväntat: Felvyens synliga text (t.ex. att artikeln saknas) och de kontroller som erbjuds på felvyn dokumenteras. Om ingen av de två sidorna svarar med saknad-artikelvy kan kravet 'hantera en saknad artikel' inte provas inom det tillåtna urvalet och ska redovisas som förklarad lucka i detta fall (inga gissade adresser provas); fallet avslutas då efter steg 3 med denna redovisning.\n5. På saknad-artikelvyn, klicka på den observerade returkontroll som ska föra användaren tillbaka till hjälpcentret. Förväntat: Återkomst till http://qa-benchmark.test/help med frågelistan synlig. Om felvyn saknar en observerad returkontroll dokumenteras detta som avvikelse/lucka för återvägen från just feltillståndet – återvägen från normal artikelvy (fall 1) ersätter inte denna kontroll.",
    "title": "Saknad artikel: felvy och väg tillbaka till hjälpcentret",
    "entryUrl": "http://qa-benchmark.test/help",
    "expected": "En saknad artikel inom det namngivna urvalet visar en tydlig felvy och erbjuder en fungerande, klickad returkontroll till hjälpcentret. Om inget sådant tillstånd påträffas inom urvalet, eller om returkontrollen saknar/felvisar, redovisas respektive del som lucka eller avvikelse – inte som godkänd.",
    "preconditions": ""
  },
  "legacyStepCount": 6,
  "legacySteps": [
    "1. Utgå från http://qa-benchmark.test/help. Öppna http://qa-benchmark.test/help och notera frågelänkarna. Urval för detta fall: de två observerade artikellänkarna http://qa-benchmark.test/help/artiklar/lana-bocker och http://qa-benchmark.test/help/artiklar/fornya-lan. Förväntat: Båda frågelänkarna är synliga och klickbara på hjälpcenetersidan.",
    "2. Klicka på 'Hur lånar jag böcker?' och notera sidans faktiska svar. Förväntat: Svaret dokumenteras utifrån faktiskt mål och innehåll: antingen en fungerande artikelvy eller en saknad-artikelvy/felstatus. HTTP-status bedöms tillsammans med faktiskt sidinnehåll.",
    "3. Gå tillbaka till http://qa-benchmark.test/help (t.ex. med webbläsarens bakåtknapp som förberedelse) och klicka på 'Hur förnyar jag ett lån?'. Notera sidans faktiska svar. Förväntat: Också denna sidas faktiska svar dokumenteras: antingen en fungerande artikelvy eller en saknad-artikelvy/felstatus.",
    "4. På den sida inom urvalet som faktiskt svarade med en saknad-artikelvy: inspektera felvyens text och dess egna kontroller. Förväntat: Felvyens synliga text (t.ex. att artikeln saknas) och de kontroller som erbjuds på felvyn dokumenteras. Om ingen av de två sidorna svarar med saknad-artikelvy kan kravet 'hantera en saknad artikel' inte provas inom det tillåtna urvalet och ska redovisas som förklarad lucka i detta fall (inga gissade adresser provas); fallet avslutas då efter steg 3 med denna redovisning.",
    "5. På saknad-artikelvyn, klicka på den observerade returkontroll som ska föra användaren tillbaka till hjälpcentret. Förväntat: Återkomst till http://qa-benchmark.test/help med frågelistan synlig. Om felvyn saknar en observerad returkontroll dokumenteras detta som avvikelse/lucka för återvägen från just feltillståndet – återvägen från normal artikelvy (fall",
    "1) ersätter inte denna kontroll."
  ],
  "originalNumberedLineCount": 5
};
