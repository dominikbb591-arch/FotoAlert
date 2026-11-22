# Fotoalert

Aplikacja PWA z ostrzeżeniami o fotoradarach, limitem prędkości, nawigacją, stacjami paliw, sklepami Żabka
i wspólnymi zgłoszeniami kierowców. Serwer nie ma zależności (sam Node.js 18+).

## Pliki

Wszystkie pliki leżą w jednym folderze (bez podfolderów):
`server.js`, `package.json`, `index.html`, `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `icon.svg`.
Serwer sam rozpozna ten układ. Serwuje tylko pliki aplikacji, nigdy `server.js` ani `package.json`.

## Uruchomienie lokalnie

    node server.js

Potem otwórz http://localhost:3000 (GPS w telefonie wymaga HTTPS, więc do prawdziwej jazdy wdróż ją w internecie).

## Wdrożenie (Render, plan darmowy)

1. Rozpakuj ZIP (na iPhonie: dotknij pliku w aplikacji Pliki). Na GitHubie wybierz **Add file → Upload files** i zaznacz **wszystkie pliki z rozpakowanego folderu** (nie sam ZIP). Zatwierdź przyciskiem **Commit changes**. Na głównej stronie repozytorium muszą być widoczne `package.json` i `server.js`.
2. Na render.com wybierz **New → Web Service** i połącz to repozytorium.
3. Ustaw: **Root Directory puste**, Runtime **Node**, Build Command puste lub `npm install`, Start Command `npm start`, plan **Free**.
4. Po wdrożeniu dostaniesz adres `https://nazwa.onrender.com`. Otwórz go w Safari na iPhonie, wybierz Udostępnij → **Dodaj do ekranu początkowego**.

Uwagi:
- Darmowy plan usypia usługę po dłuższym braku ruchu. Pierwsze otwarcie po przerwie może trwać około minuty.
- Bez dysku trwałego zgłoszenia i ceny paliw znikają przy każdym ponownym wdrożeniu lub restarcie. Zgłoszenia i tak wygasają po 45 minutach do 24 godzin.
- Jeśli hostujesz samą aplikację osobno (np. GitHub Pages), a serwer osobno, wpisz adres serwera w Ustawieniach.

## Skąd są dane

- Fotoradary, stacje paliw, sklepy Żabka i ograniczenia prędkości: OpenStreetMap (licencja ODbL), pobierane na bieżąco przez Overpass API.
- Wyszukiwanie adresów: Nominatim. Trasy: publiczny serwer OSRM. To darmowe serwery społecznościowe z limitami, wystarczą do osobistego użytku.
- Ceny paliw: wpisują je użytkownicy w panelu stacji. Nie ma darmowego, publicznego źródła cen w czasie rzeczywistym.
- Zgłoszenia drogowe (policja, wypadek, zwierzę itd.) i licznik online: Twój serwer.

## Prywatność

Serwer widzi losowy identyfikator urządzenia i ostatnią pozycję wysłaną przy odświeżaniu. Nie zapisuje tras ani historii pozycji.
Licznik online liczy tylko urządzenia, które w ciągu ostatnich 45 sekund miały aplikację na wierzchu.
