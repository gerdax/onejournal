# Kompendium MG

Kompendium jest osobnym modułem onejournal: popup pod ikoną runy, prywatny czytnik PDF oraz statystyki „Kompendium — zużycie” w Ustawieniach. Nie zapisuje rozmów, nie zmienia kampanii i nie dodaje podręcznika do jej kopii zapasowych. Przeglądarka przechowuje rozmowę tylko do przeładowania karty. Zamknięcie popupu jej nie usuwa. Podczas generowania tekst podąża za odpowiedzią tylko wtedy, gdy widok znajduje się blisko końca; przewinięcie w górę pozwala czytać wcześniejszą treść. Enter wysyła pytanie, a Shift+Enter wstawia nową linię. Zmiana strony czytnika przewija na górę; powiększenie zachowuje pozycję.

## Stan wdrożenia

Wersja zintegrowana z aktualnym `main` przechodzi 127 testów technicznych oraz izolowane testy przeglądarkowe Kompendium i kości. Używa `gpt-5.4` z rozumowaniem `medium` i limitem 4096 tokenów. Po doprecyzowaniu odmowy przy braku odpowiedzi na dokładnie zadane pytanie pełna ocena 40 przypadków przeszła niezależny przegląd: 35 odpowiedzi miało poprawne reguły i źródła, a 5 pytań bez wystarczających podstaw otrzymało odmowę. Mediana czasu odpowiedzi wyniosła około 8 sekund, maksimum około 20 sekund. Poprzednie wyniki mini i pierwszej próby GPT-5.4 pozostają w prywatnych raportach. Wynik dotyczy tego zestawu i konfiguracji, nie gwarantuje braku przyszłych błędów. Prywatne wyniki znajdują się w `private-kompendium/`. Backend produkcyjny ma wdrożoną funkcję, pięć migracji Kompendium oraz aktywny prywatny podręcznik (244 strony, 631 fragmentów). Kontrola produkcyjna potwierdziła dostęp MG, odmowę bez uprawnień, wyszukiwanie, raport zużycia, CORS oraz jednorazowy bilet do prywatnego PDF. Frontend publikuje standardowy workflow Pages po scaleniu do `main`. Przy przeniesieniu gotowego indeksu nie wykonywano ponownie płatnych embeddingów.

Kod wymaga migracji, osobnej funkcji Edge, sekretów i importu podręcznika. Nie wystarczy opublikować samego frontendu. Rozwój i testy prowadź w osobnym projekcie Supabase. Utwórz projekt w Dashboard; **Project URL** ma postać `https://IDENTYFIKATOR.supabase.co` (Connect / ustawienia API). Ten identyfikator przekazuje się do `--project-ref`. Nie używaj projektu produkcyjnego do prób importu.

Frontend do prób należy skonfigurować adresem i publishable key projektu testowego w lokalnej kopii `config.js`. Przed publikacją sprawdź właściwe środowisko. Testy automatyczne poniżej używają izolowanych danych i zastępują konfigurację fixturem.

Gdy katalog zawiera `private-kompendium/`, serwuj wyłącznie wynik publicznego builda: `node scripts/build-site.mjs`, następnie `python3 -m http.server 8877 --bind 127.0.0.1 --directory dist`. Nie serwuj katalogu głównego repozytorium: prosty serwer plików udostępniłby również prywatny PDF, wyniki oceny i lokalne sekrety.


Po zgłoszeniu odmów przy zmianie tematu dodano oddzielenie samodzielnych pytań od kontynuacji oraz ograniczone pobieranie sąsiednich fragmentów. Scenariusze chronologii i podróży (osobno oraz po pytaniu o chronologię) przeszły ponowny przegląd źródeł. Test przeglądarkowy sprawdza swobodne przewijanie w trakcie strumieniowania.

## Instalacja backendu

1. Na nowym projekcie zastosuj wszystkie migracje onejournal w kolejności nazw i uruchom istniejący bootstrap MG zgodnie z BACKEND.md. Ustaw dozwolone origins dla lokalnego frontendu. Następnie zastosuj `202610010001_kompendium.sql`, `202610010002_kompendium_resume.sql` i `202610020002_kompendium_retrieval.sql` oraz `202610030001_kompendium_neighbors.sql` i `202610030002_kompendium_neighbor_clusters.sql`.
2. Ustaw sekrety funkcji: istniejące `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ONEJOURNAL_ALLOWED_ORIGINS` oraz **`OPENAI_API_KEY`**. Nigdy nie umieszczaj sekretów w `config.js` ani w Git.
3. `OPENAI_MODEL` domyślnie wynosi `gpt-5.4`; rozumowanie ma poziom `medium`. Embeddingi używają `text-embedding-3-small` / 1536 wymiarów. Zmiana modelu odpowiedzi nie wymaga ponownego indeksowania.
4. `KOMPENDIUM_PRICING_JSON` nadpisuje ceny modelu, np. `{"gpt-5.4":{"input":2.5,"cached":0.25,"output":15}}` (USD / milion tokenów). Wbudowane stawki dla `gpt-5.4-mini` pozostają 0.75/0.075/4.5. Niestandardowy model wymaga jawnego wpisu cenowego; nie przejmuje ceny modelu domyślnego. `KOMPENDIUM_EMBEDDING_INPUT_PRICE` ma domyślnie wartość `0.02`; ustaw tę samą cenę w importerze i funkcji. Zmiana cen nie przelicza historycznych zapisów.
5. Wdróż funkcję: `supabase functions deploy kompendium --project-ref IDENTYFIKATOR`. Konfiguracja `verify_jwt=false` jest celowa: czytnik wymienia jednorazowy bilet bez sesji gry; pozostałe akcje samodzielnie sprawdzają JWT przez Supabase Auth i aktywny grant MG. Nie wyłączaj tych kontroli.

## Prywatny import podręcznika

Potrzebujesz Node 22.18+ oraz Python 3 z `pypdf`:

```sh
npm ci --ignore-scripts
python3 -m venv /tmp/onejournal-pdf-env
/tmp/onejournal-pdf-env/bin/pip install -r scripts/kompendium-requirements.txt
PYTHON=/tmp/onejournal-pdf-env/bin/python node scripts/kompendium-import.mjs prepare \
  --pdf '/pełna/ścieżka/podrecznik.pdf' \
  --title 'Jedyny Pierścień — Gra Fabularna' \
  --out private-kompendium/review.json
```

Przygotowanie jest całkowicie lokalne. Sprawdź w `review.json` układ kolumn, tabel, tekst i przypisy. Dla każdej strony ustaw `bookPage` (tekst, np. `99`, `iv`, albo null), opcjonalne `section` i jawne `exclude` dla okładek/pustych stron. Nie zakładaj jednego przesunięcia numeracji bez sprawdzenia. Fizyczne `pdfPage` są liczone od 1. Podział na fragmenty odbywa się po sprawdzeniu ekstrakcji: 550 tokenów, overlap 100, zawsze wewnątrz pojedynczej strony.

Importer odrzuca PDF-y bez użytecznej warstwy tekstowej, także pliki zawierające tylko powtarzający się znak wodny. OCR nie jest wykonywany automatycznie przez importer. `private-kompendium/`, `reference/*.pdf` i `docs/*.pdf` są ignorowane przez Git. Publiczny build ma jawną listę dozwolonych plików.

Po sprawdzeniu pliku, z sekretami projektu testowego ustawionymi w środowisku terminala:

```sh
node scripts/kompendium-import.mjs upload \
  --pdf '/pełna/ścieżka/podrecznik.pdf' \
  --review private-kompendium/review.json --reviewed \
  --project-ref IDENTYFIKATOR
```

Wymagane zmienne: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`. Import wysyła PDF do prywatnego bucketu i fragmenty tekstu do API embeddingów; jest płatny. SHA-256 wiąże sprawdzony plik z PDF-em. Nowy dokument staje się aktywny dopiero po kompletnym imporcie. Nieudany import pozostawia stary indeks aktywny i zachowuje koszt już wykonanych wywołań. Nieaktywne dokumenty są zachowywane do ręcznego przeglądu administracyjnego.

Po przerwaniu importu uruchom to samo polecenie z `--resume`. Wymaga ono identycznego PDF-u, tytułu i sprawdzonej mapy fragmentów; wybiera najnowszy zgodny nieaktywny dokument, weryfikuje każdy zapisany fragment i pomija już zapisane embeddingi. Jeżeli PDF jest już w prywatnym buckecie, nie wysyła go ponownie. Odpowiedzi embeddingów i ich zużycie są przed zapisem fragmentów przechowywane w ignorowanym `private-kompendium/checkpoints/` (pliki prywatne, bez kluczy API). Zachowaj ten katalog do końca importu; po potwierdzonej aktywacji usuń checkpoint danego dokumentu, jeśli nie jest już potrzebny do diagnostyki. Wywołania dostawcy zakończone przed utworzeniem checkpointu mogą ponownie naliczyć koszt; zapisanych w Supabase fragmentów nie trzeba ponownie obliczać. Bez `--resume` polecenie `upload` celowo tworzy nowy dokument.

## Opcjonalny lokalny OCR

Na prośbę użytkownika można przygotować przeszukiwalną kopię skanu, bez wysyłania go do usługi OCR. Skrypt wymaga lokalnych `pdftoppm`, Tesseract 5 i modeli językowych `pol` oraz `eng` (oficjalny projekt tesseract-ocr/tessdata_best). Katalog modeli musi też zawierać standardowe konfiguracje Tesseract `pdf`, `txt`, `tsv` i plik `pdf.ttf`.

```sh
/tmp/onejournal-pdf-env/bin/python scripts/kompendium-ocr.py \
  --pdf '/pełna/ścieżka/oryginal.pdf' \
  --out-dir private-kompendium/ocr --tessdata '/ścieżka/do/tessdata' \
  --title 'Jedyny Pierścień — Gra Fabularna' --workers 4
```

Skrypt zachowuje grafikę oryginału i dodaje niewidzialną warstwę tekstu w nowym `podrecznik-ocr.pdf`. Liczba i kolejność stron pozostają bez zmian. `review.json` zawiera tekst OCR oraz flagi stron wymagających przeglądu. Jeśli oryginał ma etykiety stron PDF, mają one pierwszeństwo przed odczytem numerów przez OCR; w przeciwnym razie numerację trzeba sprawdzić ręcznie. Importuj plik OCR z odpowiadającym mu `review.json`. Wyniki per strona umożliwiają wznowienie lokalnego OCR; manifest wiąże je z oryginałem i modelem językowym. OCR, szczególnie tabele i ozdobne nagłówki, wymaga sprawdzenia przed indeksowaniem.

## Prywatność, źródła i koszty

- Pytania obejmują zasady i opis świata zawarty w podręczniku. Ogólne pytanie może otrzymać udokumentowany przegląd bez znajomości wszystkich wyjątków; brak konkretnego faktu nadal wymaga odmowy. Samodzielne pytanie wyszukuje własny temat i nie przekazuje wcześniejszych odmów do modelu. Dla kontynuacji wykrywanej po polskich zwrotach odwołujących się do poprzedniej wypowiedzi wyszukiwanie uwzględnia poprzednie pytanie oraz źródła ostatniej odpowiedzi.
- RAG rozpoczyna od sześciu wyników wyszukiwania semantycznego/literalnego i uzupełnia je o najwyżej 12 sąsiednich fragmentów (odległość do dwóch pozycji w indeksie, tylko ten sam aktywny dokument). Sąsiedztwo skupionych trafień ma pierwszeństwo przed pojedynczym trafieniem w innym rozdziale. Kontekst źródeł ma limit 40 kB; zapobiega to pomijaniu części procedury na granicy fragmentów. Serwer ogranicza historię do sześciu wiadomości i 2000 tokenów o200k_base (z rezerwą na strukturę wiadomości). Starsze wiadomości są usuwane parami. Limit generowania wynosi 4096 tokenów łącznie z rozumowaniem; szczegółowość widocznej odpowiedzi zależy od pytania.
- Tekst w trakcie generowania jest tymczasowy. Dopiero kompletna odpowiedź z poprawnymi identyfikatorami źródeł jest zatwierdzana. Nieznane/brakujące źródła dają komunikat o niewystarczającej podstawie. Walidacja identyfikatorów nie dowodzi poprawności interpretacji — wymagana jest ocena pytań z książki.
- Link otwiera `reader.html` synchronicznie, żeby uniknąć blokady popupów. Losowy identyfikator kanału jest usuwany z fragmentu URL; kanał BroadcastChannel przekazuje jednorazowy bilet bez tokenów sesji gry. Bilet żyje 60 sekund, a przy wymianie sprawdzane są aktualne uprawnienia i wersja linku.
- Podpisany URL PDF żyje 600 sekund. Po wydaniu pozostaje ważny do wygaśnięcia również po cofnięciu dostępu MG. Wcześniej pobranego pliku nie można odebrać. Przeglądarka i service worker nie zapisują PDF w aplikacyjnym cache.
- Serwer ogranicza zadawanie pytań do 6/minutę i 30/godzinę dla użytkownika. Nie ma budżetowego limitu wydatków. Zapytanie może zakończyć naliczanie po zamknięciu karty, aby zachować raport zużycia; wywołania mają timeouty.
- Historia nie trafia do bazy ani browser storage; API używa `store=false`. To nie jest deklaracja zerowej retencji infrastruktury dostawcy.
- Ustawienia pokazują szacunkowy koszt API w USD dla miesiąca według Europe/Warsaw i całego okresu. Embeddingi zapytań należą do rozmów, import do indeksowania. Brak podatków, przewalutowania i opłat Supabase.
- Zapisy kosztów zawierają metryki, identyfikator wywołania i cenę z jego chwili, bez treści rozmów. Znane zużycie nie jest zerowane po błędzie. Niepełne wywołania są oznaczane, bo mogły kosztować mimo braku końcowych danych. `cachedInputTokens` to podzbiór `inputTokens`.

## Testy i warunek publikacji

```sh
npm ci --ignore-scripts
node --test tests/*.test.js
deno check --config supabase/functions/kompendium/deno.json --node-modules-dir=none supabase/functions/kompendium/index.ts
NODE_PATH=/ścieżka/do/node_modules node tests/kompendium-online.cjs
NODE_PATH=/ścieżka/do/node_modules node tests/notebook-online.cjs
node scripts/build-site.mjs
```

Test SQL uruchamia prawdziwy PostgreSQL/pgvector w pamięci przez PGlite. Test funkcji Edge ma zamkniętą sieć z atrapami OpenAI/Supabase. Test przeglądarkowy korzysta z osobnych sesji, lokalnego serwera i syntetycznego PDF-a (Playwright, Chrome, pdf-lib). Żaden z nich nie używa produkcji ani nie płaci za API.

Przed publikacją wykonaj na testowym projekcie ocenę 30–50 rzeczywistych pytań: polska terminologia, tabele, procedury wieloetapowe, pytania uzupełniające, podchwytliwe i nieopisane w książce. Zapisz oczekiwane strony i ocenę poprawności w ignorowanym `private-kompendium/`. Nie publikuj odpowiedzi z wymyślonymi zasadami ani błędnymi stronami. Testy techniczne nie zastępują tej oceny. Dopiero potem wdrażaj na produkcji.
