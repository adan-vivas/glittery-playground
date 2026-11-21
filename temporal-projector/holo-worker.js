// Builds the hologram's subjects off the main thread, so the page never stalls while dots are sculpted.
import { SCENES } from './holo-scenes.js?v=14';

onmessage = async ({ data: { key, entry } }) => {
  try {
    const d = await SCENES[key].build(entry);
    postMessage({ key, d }, [d.pos.buffer, d.nrm.buffer, d.skin.buffer, d.mat.buffer]);   // d.fit travels as a plain array
  } catch (err) {
    postMessage({ key, error: String(err && err.message || err) });
  }
};
