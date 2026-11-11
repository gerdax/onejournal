# Weryfikacja naprawy przeciągania żetonów

Pracuj w osobnym worktree. Testy uruchamiają jednorazowy serwer w pamięci oraz świeże konteksty Chrome; blokują połączenia poza lokalnym fixture, WebSockety i service worker. Nie korzystają z produkcyjnych danych.

Wymagania: Node 22.18+, zależności projektu (`npm ci --ignore-scripts`), Playwright dostępny dla Node oraz Chrome. Opcjonalne `CHROME_PATH` wskazuje inną instalację Chrome. W środowisku Codex:

```sh
export NODE_PATH="/Users/adamsmereczynski/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"
node --test tests/*.test.js
node tests/map-drag-sync-online.cjs
node performance/regressions.cjs
node performance/map-audit.cjs
node performance/verify-map.cjs
node scripts/build-site.mjs
```

Uruchamiaj testy i benchmark kolejno. Benchmark pochodzi z gałęzi audytu i domyślnie wykonuje 20 powtórzeń po rozgrzewce: 240 przeciągnięć z wymuszonym snapshotem i 120 szybkich puszczeń niezaznaczonego żetonu. `AUDIT_REPETITIONS=1` służy wyłącznie do smoke testu. `verify-map.cjs` sprawdza wynik zapisu, zachowanie elementu DOM i brak klatek cofających żeton.

`artifacts/` jest ignorowane przez Git. Zawiera surowe próbki JSON, logi, zrzuty ekranu i ślady Playwright; ślady mogą być duże. Kolejne uruchomienia nadpisują wyniki. Zachowaj osobną kopię, jeśli potrzebujesz porównania.

Opóźnienia 0/150/600 ms to dodatkowe wstrzymanie odpowiedzi po przetworzeniu jej przez lokalny serwer, nie pomiar Internetu. Powiadomienia snapshotów są jawnie symulowane przez harness, nie są Supabase Realtime. Czas synchronizacji obserwatora mierzy odświeżenie graczy po potwierdzeniu ruchu MG. Instrumentacja i tracing zwiększają koszt pomiaru.

`regressions.cjs` uruchamia 13 istniejących testów przeglądarkowych z preloadem `local-only.cjs`; wyniki zapisuje w `artifacts/regressions.json`. Dodatkowy test przeciągania sam wymusza izolację sieci.

Test regresyjny przyjmuje opcjonalne `BASELINE_MAP_PATH` wskazujące lokalną kopię starego `map.js`. W tym trybie pierwszy scenariusz powinien zakończyć się błędem zachowania elementu DOM; pozwala to zweryfikować, że test wykrywa pierwotny problem.

## Etap 2: snapshoty i ukryte widoki

```sh
node tests/render-performance-online.cjs
node tests/map-drag-sync-online.cjs
node performance/regressions.cjs
node performance/snapshot-audit.cjs
```

`snapshot-audit.cjs` wykonuje po 20 prób dla 10/50 żetonów, 80 wpisów dziennika i opóźnień 0/150/600 ms. Mierzy niezmienione odczyty oraz ruchy przy ukrytej mapie: rozmiary odpowiedzi snapshot, czas całej rundy MG + dwóch graczy, powiadomienia store i mutacje DOM w obserwowanych widokach. W obu przypadkach sprawdza końcowe pozycje klientów i odświeżenie mapy po otwarciu. `AUDIT_ROOT` może wskazywać osobny checkout wersji bazowej; `AUDIT_OUTPUT` zmienia nazwę JSON (domyślnie `snapshot-after.json`). Konteksty nie łączą się poza lokalnym fixture. Wyniki opisuje [raport etapu 2](snapshot-performance.md).
