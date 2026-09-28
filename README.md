# onejournal

Polska aplikacja do wspólnej gry w Jedyny Pierścień: mistrz gry, prywatne arkusze bohaterów, wspólna mapa i dziennik rzutów. Niezależna wersja projektu [bestiary](https://github.com/gerdax/bestiary), z zachowaną historią. Tag `bestiary-baseline-2026-09-28` wskazuje wersję źródłową.

## Korzystanie

MG i gracze otwierają indywidualne linki `#access=…`. Link jest kluczem dostępu — przekazuj go tylko właściwej osobie. Po otwarciu znika z adresu; sesja utrzymuje się w tej karcie przeglądarki. Każde nowe urządzenie może wejść przez ten sam link.

- **MG:** Drużyna, Przeciwnicy, Mapa, Ustawienia. Tworzenie, kopiowanie i unieważnianie linków w Ustawieniach. Nowy link odwołuje stare sesje.
- **Gracz:** własny arkusz i mapa. Edytuje swój arkusz, widzi żetony i wspólne zaznaczenie MG. Nie przesuwa żetonów ani nie widzi cudzych arkuszy i statystyk przeciwników.
- **Rzuty:** animacja 3D u rzucającego, powiadomienie i historia u pozostałych. MG wybiera ogólny rzut Bohatera (wspólny), NPC lub Przeciwnika (oba prywatne). NPC używa zasad Bohatera. Tylko gracz rzuca pod imieniem własnej postaci. Nie odejmują zasobów automatycznie. Wynik oczekujący na publikację można ponowić w Dzienniku bez nowego losowania.
- **Brak internetu:** ostatni widok zostaje; zapisy i nowe rzuty są zablokowane. Szkic wpisany w arkuszu pozostaje w otwartej karcie i można go ponowić po odzyskaniu połączenia. Zamknięcie karty może utracić niezapisany szkic.

Dane wspólnej gry przechowuje Supabase. Kod frontendowy publikuje GitHub Pages. Komputer MG nie musi być włączony. Baza nie jest częścią publicznego repozytorium.

## Uruchomienie i wdrożenie

Zobacz [DEPLOYMENT.md](DEPLOYMENT.md). `config.js` zawiera wyłącznie publiczny adres projektu i publishable key. Klucze administracyjne, sekret szyfrujący i linki graczy nie mogą trafiać do tego pliku ani do repozytorium.

Frontend lokalny: `python3 -m http.server 8877`, adres `http://localhost:8877/`. Origin musi być dopuszczony w konfiguracji funkcji. Produkcyjny katalog publicznych plików przygotowuje `node scripts/build-site.mjs`; aplikacja nie wymaga bundlera ani pakietów npm do działania. Workflow Pages publikuje tylko `dist/`.

## Testy

- `node --test tests/*.test.js` — reguły, stan, uprawnienia, kopie i adapter chmurowy.
- `node --check <zmieniony-plik.js>` — składnia.
- `NODE_PATH=<katalog-node_modules> node tests/online.cjs` — izolowany serwer w pamięci i osobne przeglądarki MG/dwóch graczy.
- `NODE_PATH=<katalog-node_modules> node tests/dice-online.cjs` — rzeczywisty rzut WebGL oraz ponowienie publikacji po awarii sieci.

Testy przeglądarkowe wymagają Playwright i Chrome. `CHROME_PATH` nadpisuje domyślną ścieżkę macOS. Pozostałe odziedziczone skrypty `.cjs` opisują lokalny interfejs bestiary i nie są testami online; nie uruchamiaj ich na produkcji.

## Dane i migracja

W Ustawieniach MG można eksportować pełną grę do JSON (`format: onejournal`, wersja 1), w tym dziennik, oraz importować dotychczasowe kopie bestiary w wersji 2. Import zastępuje dane wspólnej gry; nie scala ich. Kopia onejournal odtwarza dziennik, import starej kopii bez dziennika zachowuje istniejący dziennik. Usunięcie bohatera przez przywrócenie kopii odbiera jego dostęp. Eksport nie zawiera sekretów ani sesji.

onejournal nie odczytuje `localStorage` bestiary. Import danych jest jawny i nigdy nie usuwa starego zapisu. Przy publikacji obu aplikacji pod `gerdax.github.io` mają wspólny origin: nowy service worker czyści tylko własny cache, ale stary worker bestiary może usuwać cache innych aplikacji przy swojej aktywacji. Pełną izolację daje osobny origin. Nie otwieraj starych i nowych linków w tej samej karcie bez zakończenia sesji.

Przenośny kontrakt opisuje [STATE_API.md](STATE_API.md), a warstwę serwerową [BACKEND.md](BACKEND.md). Dane mają własne identyfikatory. Reguły i model gry nie zależą od Supabase; przy zmianie dostawcy należy odtworzyć uwierzytelnianie, transakcje i powiadomienia oraz wykonać próbny import.
