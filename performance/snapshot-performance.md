# Optymalizacja snapshotów i widoków — etap 2

3 października 2026. Gałąź `codex/snapshot-performance`, osobny worktree na bazie opublikowanego `ae75af0`. Główny katalog i jego niezapisane prace pozostawiono bez zmian. Nie wykonano publikacji ani operacji na danych produkcyjnych.

## Zmiany

- Warunkowy odczyt snapshotu: klient przekazuje znaną rewizję i zakres dostępu. Po sprawdzeniu aktualnych uprawnień serwer może odpowiedzieć krótkim `unchanged`, bez budowania i przesyłania całej projekcji gry.
- Identyczny lub starszy snapshot nie uruchamia zbędnych powiadomień widoków. Pełne odpowiedzi nadal porównują wszystkie pola projekcji, a wynik komendy jest zwracany wywołującemu oddzielnie. Zmiany połączenia nadal są zgłaszane.
- Niepowiązane zmiany nie przebudowują list bohaterów/przeciwników ani dziennika; ukryta mapa przechowuje aktualny stan i odświeża się po otwarciu. Arkusze zachowują obsługę wersji, konfliktów i autosave również w ukryciu. Powiadomienia o rzutach działają przy zamkniętym dzienniku.
- Utrata dostępu usuwa prywatną zawartość widoków. Stare odpowiedzi i błędy odczytu nie zakłócają świeżego odzyskiwania połączenia; odmowa dostępu 401/403 pozostaje nadrzędna i unieważnia sesję. Odzyskanie połączenia wymaga pełnego odczytu.

Kolejka zapisów, komendy zaznaczania/ruchu, Realtime, polling co 5 sekund, format zapisanych danych i animacja kości pozostały bez zmian. To etap optymalizacji odczytów i renderowania, nie przebudowa kolejki komunikacji.

## Porównanie z opublikowaną wersją

Chrome 154.0.8037.98 headless, macOS arm64, Node 24.3.0, viewport 1280×900; 10/50 żetonów, 80 publicznych wpisów dziennika, MG i dwóch graczy w osobnych kontekstach. Każdy scenariusz: 3 rundy rozgrzewki i 20 powtórzeń, dodane opóźnienia odpowiedzi 0/150/600 ms. Ta sama lokalna implementacja fixture i ten sam harness przed/po; konfiguracja blokuje zewnętrzne połączenia i service worker.

Tabela dotyczy **niezmienionych odczytów**. Transfer oznacza sumę JSON odpowiedzi snapshot z 20 rund × 3 klientów, bez nagłówków i treści żądań. Czas obejmuje całą rundę jawnego odświeżenia trzech klientów, mediana / p95 w ms.

| Żetony | Dodane opóźnienie ms | Bajty odpowiedzi przed → po | Czas rundy przed → po |
|---|---|---|---|
| 10 | 0 | 4,522,160 → 5,660 | 13.8 / 15.0 → 4.7 / 6.3 |
| 10 | 150 | 4,522,220 → 5,720 | 167.3 / 170.0 → 163.4 / 165.5 |
| 10 | 600 | 4,522,220 → 5,720 | 621.1 / 625.6 → 612.3 / 616.3 |
| 50 | 0 | 5,325,120 → 5,660 | 18.4 / 21.8 → 4.8 / 7.6 |
| 50 | 150 | 5,325,180 → 5,720 | 167.3 / 175.5 → 161.4 / 165.1 |
| 50 | 600 | 5,325,180 → 5,720 | 625.0 / 629.0 → 612.6 / 616.6 |

Przy 50 żetonach transfer niezmienionych odpowiedzi spadł o około **99,9%**. Liczba wywołań pozostaje taka sama: utrzymujemy wykrywanie cofnięcia dostępu i fallback synchronizacji.

Wszystkie **240 zmierzonych rund po zmianach** zakończyły się poprawnie: 120 niezmienionych odczytów i 120 ruchów przy ukrytej mapie. Snapshoty wszystkich klientów miały zgodne pozycje, a otwarcie mapy pokazywało najnowszą pozycję. W obserwowanych korzeniach mapy, bohaterów, biblioteki, starej walki i dziennika nie było mutacji DOM podczas obu scenariuszy. Przy niezmienionym stanie MG dostał 0 powiadomień store zamiast 20; przy 20 ruchach — 20 zamiast 40.

Dla przykładu, 50 żetonów / 0 ms / niezmienione odczyty dawały wcześniej 5180 mutacji mapy, 1620 dziennika, 1060 starej walki, 280 biblioteki i 200 bohaterów. Po zmianie wszystkie te liczniki wynoszą zero. Nie mierzymy tu wszystkich mutacji całej aplikacji.

Przy rzeczywistych ruchach gracze nadal otrzymują pełną zmienioną projekcję. Oszczędność jest mniejsza niż przy bezczynności, a timing pollingu może powodować dodatkowe pełne odczyty. Nie przedstawiamy 99,9% jako oszczędności całego ruchu sieciowego podczas gry.

## Weryfikacja

- **143/143** testy jednostkowe; kontrole składni, `git diff --check` i build poprawne.
- **13 istniejących testów Chrome**: połączenie, kości, zakładki/pamięć ustawień, mapa desktop/dotyk/odznaczanie, panele, notatki przeciwnika, biblioteka map i awarie obrazów, notatnik, portrety — poprawne.
- `map-drag-sync-online.cjs`: wszystkie 12 kombinacji liczby żetonów/opóźnienia/zaznaczenia i przypadki szybkich kolejnych ruchów, anulowania, błędu zapisu, dotyku, klawiatury, usunięcia uczestnika i wymiany mapy — poprawne.
- `render-performance-online.cjs`: niezmieniony odczyt, brak przebudowy niepowiązanych widoków, aktualizacja po otwarciu, autosave ukrytego arkusza, powiadomienie o rzucie przy zamkniętym dzienniku, cofnięcie lokalnej pozycji offline i czyszczenie prywatnych danych — poprawne. Test odzyskiwania autosave czeka na rzeczywistą nieudaną próbę zapisu offline przed ukryciem arkusza i odzyskaniem połączenia.
- Testy protokołu obejmują starszy backend zwracający pełne odpowiedzi, starszego klienta bez warunku, cofnięcie/rotację dostępu, zmianę bohatera przy tej samej rewizji, prywatne zmiany MG, spóźnione odpowiedzi i błędy oraz konflikt odzyskiwania połączenia z odmową dostępu.
- Niezależny przegląd zakończony bez pozostałych istotnych uwag. Wykryte wyścigi i problem ponawiania autosave zostały poprawione i objęte testami.

## Publikacja i ograniczenia

Do uzyskania oszczędności transferu trzeba wdrożyć również funkcję Edge `onejournal`; jej współdzielony `server-core.js` jest zsynchronizowany. Zalecana kolejność: backend, potem frontend. Brak migracji bazy. Stary klient z nowym backendem działa normalnie, a nowy frontend ze starym backendem nadal działa, lecz dostaje pełne odpowiedzi. Cache frontendu: `v69-snapshot-performance`.

Serwer nadal odczytuje dokument PostgreSQL przy każdym pollingu. Wyniki nie dowodzą zmniejszenia kosztu odczytu bazy ani liczby wywołań Edge Function. Są lokalnymi pomiarami klienta i rozmiarów odpowiedzi; powiadomienia to jawne odświeżenia fixture, nie prawdziwe Supabase Realtime. Zmiana statycznego katalogu bez zmiany rewizji staje się dostępna przy kolejnym pełnym odczycie, np. ponownym otwarciu aplikacji.

Polecenia odtworzenia są w [README](README.md). Surowe wyniki i logi: `performance/artifacts/snapshot-before.json`, `snapshot-after.json`, `unit-final.log`, `render-final.log`, `drag-final.log` oraz logi regresji. Artefakty pozostają poza Git.
