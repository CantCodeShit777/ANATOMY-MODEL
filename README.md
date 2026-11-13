# ANATOMY-MODEL

An interactive 3D human anatomy atlas. Switch between Skin, Muscles and Skeleton, tap a structure to read about it, search by name, and hide or isolate parts to see what lies beneath.

## Run locally

The app is plain static files, with no build step. Serve the folder over HTTP from the repository root:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. The first load takes a few seconds because the 3D data file is about 10 MB.

## Layout

- `index.html`: page structure (header, 3D stage, information panel)
- `css/atlas.css`: all styles; colours and fonts are CSS variables on `:root`
- `js/app.js`: UI state, rendering and controls
- `js/anatomy-viewer.js`: three.js viewer (mesh decoding, orbit/zoom/pan, picking, hide/isolate, preset views, skin overlay)
- `data/anatomy-pack.js`: packed BodyParts3D meshes (`window.ANAT_PACK`)
- `data/anatomy-info.js`: study notes per structure (`window.ANAT_INFO`)
- `vendor/three.min.js`: three.js build from 2023 (MIT licence) (licence header is kept in the file)

## Credits and licences

- 3D anatomy meshes: **BodyParts3D**, © The Database Center for Life Science, licensed under [CC BY-SA 2.1 Japan](https://creativecommons.org/licenses/by-sa/2.1/jp/deed.en). Meshes have been simplified and reshaped for this atlas. Any derivative must keep this licence.
- Study notes (origin, insertion, nerve supply, action): checked against **Medical Gross Anatomy muscle tables**, Texas Tech University Health Sciences Center El Paso, <https://anatomy.ttuhscep.edu/anatomytables/muscles_alpha.html>.
- three.js: MIT licence, © 2010-2023 Three.js Authors.
- Typefaces: Newsreader and Instrument Sans via Google Fonts (the page links to them; no font files are bundled).

The on-page footer carries the BodyParts3D credit.
