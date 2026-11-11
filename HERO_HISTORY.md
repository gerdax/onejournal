# Historia kart postaci

Historia zapisuje się automatycznie w Supabase od wdrożenia tej funkcji. Każda
istniejąca karta otrzymuje dokładną kopię początkową. Wcześniejszych zmian nie
da się z niej odtworzyć.

MG otwiera kartę i wybiera **Historia arkusza**. Może obejrzeć zapis, pobrać jego
JSON albo przywrócić wybraną wersję wraz z odwołaniem do portretu. Potwierdzenie
przywrócenia dotyczy wyłącznie tej karty. Nowsza zmiana karty od czasu otwarcia
okna blokuje przywrócenie; trzeba ponownie otworzyć historię. Szkic należy
najpierw zapisać lub odrzucić. Gracze nie mają dostępu do historii.

Okno pokazuje 100 najnowszych zapisów. Starsze pozostają w bazie: nie ma
automatycznego czyszczenia. Usunięcie karty także zostawia historię, w tym pełny
stan sprzed usunięcia; odzyskanie usuniętej karty lub wersji spoza ostatnich 100
wymaga obecnie pomocy administratora. JSON pobrany z historii to pojedynczy
zapis, nie plik dla przycisku „Wgraj bazę”.

## Zabezpieczenia

- Prywatna tabela `onejournal_private.hero_history` przechowuje dokładne JSON-y
  przed i po zmianie, datę, identyfikator karty i wersje. Nie ma powiązania
  kaskadowo usuwającego historię wraz z kartą.
- Trigger działa w tej samej transakcji co zapis gry. Błąd zapisu historii
  blokuje zmianę gry. Obejmuje zapisy arkusza, zasoby z rzutów, portrety,
  import kopii i usunięcia. Zmiany innych części gry nie dublują kart.
- Migracja blokuje zapisy na czas utworzenia kopii początkowych i triggera;
  porównuje cały rekord gry przed i po, a niezgodność wycofuje migrację.
- RPC odczytu jest dostępne wyłącznie dla `service_role`; Edge sprawdza aktywne
  uprawnienia MG. Historia nie jest częścią zwykłych snapshotów graczy.
- Przywracanie używa zaufanego zapisu z serwera, jawnej wersji karty i CAS.
  Nie normalizuje ani nie przepisuje pozostałych kart i danych gry. Brak obrazu
  historycznego portretu blokuje przywrócenie. Obrazy pozostają w prywatnym Storage.

## Kopie poza projektem

Przed wdrożeniem zapisano prywatnie w ignorowanym katalogu `backups/`:

- `2026-11-11-before-hero-history.json`: dokładny rekord gry i wewnętrzny dziennik;
- `2026-11-11-portable-before-hero-history.json`: przenośny eksport aplikacji,
  zawierający karty, notatki, dziennik, portrety i obrazy biblioteki map;
- `2026-11-12-edge-before-history.json`: poprzedni kod funkcji Edge.

Nie publikować tych plików. Pełną kopię przenośną można nadal pobrać przez
**Eksportuj bazę**. Eksport aplikacji nie zawiera tabeli historii, sesji ani
linków dostępu. Historia w tym samym projekcie Supabase nie zastępuje kopii
poza projektem. To wdrożenie nie konfiguruje cyklicznych kopii zewnętrznych.

Testy izolowane: `node --test tests/hero-history-sql.test.js` i
`node tests/hero-history-online.cjs` (Playwright + Chrome). Nie testować
przywracania na rzeczywistych kartach.
