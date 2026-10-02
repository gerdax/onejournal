# Wdrożenie onejournal

## Supabase

1. Utwórz pusty projekt PostgreSQL. Włącz Authentication → Sign In / Providers → Allow anonymous sign-ins. Anonimowa sesja nie daje dostępu do gry, dopóki serwer nie sprawdzi prywatnego linku.
2. Zastosuj wszystkie migracje z `supabase/migrations/` w kolejności nazw (CLI lub MCP), w tym `202609290001_hero_avatars.sql` i `202609300001_notebook.sql` przed wdrożeniem nowej funkcji i frontendu. Prywatne tabele i zasobnik Storage `onejournal-avatars` nie mają dostępu klienta; funkcja Edge korzysta z service role po sprawdzeniu aktywnego dostępu.
3. W Edge Functions → Secrets ustaw:
   - `ONEJOURNAL_ENCRYPTION_KEY`: losowe 32 bajty zakodowane base64. Wygeneruj w zaufanym terminalu: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.
   - `ONEJOURNAL_ALLOWED_ORIGINS`: rozdzielone przecinkami originy, np. `https://gerdax.github.io,http://localhost:8877,http://127.0.0.1:8877`. Bez końcowego ukośnika ani ścieżki.
4. `node scripts/admin-build.mjs` synchronizuje współdzielone reguły do katalogu funkcji. Następnie wdróż funkcję `onejournal`. Zachowaj `verify_jwt=true`; funkcja dodatkowo sprawdza użytkownika przez Auth API i grant dostępu przy każdym żądaniu. Nie wyłączaj weryfikacji bramy w razie błędu — najpierw sprawdź klucze projektu i logi.
5. W zaufanym terminalu ustaw `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ONEJOURNAL_ENCRYPTION_KEY` i uruchom `node scripts/admin-bootstrap.mjs`. Alternatywnie `--sql` wymaga tylko klucza szyfrowania i generuje SQL do administracyjnego wykonania. Wyjście zawiera prywatny sekret MG — zachowaj je poza Git. Ponowne wykonanie rotuje dostęp MG.
6. Link MG ma postać `https://<adres-aplikacji>/#access=<sekret>`. MG tworzy bohaterów/importuje kopię, następnie generuje linki w Ustawieniach.

Po rotacji klucza szyfrowania trzeba ponownie zaszyfrować wszystkie linki lub wygenerować je od nowa. Zachowaj klucz w osobnej bezpiecznej kopii; sam eksport JSON go nie zawiera.

Aktualizacja notatnika wymaga kolejności: migracja `202609300001_notebook.sql`, `node scripts/admin-build.mjs` i wdrożenie Edge Function, następnie publikacja frontendu. Migracja dodaje prywatną treść i wersję notatnika; nie zmienia istniejących arkuszy, mapy ani rzutów.

Aktualizacja edytowalnych notatek przeciwników: uruchom `node scripts/admin-build.mjs`, wdróż funkcję Edge z obsługą `setEnemyNotes`, a dopiero potem frontend. Migracja danych nie jest potrzebna. Starszy frontend działa z nowym backendem.

## GitHub Pages

Repozytorium: `gerdax/onejournal`. W Settings → Pages ustaw Source: GitHub Actions. Push na `main` uruchamia testy jednostkowe, przygotowanie `dist/` oraz publikację. Do hostingu trafiają wyłącznie jawnie wybrane pliki frontendowe i zasoby vendor — nie funkcje serwerowe, backupy ani konfiguracja administracyjna.

`config.js` zawiera publiczny URL Supabase i publishable key. Nigdy nie wpisuj tam service-role key. Przy zmianie adresu hostingu zmień dozwolone originy funkcji. Przy zmianie frontendowych plików podnieś wersję cache w service-worker.js.

## Odbiór i utrzymanie

Uruchom izolowane testy z README przed publikacją. Po wdrożeniu sprawdź wejście MG, brak dostępu bez linku, działanie Ustawień i połączenie Realtime. Nie przywracaj próbnych kopii w działającej grze.

Sprawdź też zapis i odczyt portretu jako MG i właściciel bohatera, odmowę po cofnięciu linku oraz eksport kopii v2 z portretami. Test przywracania wykonaj tylko na oddzielnym projekcie. Eksport zawiera obrazy; zachowaj go jako prywatny plik. Zastąpione portrety pozostają w Storage jako niezmienne obiekty, dopóki nie zostanie wdrożone bezpieczne czyszczenie uwzględniające zachowane kopie.

Realtime wysyła tylko numer publicznej rewizji. Każde urządzenie dodatkowo pobiera stan co 5 sekund, co obsługuje prywatne zmiany MG, cofnięcie dostępu i naprawę przerwanej subskrypcji. Cofnięcie dostępu blokuje nowe żądania natychmiast; otwarty widok usuwa dane po otrzymaniu odmowy. Danych już wyświetlonych na odłączonym urządzeniu nie da się zdalnie odebrać.

Darmowy Supabase może wstrzymać projekt przy dłuższej nieaktywności. Przed spotkaniem sprawdź działanie linku. Regularnie pobieraj eksport gry i administracyjną kopię PostgreSQL. Przeniesienie samego JSON nie przenosi sesji ani linków; do zachowania dostępu potrzebna jest osobna, chroniona kopia infrastruktury i sekretów.

## Przeniesienie do innego środowiska

Odtwórz migracje w nowej bazie, ustaw oddzielne sekrety i nowy link MG, wgraj eksport JSON i sprawdź zgodność bohaterów, mapy oraz historii. Po potwierdzeniu wstrzymaj edycję starej gry, wykonaj końcowy eksport, import do nowego środowiska i przełącz konfigurację frontendu. Stare dane zachowaj do odbioru migracji. Zmiana dostawcy bez Supabase wymaga adaptera odpowiadającego kontraktowi `cloud-store.js` oraz serwera z tymi samymi kontrolami dostępu.

## Biblioteka map

Przed publikacją frontendu biblioteki map zastosuj migrację `202610020001_map_library.sql`, uruchom `node scripts/admin-build.mjs` i wdróż Edge Function. Nowy backend nadal obsługuje stare mapy generatora. Bucket `onejournal-maps` jest prywatny; tylko funkcja Edge odczytuje obrazy po sprawdzeniu dostępu. Gracze mogą pobrać wyłącznie obraz aktualnej potyczki.

Usunięcie mapy z biblioteki nie usuwa aktywnego tła ani fizycznych obiektów Storage. Obrazy pozostają niezmienne; automatyczne czyszczenie nie jest częścią tej aktualizacji. Kopie gry obejmują bibliotekę oraz obraz aktywnej mapy, również po usunięciu wpisu z biblioteki. Sprawdź import wyłącznie na izolowanych danych.
