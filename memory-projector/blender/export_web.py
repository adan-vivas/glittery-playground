# Builds the ZL 3 device with memory_projector.py, bakes a Cycles contact shadow and ambient occlusion,
# and exports the web model: memory-projector.glb, shadow.png, ao.jpg.
# Run:  python3 export_web.py -- <out_dir>        (bpy module)   or   Blender -b -P export_web.py -- <out_dir>
import bpy, math, os, sys

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT_DIR = os.path.abspath(argv[0] if argv else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets"))
os.makedirs(OUT_DIR, exist_ok=True)
HERE = os.path.dirname(os.path.abspath(__file__))

os.environ["ZL_NORENDER"] = "1"
os.environ["ZL_POWER"] = "0"          # knob exported in the OFF position; the page slides it
src = open(os.path.join(HERE, "memory_projector.py")).read()
exec(compile(src, "memory_projector.py", "exec"), {"__name__": "memory_projector", "__file__": "memory_projector.py"})

scene = bpy.context.scene
STUDIO = {"plinth", "floor", "flag_front", "flag_right"}
device = [o for o in scene.objects
          if o.type in {"MESH", "FONT"} and o.name not in STUDIO]

# ------------------------------------------------ 1. bake the soft contact shadow
plinth = bpy.data.objects["plinth"]
plinth.is_shadow_catcher = True
plinth.location = (0.0, 0.0, -0.2)      # catcher must cover the whole bake area
plinth.scale = (1.4, 1.4, 0.4)
bpy.data.objects["floor"].hide_render = True
for o in device:
    o.visible_camera = False
    o.visible_glossy = False

cd = bpy.data.cameras.new("shadow_cam")
cd.type = "ORTHO"
cd.ortho_scale = 0.32
cam = bpy.data.objects.new("shadow_cam", cd)
scene.collection.objects.link(cam)
cam.location = (0.0, 0.0, 0.5)
cam.rotation_euler = (0, 0, 0)
scene.camera = cam
scene.render.film_transparent = True
scene.render.resolution_x = 1024
scene.render.resolution_y = 1024
scene.render.image_settings.color_depth = "8"
scene.render.image_settings.color_mode = "RGBA"
scene.cycles.samples = 512
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"
scene.render.filepath = os.path.join(OUT_DIR, "shadow.png")
bpy.ops.render.render(write_still=True)
# the bright set leaves a faint veil over the whole catcher: lift the floor and fade to clear at the edges
import numpy as np
sh = bpy.data.images.load(scene.render.filepath)
px = np.array(sh.pixels[:], dtype=np.float32).reshape(-1, 4)
n = sh.size[0]
yy, xx = np.mgrid[0:n, 0:n].reshape(2, -1) / (n - 1) * 2 - 1
fade = np.clip((1.0 - np.maximum(np.abs(xx), np.abs(yy))) / 0.35, 0, 1) ** 2
px[:, 3] = np.clip((px[:, 3] - 0.045) / 0.955, 0, 1) * fade
sh.pixels[:] = px.ravel()
sh.save()

# ------------------------------------------------ 2. clean scene down to the device
for o in device:
    o.visible_camera = True
    o.visible_glossy = True
for o in list(scene.objects):
    if o not in device:
        bpy.data.objects.remove(o, do_unlink=True)

dg = bpy.context.evaluated_depsgraph_get()
baked = []
for o in device:
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True,
                                         depsgraph=dg)
    n = bpy.data.objects.new(o.name, me)
    n.matrix_world = o.matrix_world.copy()
    scene.collection.objects.link(n)
    name = o.name
    bpy.data.objects.remove(o, do_unlink=True)
    n.name = name
    baked.append(n)

# ------------------------------------------------ 3. group moving parts, merge the rest
# the parts the page moves or lights, by the names it looks for
GROUPS = {
    "key_back": ["back_key", "back_key_icon"],
    "key_shuffle": ["shuffle_key"] + sorted(o.name for o in baked if o.name.startswith("shuffle_key_icon")),
    "key_next": ["next_key", "next_key_icon"],
    "power_button": ["power_knob"] + sorted(o.name for o in baked if o.name.startswith("power_knob_ridge")),
    "memory_led": ["memory_led"],
    "strap": ["strap", "strap_lug"],
}
moving = {n for names in GROUPS.values() for n in names}


def join(name, objs):
    objs = [o for o in objs if o]
    with bpy.context.temp_override(active_object=objs[0], object=objs[0],
                                   selected_objects=objs, selected_editable_objects=objs):
        bpy.ops.object.join()
    objs[0].name = name
    objs[0].data.name = name
    return objs[0]


for gname, names in GROUPS.items():
    g = join(gname, [bpy.data.objects.get(n) for n in names])
    with bpy.context.temp_override(active_object=g, object=g, selected_objects=[g],
                                   selected_editable_objects=[g]):
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
static = [o for o in scene.objects if o.type == "MESH" and o.name not in GROUPS]
body = join("body", [bpy.data.objects["body"]] + [o for o in static if o.name != "body"])

# ------------------------------------------------ 4. bake ambient occlusion into the body (aoMap for the page)
for o in scene.objects:
    o.select_set(o is body)
bpy.context.view_layer.objects.active = body
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004)
bpy.ops.object.mode_set(mode="OBJECT")
AO_RES = 2048
ao_img = bpy.data.images.new("ao", AO_RES, AO_RES, alpha=False, float_buffer=True)
tmp_nodes = []
for mat in body.data.materials:
    if mat is None:          # empty slot left by a boolean cutter
        continue
    nt = mat.node_tree
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = ao_img
    nt.nodes.active = n
    tmp_nodes.append((nt, n))
for o in scene.objects:
    o.hide_render = o is not body and o.name not in GROUPS
scene.render.engine = "CYCLES"
scene.cycles.samples = 256
scene.render.bake.margin = 8
scene.world.light_settings.distance = 0.012      # AO reach: 12 mm, contact and seams only
bpy.ops.object.bake(type="AO")
for nt, n in tmp_nodes:
    nt.nodes.remove(n)
ao_img.filepath_raw = os.path.join(OUT_DIR, "ao.jpg")
ao_img.file_format = "JPEG"
scene.render.image_settings.quality = 88
ao_img.save()

bpy.ops.export_scene.gltf(
    filepath=os.path.join(OUT_DIR, "memory-projector.glb"),
    export_format="GLB",
    export_apply=True,
    export_yup=True,
    export_cameras=False,
    export_lights=False,
)
print("EXPORTED", [o.name for o in scene.objects])
# where the page should point at each part: the top centre of its bounds, in the page's (y-up) metres
from mathutils import Vector
for name in ("key_back", "key_shuffle", "key_next", "power_button", "memory_led"):
    o = bpy.data.objects[name]
    cs = [o.matrix_world @ Vector(c) for c in o.bound_box]
    x = sum(c.x for c in cs) / 8; y = sum(c.y for c in cs) / 8; z = max(c.z for c in cs)
    print("ANCHOR %-12s THREE.Vector3(%.4f, %.4f, %.4f)" % (name, x, z, -y))
