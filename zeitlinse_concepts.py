# Zeitlinse — five plastic design directions for the temporal projector.
# Reuses the helpers from zeitlinse.py (everything above "the device").
# Run:  ZL_CONCEPT=A Blender -b -P zeitlinse_concepts.py -- <out.png> [hero|front|top] [rx] [ry] [samples]
# Env:  ZL_CONCEPT  A..E   ZL_MIST 1 = fog plume (off by default) above the optic   ZL_DATE year shown in the window
import bpy, bmesh, math, os, sys
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
_src = open(os.path.join(HERE, "zeitlinse.py")).read()
_head = _src.split("# ------------------------------------------------------------------ the device")[0]
exec(compile(_head, "zeitlinse.py", "exec"))

CONCEPT = os.environ.get("ZL_CONCEPT", "A").upper()
MIST = os.environ.get("ZL_MIST", "0") == "1"
# ================================================================== concepts
def concept_A():
    """SOFT BLOCK — pillowy warm-white block; ribbed scroll wheel sunk into the top edge;
    the optic is ringed by a constellation of micro-perforations that breathe the fog."""
    W, D, H, CR, RE = 96.0, 66.0, 30.0, 17.0, 7.5
    Z0 = 1.0 + H
    body = plastic("a_body", "#ece9e2", sss=0.04)
    trim = plastic("a_trim", "#c9cdd2")
    LC, R = (-23.0, 3.0), 14.5
    WC = (25.0, 6.0)
    KC = (25.0, -19.0)
    slot = rr_pts(*WC, 7.2, 22.0, 3.6)
    holes = [circle_pts(*LC, R + 0.3), slot, circle_pts(*KC, 4.7 + 0.45, 72)]
    slab2("body", rr_pts(0, 0, W, D, CR), holes, 1.0, Z0, RE, body, n_round=14)
    foot(W, D, CR)
    optic(*LC, Z0, R, body)
    floor_under("lens_floor", circle_pts(*LC, R + 0.5), Z0 - 9)
    # fog micro-perforations: two staggered rings
    pts = []
    for k, (rad, n) in enumerate(((R + 2.6, 56), (R + 3.7, 64))):
        for i in range(n):
            a = 2 * math.pi * (i + 0.5 * k) / n
            pts.append((rad * math.cos(a), rad * math.sin(a)))
    dots("mist_perf", pts, 0.26, P_GAP, (LC[0], LC[1], Z0 + 0.012))
    # scroll wheel: axis along X, ~3.2 mm proud of the top
    floor_under("wheel_floor", rr_pts(*WC, 7.6, 22.4, 3.8), Z0 - 9)
    wr = 10.5
    o = knurl("wheel", wr, wr - 0.55, -2.8, 2.8, 72, trim, (WC[0], WC[1], Z0 - wr + 3.2), ch=0.35)
    o.rotation_euler = (0, math.pi / 2, 0)
    round_key("shuffle", *KC, Z0, 4.7, P_ORANGE)
    led(WC[0], WC[1] + 15.0, Z0)
    front_window(0.0, -D / 2, 1.0 + H / 2, 30.0, 10.5)
    return W, D, H, LC, R


def concept_B():
    """LANTERN — a vertical, pale tower that projects straight up; a fluted crown on the
    flank sets the year; fog leaves through a hairline annulus around the optic."""
    W, D, H, CR, RE = 62.0, 62.0, 94.0, 21.0, 5.0
    Z0 = 1.0 + H
    body = plastic("b_body", "#e4e6e8", sss=0.03)
    crown = plastic("b_crown", "#b9c0c8")
    LC, R = (0.0, 2.0), 16.5
    KC = (20.0, -20.0)
    holes = [circle_pts(*LC, R + 2.4), circle_pts(*KC, 4.0 + 0.45, 72)]
    slab2("body", rr_pts(0, 0, W, D, CR), holes, 1.0, Z0, RE, body, n_round=12)
    foot(W, D, CR)
    # inner collar leaves a 0.7 mm annular fog slit
    lathe("collar", [(R + 1.7, -10), (R + 1.7, -0.3), (R + 1.3, 0.0), (R, 0.0)], body, (*LC, Z0),
          rad=[0, 0.2, 0, 0])
    floor_under("slit_floor", circle_pts(*LC, R + 2.6), Z0 - 6)
    optic(*LC, Z0, R, body)
    # crown on the right flank, axis along X
    cz = 1.0 + H * 0.70
    lathe("crown_shadow", [(7.6, 0.0), (7.6, 1.2), (0.0, 1.2)], P_GAP, (W / 2 - 1.0, 0.0, cz),
          (0, math.pi / 2, 0))
    o = knurl("crown", 8.2, 7.5, 0.9, 6.6, 30, crown, (W / 2 - 1.0, 0.0, cz), ch=0.5)
    o.rotation_euler = (0, math.pi / 2, 0)
    lathe("crown_face", [(0.0, 6.65), (6.8, 6.65), (7.5, 6.3)], crown, (W / 2 - 1.0, 0.0, cz),
          (0, math.pi / 2, 0), rad=[0, 0.4, 0])
    round_key("shuffle", *KC, Z0, 4.0, P_ORANGE)
    led(-20.0, -20.0, Z0)
    front_window(0.0, -D / 2, 1.0 + H * 0.56, 32.0, 11.0)
    return W, D, H, LC, R


def concept_C():
    """TRACK — a crisp low slab; the year is a short linear slider with detents (no dial);
    a sunburst of micro-slots around the optic releases the fog."""
    W, D, H, CR, RE = 112.0, 64.0, 20.0, 11.0, 3.0
    Z0 = 1.0 + H
    body = plastic("c_body", "#d9d8d3", sss=0.02)
    cap = plastic("c_cap", "#2b2c2e", rough=0.5)
    ink = principled("c_ink", lin("#57585a"), rough=0.8, spec=0.15)
    LC, R = (-31.0, 2.0), 14.0
    T0, T1, TY = 2.0, 46.0, 9.0
    KC = (40.0, -17.0)
    track = rr_pts((T0 + T1) / 2, TY, T1 - T0 + 2.4, 2.4, 1.2)
    holes = [circle_pts(*LC, R + 0.3), track, circle_pts(*KC, 4.2 + 0.45, 72)]
    slab2("body", rr_pts(0, 0, W, D, CR), holes, 1.0, Z0, RE, body, n_round=8)
    foot(W, D, CR)
    optic(*LC, Z0, R, body)
    floor_under("lens_floor", circle_pts(*LC, R + 0.5), Z0 - 9)
    for i in range(36):  # radial fog slots
        a = 2 * math.pi * i / 36
        bar("slot_%02d" % i, (R + 2.0) * math.cos(a), (R + 2.0) * math.sin(a),
            (R + 4.2) * math.cos(a), (R + 4.2) * math.sin(a), 0.42, Z0 + 0.012, P_GAP, (LC[0], LC[1], 0))
    floor_under("track_floor", rr_pts((T0 + T1) / 2, TY, T1 - T0 + 3, 3, 1.5), Z0 - 6)
    years = ["1996", "2006", "2016", "2026", "2036"]
    sel = years.index(DATE) if DATE in years else 3
    for i, y in enumerate(years):
        x = T0 + (T1 - T0) * i / 4
        bar("tick_%d" % i, x, TY - 3.2, x, TY - 4.6, 0.32, Z0 + 0.012, ink)
        text("yr_%d" % i, y if i < 4 else "?", 1.7, (x, TY - 6.8, Z0 + 0.012), fnt=F_ROMAN,
             mat=P_ORANGE if i == 4 else ink, spacing=1.05)
    sx = T0 + (T1 - T0) * sel / 4
    slab2("slider", rr_pts(0, 0, 7.0, 11.0, 3.4), [], -2.0, 3.6, 1.4, cap, (sx, TY, Z0), n_round=8)
    moulded("slider_line", rr_pts(sx, TY, 0.7, 6.0, 0.35), Z0 + 3.6, cap, h=0.15)
    round_key("shuffle", *KC, Z0, 4.2, P_ORANGE)
    led(40.0, 22.0, Z0)
    front_window(0.0, -D / 2, 1.0 + H / 2, 28.0, 9.0, r=1.6)
    return W, D, H, LC, R


def concept_D():
    """GRIP — two-part body: a blue-grey end block whose dot texture is the fog outlet,
    a white optic body; the year steps with a moulded rocker, shuffle is a small tab."""
    W, D, H, CR, RE = 100.0, 60.0, 34.0, 7.0, 4.0
    Z0 = 1.0 + H
    white = plastic("d_white", "#eeeeec", sss=0.04)
    blue = plastic("d_blue", "#8ea1b6", rough=0.5)
    pore = principled("d_pore", lin("#4e5c6b"), rough=0.7, spec=0.2)
    grey = plastic("d_grey", "#c3cad2")
    MX0, MX1 = -50.0, -22.0
    BX0, BX1 = -24.0, 50.0
    RC = ((MX0 + MX1) / 2, 2.0)
    slab2("module", rr_pts(RC[0], 0, MX1 - MX0, D, CR), [rr_pts(*RC, 9.6, 21.0, 4.8)], 1.0, Z0,
          RE, blue, n_round=10)
    LC, R = (12.0, 2.0), 16.0
    KC = (-14.5, -19.5)
    slab2("body", rr_pts((BX0 + BX1) / 2, 0, BX1 - BX0, D, CR),
          [circle_pts(*LC, R + 0.3), rr_pts(*KC, 6.6, 4.6, 2.3)], 1.0, Z0, RE, white, n_round=10)
    foot(W, D, CR)
    optic(*LC, Z0, R, white)
    floor_under("lens_floor", circle_pts(*LC, R + 0.5), Z0 - 9)
    # rocker in an oval pocket
    floor_under("rocker_floor", rr_pts(*RC, 10.0, 21.4, 5.0), Z0 - 5)
    o = slab2("rocker", rr_pts(0, 0, 8.4, 19.8, 4.2), [], -3.0, 1.3, 1.0, grey, (RC[0], RC[1], Z0),
              n_round=8)
    o.rotation_euler = (math.radians(-4), 0, 0)
    chevron("rk_up", RC[0], RC[1] + 5.2, Z0 + 1.65, 1.6, grey, True)
    chevron("rk_dn", RC[0], RC[1] - 5.2, Z0 + 0.95, 1.6, grey, False)
    # pores: front face + left end of the module
    zc = 1.0 + H / 2
    fr = [(x, z) for x in [MX0 + CR + 0.6 + 1.5 * i for i in range(int((MX1 - MX0 - 2 * CR - 1.2) / 1.5) + 1)]
          for z in [-(H / 2 - RE - 1.4) + 1.5 * j for j in range(int((H - 2 * RE - 2.8) / 1.5) + 1)]]
    dots("pores_front", fr, 0.3, pore, (0, -D / 2 - 0.012, zc), (math.pi / 2, 0, 0))
    ld = [(y, z) for y in [-(D / 2 - CR - 0.6) + 1.5 * i for i in range(int((D - 2 * CR - 1.2) / 1.5) + 1)]
          for z in [-(H / 2 - RE - 1.4) + 1.5 * j for j in range(int((H - 2 * RE - 2.8) / 1.5) + 1)]]
    dots("pores_end", ld, 0.3, pore, (MX0 - 0.012, 0, zc), (math.pi / 2, 0, -math.pi / 2))
    # small shuffle tab on the top, at the seam
    floor_under("tab_floor", rr_pts(*KC, 7.0, 5.0, 2.5), Z0 - 3)
    slab2("shuffle", rr_pts(0, 0, 6.0, 4.0, 2.0), [], -2.5, 1.1, 0.6, P_ORANGE, (KC[0], KC[1], Z0),
          n_round=6)
    shuffle_icon("shuffle_icon", KC[0], KC[1], Z0 + 1.1, 1.75, P_ORANGE)
    led(38.0, 21.0, Z0)
    front_window((BX0 + BX1) / 2, -D / 2, zc, 30.0, 11.0)
    return W, D, H, LC, R


def concept_E():
    """PLATTER — monochrome soft square; the top is a flush turning platter with a finger
    dimple (the date control), optic at its centre; fog escapes through the platter's seam."""
    W, D, H, CR, RE = 90.0, 90.0, 26.0, 30.0, 5.5
    Z0 = 1.0 + H
    body = plastic("e_body", "#ebecee", sss=0.04)
    plat = plastic("e_plat", "#e3e4e7", rough=0.38, sss=0.03)
    ink = principled("e_ink", lin("#9a9da2"), rough=0.8, spec=0.15)
    PR, R = 35.0, 12.5
    KC = (29.5, -29.5)
    slab2("body", rr_pts(0, 0, W, D, CR), [circle_pts(0, 0, PR + 0.45, 220), circle_pts(*KC, 3.4 + 0.4, 64)],
          1.0, Z0, RE, body, n_round=12)
    foot(W, D, CR)
    floor_under("seam_floor", circle_pts(0, 0, PR + 1.0, 220), Z0 - 3.4)
    da = math.radians(35)
    DC = (24.5 * math.cos(da), 24.5 * math.sin(da))
    slab2("platter", circle_pts(0, 0, PR, 220),
          [circle_pts(0, 0, R + 0.3), circle_pts(DC[0], DC[1], 5.2, 96)], -3.0, -0.08, 0.5, plat,
          (0, 0, Z0), re_hole=0.45, n_round=6)
    # finger dimple: shallow spherical cup
    cup = [(0.0, -1.1)]
    for i in range(1, 17):
        r = 5.2 * i / 16
        cup.append((r, -1.1 + 1.0 * (r / 5.2) ** 2))
    cup.append((5.2, -3.0))
    lathe("dimple", cup, plat, (DC[0], DC[1], Z0), segs=96)
    optic(0.0, 0.0, Z0 - 0.08, R, plat)
    # five small ticks for the eras, on the fixed rim
    for i, ang in enumerate((120, 95, 70, 45, 20)):
        a = math.radians(ang)
        bar("tick_%d" % i, (PR + 2.4) * math.cos(a), (PR + 2.4) * math.sin(a),
            (PR + 3.9) * math.cos(a), (PR + 3.9) * math.sin(a), 0.35, Z0 + 0.012,
            P_ORANGE if i == 4 else ink)
    round_key("shuffle", *KC, Z0, 3.4, P_ORANGE, h=0.7)
    led(-29.5, -29.5, Z0)
    front_window(0.0, -D / 2, 1.0 + H / 2, 30.0, 10.0)
    return W, D, H, (0.0, 0.0), R


W, D, H, LC, R = {"A": concept_A, "B": concept_B, "C": concept_C, "D": concept_D,
                  "E": concept_E}[CONCEPT]()
if MIST:
    mist_plume(LC[0], LC[1], 1.0 + H + 0.5, R * 2.2, max(70.0, H * 1.2))

# ----------------------------------------------------------------- studio
bpy.ops.mesh.primitive_cube_add(size=1)
pl = bpy.context.active_object
pl.name = "plinth"
pl.scale = (0.62, 0.62, 0.40)
pl.location = (-0.10 + 0.31, -0.125 + 0.31, -0.20)
pl.data.materials.append(M_PLINTH)
bv = pl.modifiers.new("bevel", "BEVEL")
bv.width = 0.0015
bv.segments = 4
bpy.ops.object.shade_smooth()
bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0, -0.40))
bpy.context.active_object.data.materials.append(M_PLINTH)

world = bpy.data.worlds.new("studio")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.62, 0.63, 0.65, 1)
bg.inputs["Strength"].default_value = 0.10


def area(name, loc, target, size, size_y, energy, color=(1, 1, 1)):
    ld = bpy.data.lights.new(name, "AREA")
    ld.shape = "RECTANGLE"
    ld.size, ld.size_y, ld.energy, ld.color = size, size_y, energy, color
    ob = link(bpy.data.objects.new(name, ld))
    ob.location = loc
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()


area("key", (-0.55, -0.30, 0.60), (0, 0, 0.01), 0.55, 0.55, 9, (1.0, 0.985, 0.96))
area("top_back", (0.10, 0.60, 0.55), (0, 0, 0.01), 1.4, 0.6, 7, (0.97, 0.98, 1.0))
area("fill", (0.65, -0.35, 0.22), (0, 0, 0.01), 0.7, 0.5, 2.2)
area("kicker", (0.45, 0.35, 0.10), (0, 0, 0.012), 0.3, 0.15, 1.0)


def camera(name, direction, target, dist, lens, fstop):
    cd = bpy.data.cameras.new(name)
    cd.lens, cd.sensor_width, cd.clip_start = lens, 36, 0.01
    cd.dof.use_dof = True
    cd.dof.aperture_fstop = fstop
    cd.dof.aperture_blades = 7
    ob = link(bpy.data.objects.new(name, cd))
    t = Vector(target)
    ob.location = t + Vector(direction).normalized() * dist
    ob.rotation_euler = (t - ob.location).to_track_quat("-Z", "Y").to_euler()
    f = link(bpy.data.objects.new(name + "_focus", None))
    f.location = t + Vector((0, -D / 2 * MM * 0.5, 0))
    cd.dof.focus_object = f
    return ob


size = max(W, D * 1.1, (H + (40 if MIST else 0)) * 1.15) * MM
tz = (H * 0.5 + (16 if MIST else 0)) * MM
cams = {
    "hero": camera("hero", (0.221 if CONCEPT == "B" else -0.221, -0.382, 0.245), (0.0, -0.006, tz), size * 3.7, 100, 7.1),
    "front": camera("front", (0.12, -1.0, 0.16), (0.0, 0.0, H * 0.5 * MM), size * 3.6, 100, 9),
    "top": camera("top", (0.0, -0.35, 1.0), (0.0, 0.0, H * MM), size * 3.5, 100, 11),
}
scene.camera = cams.get(CAM, cams["hero"])

scene.render.engine = "CYCLES"
cy = scene.cycles
prefs = bpy.context.preferences.addons["cycles"].preferences
try:
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == "METAL"
    cy.device = "GPU"
except Exception as e:
    print("GPU unavailable:", e)
cy.samples = SAMPLES
cy.use_adaptive_sampling = True
cy.adaptive_threshold = 0.015
cy.max_bounces = 12
cy.transmission_bounces = 12
cy.transparent_max_bounces = 16
cy.volume_bounces = 1
cy.sample_clamp_indirect = 8
cy.blur_glossy = 0.5
cy.use_denoising = True
scene.render.resolution_x = RX
scene.render.resolution_y = RY
scene.render.image_settings.file_format = "PNG"
scene.view_settings.view_transform = "AgX"
try:
    scene.view_settings.look = "AgX - Medium High Contrast"
except Exception:
    pass
scene.view_settings.exposure = float(os.environ.get("ZL_EXPOSURE", "0.0"))
scene.render.filepath = OUT
if os.environ.get("ZL_SAVE"):
    bpy.ops.wm.save_as_mainfile(filepath=os.environ["ZL_SAVE"])
if not os.environ.get("ZL_NORENDER"):
    bpy.ops.render.render(write_still=True)
