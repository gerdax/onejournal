# Naprawa skakania żetonów — 3 października 2026

## Zakres i zachowanie

Gałąź `codex/token-drag-fix`, osobny worktree, baza `d902157` z `main`. Główny katalog, jego niezapisane zmiany i poprzedni worktree audytu pozostały nietknięte. Nie wykonano merge, wdrożenia ani operacji na danych produkcyjnych.

Snapshot aktualizuje istniejące elementy żetonów zamiast je wymieniać. Przeciągany żeton zachowuje lokalną pozycję; po puszczeniu pozostaje na miejscu do zakończenia zapisu. Starsze potwierdzenie nie usuwa pozycji nowszego ruchu. Kolejne przeciągnięcie i strzałki startują z widocznej pozycji. Anulowanie wraca do oczekującej lub ostatniej znanej pozycji serwera, a utrata możliwości zapisu usuwa lokalne pozycje oczekujące. Zmiana scenerii lub usunięcie uczestnika również je usuwa.

Granice ruchu odpowiadają normalizacji serwera, dzięki czemu potwierdzenie nie koryguje żetonu o kilka pikseli przy krawędzi. Jedynymi zmienionymi plikami produkcyjnymi są `map.js` i wersja cache w `service-worker.js` (`v68-token-drag-sync`). Kolejka zapisów, komendy zaznaczenia i ruchu, polling, Supabase Realtime, API i format danych pozostały bez zmian.

## Wyniki pomiarów

Chrome 154.0.8037.98 headless, macOS arm64 / M1 Pro, Node 24.3.0, viewport 1280×900. Jeden MG i dwóch graczy w oddzielnych kontekstach, dane jednorazowe. Po rozgrzewce: 20 powtórzeń każdego przypadku dla 10/50 żetonów i dodatkowych opóźnień 0/150/600 ms. Harness i tracing takie jak w audycie.

- **360/360 ruchów**: poprawny końcowy zapis, zero klatek cofających żeton, oryginalny element żetonu pozostał w DOM.
- **240 prób z wymuszonym snapshotem podczas przeciągania**: zero odłączeń i skoków. W audycie element odłączał się w 240/240 prób; wszystkie 160 prób z opóźnieniami 150/600 ms pokazywały cofanie.
- **120 szybkich puszczeń niezaznaczonego żetonu**: zero cofnięć, także gdy odpowiedź na zaznaczenie przychodziła po puszczeniu.
- p95 odstępu między klatkami w próbach przeciągania: około 16,7–16,8 ms. Po potwierdzeniu MG jawne odświeżenie obu graczy potwierdziło tę samą pozycję.

Poniższa tabela dotyczy szybkiego puszczenia niezaznaczonego żetonu. Czasy to mediana / p95 od puszczenia do potwierdzenia, w ms. „Przed” pochodzi z audytu na bazie `63bb0e5`; nowa gałąź uwzględnia późniejsze zatwierdzone zmiany aplikacji.

| Żetony | Dodane opóźnienie | Próby z cofnięciem: przed → po | Potwierdzenie przed | Potwierdzenie po |
|---|---|---|---|---|
| 10 | 0 | 1/20 → 0/20 | 13.8 / 14.6 | 16.0 / 18.5 |
| 10 | 150 | 20/20 → 0/20 | 214.7 / 216.2 | 215.1 / 216.5 |
| 10 | 600 | 20/20 → 0/20 | 1115.3 / 1118.1 | 1116.4 / 1118.8 |
| 50 | 0 | 0/20 → 0/20 | 21.2 / 23.8 | 29.2 / 30.2 |
| 50 | 150 | 20/20 → 0/20 | 222.1 / 224.8 | 221.2 / 223.6 |
| 50 | 600 | 20/20 → 0/20 | 1122.4 / 1126.7 | 1122.5 / 1125.6 |

Czas oczekiwania na serwer nie został skrócony: przy 600 ms szybki ruch nadal czeka około 500 ms w kolejce po zaznaczeniu. Poprawka stabilizuje lokalny obraz w tym czasie. Przy 50 żetonach bez dodanego opóźnienia instrumentowany czas potwierdzenia jest o około 8 ms wyższy niż w audycie; nie przedstawiamy tej zmiany jako optymalizacji szybkości zapisu. Pomiary zawierają narzut śledzenia i różnicę baz kodu.

## Weryfikacja

- Bazowe testy jednostkowe: 127/127; po przeniesieniu testowych kontrolerów fixture: 129/129.
- Build, kontrole składni zmienionego JS i `git diff --check`: poprawne.
- 10 istniejących testów Chrome: poprawne (`online`, `dice-online`, desktop/dotyk/odznaczanie mapy, zakładki i pamięć kości, panele mapy, notatki przeciwnika, biblioteka map).
- Nowy test `map-drag-sync-online.cjs`: 12 kombinacji żetonów/opóźnień/zaznaczenia oraz przypadki kolejnych ruchów, anulowania, błędu zapisu i odzyskania połączenia, dotyku, klawiatury i granic mapy; usunięcie uczestnika i wymiana scenerii przed spóźnioną odpowiedzią. Wszystkie przeszły. Asercje cofnięcia po błędzie i spóźnionej odpowiedzi sprawdzają widok przed dodatkowym odświeżeniem.
- Test z oryginalnym `map.js` z `d902157` prawidłowo kończy się błędem `drag keeps the token DOM node`; ten sam test przechodzi z poprawką. Logi: `artifacts/map-drag-baseline.log` i `artifacts/map-drag-final.log`.
- Niezależny przegląd kodu produkcyjnego: bez istotnych uwag.
- `node performance/verify-map.cjs`: potwierdził wszystkie 360 prób na surowych danych.

## Ograniczenia

To pomiary lokalnego klienta, nie czasu działania produkcyjnej bazy, Edge Function ani prawdziwego Supabase Realtime. Odświeżenia graczy są jawnie wywoływane przez harness. Service worker i zewnętrzne połączenia są blokowane w testach. Wersję cache zaktualizowano; nie wdrażano aplikacji.

Obecny kontrakt mapy nie ma identyfikatora jej konkretnego załadowania: ponowne wczytanie dokładnie tej samej scenerii/obrazu podczas ruchu nie daje widokowi jednoznacznego sygnału wymiany mapy. Nie rozszerzano protokołu ani zasad wykonywania już zakolejkowanych komend.

Polecenia odtworzenia opisuje [README](README.md). Surowe wyniki, logi, zrzuty ekranu i ślady znajdują się lokalnie w `artifacts/`, ignorowanym przez Git. Szersze usprawnienia komunikacji i renderowania pozostałych widoków pozostają osobnym etapem.
