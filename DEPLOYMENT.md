# Wdrożenie onejournal

## Supabase

1. Utwórz pusty projekt PostgreSQL. Włącz Authentication → Sign In / Providers → Allow anonymous sign-ins. Anonimowa sesja nie daje dostępu do gry, dopóki serwer nie sprawdzi prywatnego linku.
2. Zastosuj wszystkie migracje z `supabase/migrations/` w kolejności nazw (CLI lub MCP). Prywatne tabele nie mają polityk odczytu dla klientów; to zamierzona blokada, nie brak konfiguracji.
3. W Edge Functions → Secrets ustaw:
   - `ONEJOURNAL_ENCRYPTION_KEY`: losowe 32 bajty zakodowane base64. Wygeneruj w zaufanym terminalu: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.
   - `ONEJOURNAL_ALLOWED_ORIGINS`: rozdzielone przecinkami originy, np. `https://gerdax.github.io,http://localhost:8877,http://127.0.0.1:8877`. Bez końcowego ukośnika ani ścieżki.
4. `node scripts/admin-build.mjs` synchronizuje współdzielone reguły do katalogu funkcji. Następnie wdróż funkcję `onejournal`. Zachowaj `verify_jwt=true`; funkcja dodatkowo sprawdza użytkownika przez Auth API i grant dostępu przy każdym żądaniu. Nie wyłączaj weryfikacji bramy w razie błędu — najpierw sprawdź klucze projektu i logi.
5. W zaufanym terminalu ustaw `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ONEJOURNAL_ENCRYPTION_KEY` i uruchom `node scripts/admin-bootstrap.mjs`. Alternatywnie `--sql` wymaga tylko klucza szyfrowania i generuje SQL do administracyjnego wykonania. Wyjście zawiera prywatny sekret MG — zachowaj je poza Git. Ponowne wykonanie rotuje dostęp MG.
6. Link MG ma postać `https://<adres-aplikacji>/#access=<sekret>`. MG tworzy bohaterów/importuje kopię, następnie generuje linki w Ustawieniach.

Po rotacji klucza szyfrowania trzeba ponownie zaszyfrować wszystkie linki lub wygenerować je od nowa. Zachowaj klucz w osobnej bezpiecznej kopii; sam eksport JSON go nie zawiera.

## GitHub Pages

Repozytorium: `gerdax/onejournal`. W Settings → Pages ustaw Source: GitHub Actions. Push na `main` uruchamia testy jednostkowe, przygotowanie `dist/` oraz publikację. Do hostingu trafiają wyłącznie jawnie wybrane pliki frontendowe i zasoby vendor — nie funkcje serwerowe, backupy ani konfiguracja administracyjna.

`config.js` zawiera publiczny URL Supabase i publishable key. Nigdy nie wpisuj tam service-role key. Przy zmianie adresu hostingu zmień dozwolone originy funkcji. Przy zmianie frontendowych plików podnieś wersję cache w service-worker.js.

## Odbiór i utrzymanie

Uruchom izolowane testy z README przed publikacją. Po wdrożeniu sprawdź wejście MG, brak dostępu bez linku, działanie Ustawień i połączenie Realtime. Nie przywracaj próbnych kopii w działającej grze.

Realtime wysyła tylko numer publicznej rewizji. Każde urządzenie dodatkowo pobiera stan co 5 sekund, co obsługuje prywatne zmiany MG, cofnięcie dostępu i naprawę przerwanej subskrypcji. Cofnięcie dostępu blokuje nowe żądania natychmiast; otwarty widok usuwa dane po otrzymaniu odmowy. Danych już wyświetlonych na odłączonym urządzeniu nie da się zdalnie odebrać.

Darmowy Supabase może wstrzymać projekt przy dłuższej nieaktywności. Przed spotkaniem sprawdź działanie linku. Regularnie pobieraj eksport gry i administracyjną kopię PostgreSQL. Przeniesienie samego JSON nie przenosi sesji ani linków; do zachowania dostępu potrzebna jest osobna, chroniona kopia infrastruktury i sekretów.

## Przeniesienie do innego środowiska

Odtwórz migracje w nowej bazie, ustaw oddzielne sekrety i nowy link MG, wgraj eksport JSON i sprawdź zgodność bohaterów, mapy oraz historii. Po potwierdzeniu wstrzymaj edycję starej gry, wykonaj końcowy eksport, import do nowego środowiska i przełącz konfigurację frontendu. Stare dane zachowaj do odbioru migracji. Zmiana dostawcy bez Supabase wymaga adaptera odpowiadającego kontraktowi `cloud-store.js` oraz serwera z tymi samymi kontrolami dostępu.
