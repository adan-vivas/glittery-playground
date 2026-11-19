# Builds the device with zeitlinse.py, bakes a Cycles contact shadow, exports a web GLB.
# Run:  Blender -b -P export_web.py [-- <out_dir>]   (default: ../assets)
import bpy, os, sys

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.abspath(argv[0] if argv else os.path.join(HERE, "..", "assets"))
os.makedirs(OUT_DIR, exist_ok=True)

os.environ["ZL_NORENDER"] = "1"
src = open(os.path.join(HERE, "zeitlinse.py")).read()
exec(compile(src, "zeitlinse.py", "exec"), {"__name__": "zeitlinse", "__file__": "zeitlinse.py"})

scene = bpy.context.scene
STUDIO = {"plinth", "floor", "projected_date"}
device = [o for o in scene.objects
          if o.type in {"MESH", "FONT"} and o.name not in STUDIO]

# ------------------------------------------------ 1. bake the soft contact shadow
plinth = bpy.data.objects["plinth"]
plinth.is_shadow_catcher = True
plinth.location = (0.0, 0.0, -0.2)      # catcher must cover the whole bake area
plinth.scale = (1.4, 1.4, 0.4)
bpy.data.objects["floor"].hide_render = True
bpy.data.objects["projected_date"].hide_render = True
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
GROUPS = {
    "dial": ["dial_core", "dial_knurl", "dial_crown", "dial_top", "dial_pointer"],
    "prf_key": ["prf_key"],
    "power_button": ["power_button"],
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
    join(gname, [bpy.data.objects.get(n) for n in names])
static = [o for o in scene.objects if o.type == "MESH" and o.name not in GROUPS]
body = join("body", [bpy.data.objects["body"]] + [o for o in static if o.name != "body"])

bpy.ops.export_scene.gltf(
    filepath=os.path.join(OUT_DIR, "zeitlinse.glb"),
    export_format="GLB",
    export_apply=True,
    export_yup=True,
    export_cameras=False,
    export_lights=False,
)
print("EXPORTED", [o.name for o in scene.objects])
