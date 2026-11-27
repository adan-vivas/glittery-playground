# glittery-playground
This is my personal collection of experiments

The homepage ([index.html](index.html)) is built around the Temporal Projector: switch it on and it projects
a portrait from each era, from 1996 to three plausible 2036s. `projector.html` redirects to it.

To tune the scene, open `/?lab` (or press Shift+L). The scene lab ([scene-lab.js](scene-lab.js)) changes
the camera, light, room and paper physics live, draws debug overlays, and saves fixtures you can copy out as JSON.

## Past homepages

Each earlier homepage is tagged in git and stays live under `archive/`:

- [archive/dither/](archive/dither/): the dithered portrait (tag `homepage-v1-dither`).

To retire the current homepage: tag it (`homepage-v2-projector`), move it to `archive/<name>/`, and put the new one at the root.

## Experiments

- [Memory Projector](memory-projector/) (its own page, `/memory-projector/`): a palm-sized personal projector of memories. Depth-video holograms, a story crawl on the table, and an in-browser engine that turns a short clip into a depth-only memory. Blender source, renders and the three.js component.
- [Temporal Projector](temporal-projector/): a speculative Rams-style device that projects 1996, 2006, 2016, 2026 or a plausible future. Cycles renders, Blender source and an interactive three.js component.
