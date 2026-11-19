# Temporal Projector

A speculative palm-sized device in the spirit of Dieter Rams. A dial jumps between
1996, 2006, 2016, 2026 and the future; the orange key, **Plausible Random Futures**,
jumps to the future and projects a plausible one. A small front lens projects the
selected date onto the table, and the lens on top projects a hologram into the air:
a cone of light with a dithered image floating inside it. Power on and it rises out
of the lens; turn the dial or press the key and it dissolves to the next picture.
Without pictures it shows the year. The homepage (`../index.html`) gives it a portrait per era.

![Hero render](renders/zeitlinse_hero.jpg)

## What's here

| Path | What it is |
| --- | --- |
| `index.html` | Demo page for the interactive component |
| `temporal-projector.js` | `<temporal-projector>` web component (three.js) |
| `assets/` | Web model (`zeitlinse.glb`) and the contact shadow baked in Cycles |
| `renders/` | Cycles stills: hero, top, front, dial macro |
| `blender/zeitlinse.py` | Builds the whole device and studio procedurally in Blender 5.x |
| `blender/export_web.py` | Bakes the shadow and exports the GLB into `assets/` |
| `blender/zeitlinse.blend` | The scene, ready to open |

## Run the demo

The page loads ES modules, so serve the folder rather than opening the file:

```bash
python3 -m http.server 4317 --directory temporal-projector
```

Then open <http://localhost:4317>.

## Use the component

```html
<script type="importmap">{"imports":{
  "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}</script>
<script type="module" src="temporal-projector.js"></script>

<temporal-projector date="2026"></temporal-projector>
```

- **Attributes:** `date` (`1996` `2006` `2016` `2026` `FUTURE`), `power` (`on`/`off`), `zoom`, `muted`, `src`, `shadow`,
  `table` (a fixed view down onto a desk, lit from the top left, shadows on the page colour; no orbiting)
- **Table scene:** `setScene({ camera, light, room })` and `getScene()` change the table view live (see `TABLE_SCENE` in the
  source); `tickers` (a Set of functions called each frame), `floorRay(x, y)`, `toScreen(v)`, `keyLight`, `lightDir`
- **Table placement** (CSS custom properties): `--stage-x`, `--stage-y` (where the device sits, as fractions of the element),
  `--stage-scale` (its size, as a fraction of the element's height)
- **Events:** `datechange` → `{ date, projected, label, future }`, `powerchange` → `{ on }`
- **Methods:** `setDate(label)`, `randomFuture()`, `togglePower()`, `setContent({ dates, futures })`,
  `anchor(part)` (screen position of `power`, `key`, `dial`, `lens` or `hologram`), `hologramHit(x, y)`,
  `footprint()` (the device's outline on screen, so things on the page can bump into it)

Give the hologram pictures with `setContent`. Images are URLs (data URLs work). `sheet` plays a
sprite sheet, `mask` cuts out a subject (its green channel), `focus` keeps a point in view, and
`invert: false` makes bright pixels the dots. When `futures` is set, the orange key picks one of them.

```js
el.setContent({
  dates: {
    '2026': { image: 'now.jpg', mask: 'now-mask.png', label: 'Now' },
    '1996': { image: 'sheet.jpg', sheet: [6, 4], fps: 25, label: 'The beginning' },
  },
  futures: [{ year: 2036, image: 'farm.jpg', label: 'A farm' }],
});
```
- **Interaction:** drag or click the dial, press the orange key, press I/O; drag elsewhere to orbit.
  Keyboard: arrows turn the dial, Enter presses the key, P toggles power.

The component sizes itself to its box and has a transparent background, so it sits on any page colour.

## Rebuild from Blender

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b -P blender/zeitlinse.py -- "$PWD/renders/hero.png" hero 1600 2000 1024
```

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b -P blender/export_web.py
```

Cameras: `hero`, `top`, `macro`, `front`. Set `ZL_DATE=1996` (or another date) to change what the dial and projection show.
The labels use Akzidenz-Grotesk from `~/Library/Fonts`; without it, Blender falls back to its default font.
