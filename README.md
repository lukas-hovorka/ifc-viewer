# ifc.viewer – prohlížeč modelů IFC

Webová aplikace pro prohlížení modelů IFC přímo v prohlížeči. Modely se zpracují jen v zařízení, nikam se neodesílají.

Kopie projektu [10-ifc-viewer](https://github.com/hovolu/hovorkovicserver/tree/main/projekty/10-ifc-viewer)
převedená do vzhledu **EBC_UI_vibe** (neoficiální design podle knihovny EBC_UI). Jádro prohlížeče (`src/core`) je
převzaté beze změny funkcí, vyměněné je rozhraní.

- načtení IFC přetažením nebo výběrem souboru, více modelů najednou, `?model=<adresa>` pro načtení z adresy
- strom struktury (projekt → pozemek → stavba → podlaží → prvky), režimy GUID, hledání, spojení modelů do jednoho stromu
- filtry: třídy, atributy, vlastnosti, materiály, skupiny a sestavy, klasifikace
- výběr klepnutím i rámečkem, vlastnosti prvku, izolace, skrytí, kontextová nabídka
- řez rovinou a plochou, řezový kvádr, měření s přichycením, rozpad podlaží s barvením podle podlaží
- pohledy, perspektivní a ortogonální projekce, barva modelu, tmavý a světlý motiv
- uložení zobrazených modelů do jednoho sloučeného IFC, vyříznutí otvorů na vyžádání

Technika: [three.js](https://threejs.org), [web-ifc](https://github.com/ThatOpen/engine_web-ifc) ve Web Workeru,
[three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh), [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg),
[Vite](https://vite.dev).

## Spuštění

```bash
npm install
```

```bash
npm run dev
```

Otevřete <http://localhost:5180>. Zkušební modely patří do `public/models/` (složka není v Gitu),
načtou se přes `?model=models/nazev.ifc`.

## Nasazení

Po každém pushi do `main` se aplikace sestaví a nasadí na GitHub Pages (`.github/workflows/pages.yml`).
Jednorázově v repozitáři: *Settings → Pages → Build and deployment → Source: GitHub Actions*.

## Vzhled

Vzhled podle EBC_UI_vibe 2.8.0. Soubory v `src/ebc/` a `public/ebc/` jsou zkopírované z `dist/` design systému
a **needitují se** – při nové verzi se zkopírují znovu:

| Soubor | Zdroj v EBC_UI_vibe |
|---|---|
| `src/ebc/ebc-tokens.css`, `src/ebc/ebc-components.css` | `dist/css/` |
| `src/ebc/ebc-tokens.dark.json`, `src/ebc/ebc-tokens.light.json` | `dist/json/` (barvy 3D scény) |
| `public/ebc/ebc-icons.svg` | `dist/css/` |
| `public/favicon.svg` | `assets/logo/ebc-mark.svg` |

Vlastní styly jsou v `src/app.css` (třídy `.ifc-*`, hodnoty jen přes `var(--ebc-…)`), chování rozhraní
v `src/ui/gui.js`, motiv a barvy scény v `src/ui/theme.js`.

Co EBC_UI_vibe zatím nemá a aplikace si doplňuje sama (kandidáti na doplnění do design systému):

- ikony nástrojů (nabídka, hledání, celý model, oko, vrstvy, řez, kvádr, pravítko, cíl, rozpad, pohledy) – `src/ui/gui.js`
- plovoucí panel, lišta nástrojů nad plátnem, bublina nápovědy, oznámení, strom, menší tlačítko – `src/app.css`
- paleta 12 barev modelu a dopočítané barvy podlaží nad 6 kategorií dat

Autor: Lukáš Hovorka · <lukas.hovorka@energy-benefit.cz>
