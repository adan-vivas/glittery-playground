# glittery-playground
This is my personal collection of experiments

The homepage ([index.html](index.html)) is built around the Memory Projector: switch it on and it projects moments
from my life as holograms, with the story behind each crawling across the table. (An interim home: the projector is
meant for the new portfolio.) `projector.html` redirects to it.

To tune the scene, open `/?lab` (or press Shift+L). The scene lab ([scene-lab.js](scene-lab.js)) changes
the camera, light, room and paper physics live, draws debug overlays, and saves fixtures you can copy out as JSON.

## Past homepages

Each earlier homepage is tagged in git and stays live under `archive/`:

- [archive/dither/](archive/dither/): the dithered portrait (tag `homepage-v1-dither`).
- [archive/projector/](archive/projector/): the Temporal Projector, 1996 to 2036 (tag `homepage-v2-projector`).

To retire the current homepage: tag it (`homepage-v2-projector`), move it to `archive/<name>/`, and put the new one at the root.

## Experiments

- [Memory Projector](memory-projector/): a palm-sized personal projector of memories. Depth-video holograms, a story crawl on the table, and an in-browser engine that turns a short clip into a depth-only memory. Blender source, renders and the three.js component.
- [Temporal Projector](temporal-projector/): a speculative Rams-style device that projects 1996, 2006, 2016, 2026 or a plausible future. Cycles renders, Blender source and an interactive three.js component.
