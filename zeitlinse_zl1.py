# Zeitlinse ZL 1 — speculative temporal projector.
# Procedural model + studio for Blender 5.x / Cycles (Metal GPU).
# Run:  Blender -b -P zeitlinse.py -- <out.png> [camera] [res_x] [res_y] [samples]
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix
from mathutils.geometry import tessellate_polygon

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if len(argv) > 0 else "/tmp/zeitlinse.png"
CAM = argv[1] if len(argv) > 1 else "hero"
RX = int(argv[2]) if len(argv) > 2 else 800
RY = int(argv[3]) if len(argv) > 3 else 1000
SAMPLES = int(argv[4]) if len(argv) > 4 else 64
DATE = os.environ.get("ZL_DATE", "2026")

MM = 0.001
FONTS = os.path.expanduser("~/Library/Fonts")
SM = Matrix.Scale(MM, 4)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def font(name):
    p = os.path.join(FONTS, name)
    return bpy.data.fonts.load(p) if os.path.exists(p) else None


F_ROMAN = font("Akzidenz-grotesk-roman.ttf")
F_BOLD = font("Akzidenz-grotesk-bold.ttf")
F_LIGHT = font("Akzidenz-grotesk-light.ttf")


# ----------------------------------------------------------------- materials
def nodes_for(mat):
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    return nt, out


def principled(name, color, metallic=0.0, rough=0.5, spec=0.5, aniso=0.0,
               clearcoat=0.0, grain=0.0, rough_var=0.0, radial=False, sss=0.0):
    mat = bpy.data.materials.new(name)
    nt, out = nodes_for(mat)
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Specular IOR Level"].default_value = spec
    b.inputs["Roughness"].default_value = rough
    b.inputs["Anisotropic"].default_value = aniso
    b.inputs["Coat Weight"].default_value = clearcoat
    if sss:
        b.inputs["Subsurface Weight"].default_value = sss
        b.inputs["Subsurface Radius"].default_value = (1.0, 0.35, 0.2)
        b.inputs["Subsurface Scale"].default_value = 0.0015
    tc = nt.nodes.new("ShaderNodeTexCoord")
    if grain:
        nz = nt.nodes.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = 9000
        nz.inputs["Detail"].default_value = 2
        nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
        bp = nt.nodes.new("ShaderNodeBump")
        bp.inputs["Strength"].default_value = grain
        bp.inputs["Distance"].default_value = 0.00002
        nt.links.new(nz.outputs["Fac"], bp.inputs["Height"])
        nt.links.new(bp.outputs["Normal"], b.inputs["Normal"])
    if rough_var:
        nz2 = nt.nodes.new("ShaderNodeTexNoise")
        nz2.inputs["Scale"].default_value = 60
        nz2.inputs["Detail"].default_value = 3
        nt.links.new(tc.outputs["Object"], nz2.inputs["Vector"])
        mr = nt.nodes.new("ShaderNodeMapRange")
        mr.inputs["To Min"].default_value = rough - rough_var
        mr.inputs["To Max"].default_value = rough + rough_var
        nt.links.new(nz2.outputs["Fac"], mr.inputs["Value"])
        nt.links.new(mr.outputs["Result"], b.inputs["Roughness"])
    if radial:
        tg = nt.nodes.new("ShaderNodeTangent")
        tg.direction_type = "RADIAL"
        tg.axis = "Z"
        nt.links.new(tg.outputs["Tangent"], b.inputs["Tangent"])
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
    return mat


def emissive(name, color, strength, alpha=1.0):
    mat = bpy.data.materials.new(name)
    nt, out = nodes_for(mat)
    e = nt.nodes.new("ShaderNodeEmission")
    e.inputs["Color"].default_value = (*color, 1)
    e.inputs["Strength"].default_value = strength
    if alpha < 1.0:
        tr = nt.nodes.new("ShaderNodeBsdfTransparent")
        ad = nt.nodes.new("ShaderNodeAddShader")
        mx = nt.nodes.new("ShaderNodeMixShader")
        mx.inputs["Fac"].default_value = alpha
        nt.links.new(tr.outputs[0], mx.inputs[1])
        nt.links.new(e.outputs[0], mx.inputs[2])
        nt.links.new(mx.outputs[0], ad.inputs[0])
        nt.links.new(tr.outputs[0], ad.inputs[1])
        # additive glow over whatever is underneath
        nt.links.new(e.outputs[0], ad.inputs[0])
        nt.links.new(ad.outputs[0], out.inputs["Surface"])
    else:
        nt.links.new(e.outputs[0], out.inputs["Surface"])
    return mat


def projected_light(name, color, strength):
    """Additive light on a surface: transparent + emission (reads as projected light)."""
    mat = bpy.data.materials.new(name)
    nt, out = nodes_for(mat)
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    e = nt.nodes.new("ShaderNodeEmission")
    e.inputs["Color"].default_value = (*color, 1)
    e.inputs["Strength"].default_value = strength
    ad = nt.nodes.new("ShaderNodeAddShader")
    nt.links.new(tr.outputs[0], ad.inputs[0])
    nt.links.new(e.outputs[0], ad.inputs[1])
    # only the camera sees the glow; keeps it from lighting the scene oddly
    lp = nt.nodes.new("ShaderNodeLightPath")
    mx = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lp.outputs["Is Camera Ray"], mx.inputs["Fac"])
    nt.links.new(tr.outputs[0], mx.inputs[1])
    nt.links.new(ad.outputs[0], mx.inputs[2])
    nt.links.new(mx.outputs[0], out.inputs["Surface"])
    return mat


def coated_glass(name, film=370.0):
    """Optical glass with a physical thin-film anti-reflection coating."""
    mat = bpy.data.materials.new(name)
    nt, out = nodes_for(mat)
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    b.inputs["Base Color"].default_value = (0.97, 0.98, 0.99, 1)
    b.inputs["Roughness"].default_value = 0.0
    b.inputs["IOR"].default_value = 1.52
    b.inputs["Transmission Weight"].default_value = 1.0
    b.inputs["Thin Film Thickness"].default_value = film
    b.inputs["Thin Film IOR"].default_value = 1.38
    b.inputs["Transmission Dispersion Abbe Number"].default_value = 55
    b.inputs["Transmission Dispersion Scale"].default_value = 1.0
    nt.links.new(b.outputs[0], out.inputs["Surface"])
    return mat


M_ALU = principled("alu_beadblast", (0.70, 0.70, 0.71), metallic=1, rough=0.32,
                   grain=0.12, rough_var=0.03)
M_ALU_POL = principled("alu_polished", (0.90, 0.90, 0.91), metallic=1, rough=0.07)
M_ALU_MACH = principled("alu_machined", (0.86, 0.86, 0.87), metallic=1, rough=0.16,
                        aniso=0.75, radial=True)
M_KNURL = principled("alu_knurl", (0.82, 0.82, 0.83), metallic=1, rough=0.24)
M_BLACK_ANO = principled("black_anodized", (0.018, 0.018, 0.02), metallic=1, rough=0.32,
                         grain=0.05)
M_BLACK_GLOSS = principled("black_gloss", (0.01, 0.01, 0.01), metallic=0.6, rough=0.14)
M_BLACK_MATTE = principled("black_matte", (0.004, 0.004, 0.004), rough=0.9, spec=0.1)
M_BASE = principled("base_graphite", (0.05, 0.05, 0.055), metallic=1, rough=0.45)
M_ORANGE = principled("signal_orange", (1.0, 0.045, 0.004), rough=0.30, spec=0.45,
                      sss=0.08, grain=0.03)
M_INK = principled("ink_graphite", (0.008, 0.008, 0.009), rough=0.8, spec=0.15)
M_INK_WHITE = principled("ink_white", (0.75, 0.75, 0.74), rough=0.8, spec=0.15)
M_INK_ORANGE = principled("ink_orange", (1.0, 0.04, 0.004), rough=0.8, spec=0.15)
M_LED = emissive("led_green", (0.15, 1.0, 0.25), 18)
M_GLASS = coated_glass("coated_glass")
M_GLOW_CORE = emissive("projector_core", (0.35, 0.55, 1.0), 2.5)
M_GLOW_FRONT = emissive("front_core", (1.0, 0.78, 0.5), 6)
M_PLINTH = principled("plinth", (0.56, 0.56, 0.57), rough=0.82, spec=0.3)
M_PROJ = projected_light("projected_date", (1.0, 0.86, 0.66), 0.75)


# ------------------------------------------------------------------- helpers
def link(obj):
    scene.collection.objects.link(obj)
    return obj


def to_obj(name, bm, mat, loc=(0, 0, 0), rot=None, smooth=True, angle=32, weighted=False):
    bm.transform(SM)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
        me.set_sharp_from_angle(angle=math.radians(angle))
    if mat:
        me.materials.append(mat)
    obj = link(bpy.data.objects.new(name, me))
    obj.location = Vector(loc) * MM
    if rot:
        obj.rotation_euler = rot
    if weighted:
        m = obj.modifiers.new("wn", "WEIGHTED_NORMAL")
        m.keep_sharp = True
        m.weight = 100
    return obj


def dedupe(pts, eps=1e-6):
    out = []
    for p in pts:
        if not out or (Vector(p) - Vector(out[-1])).length > eps:
            out.append(p)
    if (Vector(out[0]) - Vector(out[-1])).length <= eps:
        out.pop()
    return out


def rr_pts(cx, cy, w, h, r, n=18):
    r = min(r, w / 2, h / 2)
    pts = []
    for (x, y, a0) in [(cx + w / 2 - r, cy + h / 2 - r, 0), (cx - w / 2 + r, cy + h / 2 - r, 90),
                       (cx - w / 2 + r, cy - h / 2 + r, 180), (cx + w / 2 - r, cy - h / 2 + r, 270)]:
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((x + r * math.cos(a), y + r * math.sin(a)))
    return dedupe(pts)


def circle_pts(cx, cy, r, n=144):
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n))
            for i in range(n)]


def loop_normals(pts):
    n = len(pts)
    out = []
    for i in range(n):
        p0, p1, p2 = Vector(pts[i - 1]), Vector(pts[i]), Vector(pts[(i + 1) % n])
        e1 = (p1 - p0).normalized()
        e2 = (p2 - p1).normalized()
        n1 = Vector((e1.y, -e1.x))
        n2 = Vector((e2.y, -e2.x))
        nn = (n1 + n2).normalized()
        out.append(nn / max(nn.dot(n1), 0.5))
    return out


def slab(name, outer, holes, z0, z1, re, mat, loc=(0, 0, 0), n_round=7):
    """Solid plate from an outer CCW loop with holes, all edges rounded by `re`."""
    loops = [outer] + [list(reversed(h)) for h in holes]
    prof = []
    if re > 0:
        for i in range(n_round + 1):
            a = math.pi / 2 * i / n_round
            prof.append((-re + re * math.sin(a), z1 - re + re * math.cos(a)))
        for i in range(n_round + 1):
            a = math.pi / 2 * i / n_round
            prof.append((-re + re * math.cos(a), z0 + re - re * math.sin(a)))
    else:
        prof = [(0, z1), (0, z0)]
    bm = bmesh.new()
    tops, bots = [], []
    for L in loops:
        nrm = loop_normals(L)
        rings = []
        for (o, z) in prof:
            rings.append([bm.verts.new((p[0] + nv.x * o, p[1] + nv.y * o, z)) for p, nv in zip(L, nrm)])
        n = len(L)
        for k in range(len(rings) - 1):
            a, b = rings[k], rings[k + 1]
            for i in range(n):
                j = (i + 1) % n
                try:
                    bm.faces.new((a[i], a[j], b[j], b[i]))
                except ValueError:
                    pass
        tops.append(rings[0])
        bots.append(rings[-1])
    for caps in (tops, bots):
        flat = [v for ring in caps for v in ring]
        tris = tessellate_polygon([[v.co.copy() for v in ring] for ring in caps])
        for t in tris:
            try:
                bm.faces.new((flat[t[0]], flat[t[1]], flat[t[2]]))
            except ValueError:
                pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return to_obj(name, bm, mat, loc, weighted=True)


def fillet(pts, rad, n=6):
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        R = rad[i] if i < len(rad) else 0
        if R <= 0:
            out.append(pts[i])
            continue
        p = Vector(pts[i])
        a = (Vector(pts[i - 1]) - p).normalized()
        b = (Vector(pts[i + 1]) - p).normalized()
        ang = math.acos(max(-1.0, min(1.0, a.dot(b))))
        if ang < 1e-3 or abs(ang - math.pi) < 1e-3:
            out.append(pts[i])
            continue
        d = R / math.tan(ang / 2)
        c = p + (a + b).normalized() * (R / math.sin(ang / 2))
        v1 = p + a * d - c
        v2 = p + b * d - c
        a1 = math.atan2(v1.y, v1.x)
        a2 = math.atan2(v2.y, v2.x)
        da = a2 - a1
        while da > math.pi:
            da -= 2 * math.pi
        while da < -math.pi:
            da += 2 * math.pi
        for k in range(n + 1):
            t = a1 + da * k / n
            out.append((c.x + R * math.cos(t), c.y + R * math.sin(t)))
    out.append(pts[-1])
    return out


def lathe(name, prof, mat, loc=(0, 0, 0), rot=None, segs=160, angle=32, rad=None, n=6):
    if rad:
        prof = fillet(prof, rad, n)
    bm = bmesh.new()
    vs = [bm.verts.new((r, 0, z)) for r, z in prof]
    es = [bm.edges.new((vs[i], vs[i + 1])) for i in range(len(vs) - 1)]
    bmesh.ops.spin(bm, geom=vs + es, cent=(0, 0, 0), axis=(0, 0, 1),
                   angle=2 * math.pi, steps=segs, use_duplicate=False)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return to_obj(name, bm, mat, loc, rot, angle=angle)


def knurl(name, r_out, r_in, z0, z1, teeth, mat, loc, ch=0.25):
    prof = []
    for i in range(teeth):
        for f, r in ((0.0, r_out), (0.25, r_out), (0.5, r_in), (0.75, r_in)):
            a = 2 * math.pi * (i + f) / teeth
            prof.append((math.cos(a), math.sin(a), r))
    bm = bmesh.new()
    rings = []
    for (z, shrink) in ((z0, True), (z0 + ch, False), (z1 - ch, False), (z1, True)):
        ring = []
        for (cx, sy, r) in prof:
            rr = (r_in - ch * 0.6) if shrink else r
            ring.append(bm.verts.new((cx * rr, sy * rr, z)))
        rings.append(ring)
    n = len(prof)
    for k in range(3):
        a, b = rings[k], rings[k + 1]
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))
    bm.faces.new(rings[0])
    bm.faces.new(list(reversed(rings[3])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return to_obj(name, bm, mat, loc, angle=35)


def flat_poly(name, pts, z, mat, loc=(0, 0, 0), rot=None):
    bm = bmesh.new()
    vs = [bm.verts.new((x, y, z)) for x, y in pts]
    bm.faces.new(vs)
    return to_obj(name, bm, mat, loc, rot, smooth=False)


def text(name, body, size, loc, rot=(0, 0, 0), fnt=None, align="CENTER", valign="CENTER",
         mat=None, spacing=1.0):
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = body
    cu.size = size * MM
    if fnt or F_ROMAN:
        cu.font = fnt or F_ROMAN
    cu.align_x = align
    cu.align_y = valign
    cu.space_character = spacing
    obj = link(bpy.data.objects.new(name, cu))
    obj.location = Vector(loc) * MM
    obj.rotation_euler = rot
    cu.materials.append(mat or M_INK)
    return obj


def bar(name, x0, y0, x1, y1, w, z, mat, loc=(0, 0, 0)):
    d = Vector((x1 - x0, y1 - y0)).normalized()
    nrm = Vector((-d.y, d.x)) * (w / 2)
    pts = [(x0 + nrm.x, y0 + nrm.y), (x0 - nrm.x, y0 - nrm.y),
           (x1 - nrm.x, y1 - nrm.y), (x1 + nrm.x, y1 + nrm.y)]
    # rounded ends: approximate with a stadium
    c0, c1 = Vector((x0, y0)), Vector((x1, y1))
    ang = math.atan2(d.y, d.x)
    pts = []
    for i in range(9):
        a = ang + math.pi / 2 + math.pi * i / 8
        pts.append((c0.x + w / 2 * math.cos(a), c0.y + w / 2 * math.sin(a)))
    for i in range(9):
        a = ang - math.pi / 2 + math.pi * i / 8
        pts.append((c1.x + w / 2 * math.cos(a), c1.y + w / 2 * math.sin(a)))
    return flat_poly(name, pts, z, mat, loc)


# ------------------------------------------------------------------ the device
W, D, H = 104.0, 70.0, 24.0
CR = 14.0          # plan corner radius
RE = 1.25          # edge round
ZB = 2.0           # body bottom (sits on graphite base plate)
Z0 = ZB + H        # top surface

LENS_C = (-26.0, 2.0)
LENS_R = 19.0
DIAL_C = (25.0, 7.5)
PWR_C = (4.0, 26.5)
LED_C = (10.0, 26.5)
KEY_C = (24.0, -22.5)
KEY_W, KEY_H = 34.0, 8.6

holes = [
    circle_pts(*LENS_C, LENS_R + 0.35),
    rr_pts(*KEY_C, KEY_W + 0.8, KEY_H + 0.8, (KEY_H + 0.8) / 2),
    circle_pts(*PWR_C, 3.35, 72),
]
slab("body", rr_pts(0, 0, W, D, CR), holes, ZB, Z0, RE, M_ALU)
slab("base_plate", rr_pts(0, 0, W - 3.2, D - 3.2, CR - 1.6), [], 0.0, ZB + 0.6, 0.35, M_BASE)

# hole floors (block view into the body)
slab("lens_floor", circle_pts(*LENS_C, LENS_R + 0.5), [], Z0 - 14, Z0 - 13, 0, M_BLACK_MATTE)
slab("key_floor", rr_pts(*KEY_C, KEY_W + 1.2, KEY_H + 1.2, 5), [], Z0 - 5, Z0 - 4.5, 0, M_BLACK_MATTE)
slab("pwr_floor", circle_pts(*PWR_C, 3.6, 48), [], Z0 - 5, Z0 - 4.5, 0, M_BLACK_MATTE)

# --- projection optic (top)
lx, ly = LENS_C
L = (lx, ly, Z0)
lathe("lens_bezel", [(LENS_R, -8.0), (LENS_R, -0.45), (17.1, -0.45)], M_ALU, L, rad=[0, 0.35, 0])
lathe("lens_bezel_chamfer", [(17.1, -0.45), (16.0, -1.55), (16.0, -2.1)], M_ALU_POL, L,
      rad=[0, 0.15, 0])
lathe("lens_barrel_ring", [(16.0, -2.1), (12.7, -2.1), (12.7, -2.45)], M_BLACK_ANO, L)
lathe("lens_retainer",
      [(12.7, -2.45), (12.25, -2.45), (12.25, -2.3), (11.9, -2.3), (11.9, -2.65), (11.55, -2.65),
       (11.55, -2.5), (11.25, -2.5), (11.25, -3.3), (11.05, -3.3), (11.05, -9.0)],
      M_BLACK_GLOSS, L, angle=20)
# front element: plano-convex, sag 0.75 mm
R_SPH = (11.0 ** 2 + 0.75 ** 2) / (2 * 0.75)
glass = [(0.0, -2.75)]
for i in range(1, 25):
    r = 11.0 * i / 24
    glass.append((r, -2.75 - (R_SPH - math.sqrt(R_SPH ** 2 - r * r))))
glass += [(11.0, -5.2), (0.0, -5.2)]
lathe("lens_front_element", glass, M_GLASS, L, angle=40)
# inner aperture plate with hexagonal iris
hexa = [(4.2 * math.cos(math.radians(30 + 60 * i)), 4.2 * math.sin(math.radians(30 + 60 * i)))
        for i in range(6)]
slab("iris", circle_pts(0, 0, 11.0, 96), [list(reversed(hexa))[::-1]], -6.6, -6.3, 0.0,
     M_BLACK_ANO, (lx, ly, Z0))
for i in range(6):  # iris blade seams
    a = math.radians(30 + 60 * i)
    bar("iris_seam_%d" % i, 4.2 * math.cos(a), 4.2 * math.sin(a),
        10.8 * math.cos(a + 0.55), 10.8 * math.sin(a + 0.55), 0.08, -6.29, M_BLACK_MATTE, L)
# rear element + glowing emitter
rear = [(0.0, -7.6)]
for i in range(1, 17):
    r = 6.5 * i / 16
    rear.append((r, -7.6 - 0.9 * (r / 6.5) ** 2))
rear += [(6.5, -9.0), (0.0, -9.0)]
lathe("lens_rear_element", rear, M_GLASS, L, angle=40)
lathe("emitter", [(0.0, -11.5), (2.2, -11.5)], M_GLOW_CORE, L)
lathe("cavity", [(11.05, -9.0), (11.05, -12.0), (0.0, -12.0)], M_BLACK_MATTE, L)

# lens ring engraving (white, around the black barrel)
ring_txt = "OPTIK  1:1.4  f = 14 mm   ·   TEMPORAL PROJECTION   ·   No 0001"
rr = 14.35
tsize = 0.95
adv = {" ": 0.30, "1": 0.55, ":": 0.28, ".": 0.28, "·": 0.35, "=": 0.6, "I": 0.3}
total = sum(adv.get(ch, 0.66) for ch in ring_txt) * tsize
start = -math.pi / 2 - (total / rr) / 2  # centred at the front, reads left-to-right
s = 0.0
for k, ch in enumerate(ring_txt):
    w = adv.get(ch, 0.66) * tsize
    if ch != " ":
        a = start + (s + w / 2) / rr
        text("ring_%02d" % k, ch, tsize,
             (lx + rr * math.cos(a), ly + rr * math.sin(a), Z0 - 2.085),
             (0, 0, a + math.pi / 2), F_ROMAN, mat=M_INK_WHITE)
    s += w
# index dot on bezel (alignment mark)
lathe("lens_index", [(0.0, 0.0), (0.45, 0.0)], M_INK_ORANGE, (lx, ly - 15.55 + 0.0, Z0 - 0.44))
bpy.data.objects["lens_index"].location = Vector((lx, ly - 18.05, Z0 - 0.435)) * MM

# --- date dial
dx, dy = DIAL_C
DZ = Z0
lathe("dial_core", [(0.0, 0.45), (9.9, 0.45), (9.9, 6.2)], M_KNURL, (dx, dy, DZ), rad=[0, 0.2, 0])
knurl("dial_knurl", 10.55, 10.2, 1.0, 5.6, 84, M_KNURL, (dx, dy, DZ))
lathe("dial_crown", [(10.2, 5.55), (10.35, 5.75), (10.35, 6.7), (9.55, 7.5), (8.9, 7.5)],
      M_ALU_POL, (dx, dy, DZ), rad=[0, 0, 0.12, 0.12, 0], angle=40)
lathe("dial_top", [(8.9, 7.5), (0.0, 7.5)], M_ALU_MACH, (dx, dy, DZ))
lathe("dial_shadow_washer", [(9.6, 0.0), (9.6, 0.45), (0.0, 0.45)], M_BLACK_MATTE, (dx, dy, DZ))

DATES = [("1996", 210), ("2006", 150), ("2016", 90), ("2026", 30), ("FUTURE", -30)]
sel_angle = dict(DATES).get(DATE, 30)
# pointer on the dial top, aimed at the selected date
a = math.radians(sel_angle)
bar("dial_pointer", 3.6 * math.cos(a), 3.6 * math.sin(a), 8.2 * math.cos(a), 8.2 * math.sin(a),
    0.85, 7.515, M_INK_ORANGE, (dx, dy, DZ))
# scale: major ticks, minor dots, labels
for label, ang in DATES:
    a = math.radians(ang)
    fut = label == "FUTURE"
    bar("tick_" + label, 12.6 * math.cos(a), 12.6 * math.sin(a), 14.6 * math.cos(a),
        14.6 * math.sin(a), 0.42, 0.012, M_INK_ORANGE if fut else M_INK, (dx, dy, DZ))
    lr = 17.0
    px, py = dx + lr * math.cos(a), dy + lr * math.sin(a)
    if abs(math.cos(a)) < 0.2:
        al = "CENTER"
    elif math.cos(a) > 0:
        al = "LEFT"
        px -= 1.4
    else:
        al = "RIGHT"
        px += 1.4
    text("lbl_" + label, label, 2.35 if not fut else 1.95, (px, py, DZ + 0.012), fnt=F_BOLD if fut else F_ROMAN,
         align=al, mat=M_INK_ORANGE if fut else M_INK, spacing=1.05 if not fut else 1.15)
for ang in range(-30, 211, 10):
    if ang % 60 == 30:
        continue
    a = math.radians(ang)
    lathe("dot_%d" % ang, [(0.0, 0.0), (0.2, 0.0)], M_INK,
          (dx + 13.6 * math.cos(a), dy + 13.6 * math.sin(a), DZ + 0.012), segs=16)
text("lbl_dial", "ZEIT", 1.25, (dx + 0.0, dy - 14.2, DZ + 0.012), fnt=F_BOLD, spacing=1.6)

# --- Plausible Random Futures key
kx, ky = KEY_C
slab("prf_key", rr_pts(0, 0, KEY_W, KEY_H, KEY_H / 2), [], -4.0, 0.75, 0.7, M_ORANGE,
     (kx, ky, Z0))
text("lbl_prf", "PLAUSIBLE RANDOM FUTURES", 1.45, (kx - KEY_W / 2 + 0.6, ky + KEY_H / 2 + 2.6,
     Z0 + 0.012), fnt=F_ROMAN, align="LEFT", spacing=1.1)
bar("prf_arrow", kx + KEY_W / 2 - 4.0, ky + KEY_H / 2 + 2.55, kx + KEY_W / 2 - 0.6,
    ky + KEY_H / 2 + 2.55, 0.32, Z0 + 0.012, M_INK_ORANGE)
flat_poly("prf_arrowhead", [(kx + KEY_W / 2 - 0.2, ky + KEY_H / 2 + 2.55),
                            (kx + KEY_W / 2 - 1.3, ky + KEY_H / 2 + 3.25),
                            (kx + KEY_W / 2 - 1.3, ky + KEY_H / 2 + 1.85)], Z0 + 0.013,
          M_INK_ORANGE)

# --- power button + LED
px_, py_ = PWR_C
lathe("power_button", [(0.0, 0.55), (2.9, 0.55), (2.9, -4.0)], M_ALU_MACH, (px_, py_, Z0),
      rad=[0, 0.45, 0], angle=35)
lathe("led_ring", [(0.0, 0.0), (0.85, 0.0)], M_BLACK_GLOSS, (LED_C[0], LED_C[1], Z0 + 0.01), segs=48)
lathe("led", [(0.0, 0.0), (0.5, 0.0)], M_LED, (LED_C[0], LED_C[1], Z0 + 0.02), segs=48)
text("lbl_power", "I / O", 1.3, (px_, py_ - 5.2, Z0 + 0.012), fnt=F_ROMAN, spacing=1.1)

# --- front face: date projector (no branding)
FY = -D / 2
FL = (W / 2 - CR - 7.0, FY, ZB + 9.0)
rotF = (math.pi / 2, 0, 0)
lathe("front_bezel", [(4.6, -0.2), (4.6, 0.5), (3.85, 0.95), (3.3, 0.95), (3.3, 0.05)],
      M_ALU_POL, FL, rotF, rad=[0, 0.15, 0.1, 0, 0], segs=96)
lathe("front_inner", [(3.31, 0.05), (0.0, 0.05)], M_BLACK_MATTE, FL, rotF, segs=96)
lathe("front_emitter", [(0.0, 0.08), (1.3, 0.08)], M_GLOW_FRONT, FL, rotF, segs=48)
lathe("front_glass", [(0.0, 0.8), (3.32, 0.8), (3.32, 0.15), (0.0, 0.15)], M_GLASS, FL, rotF,
      segs=96, angle=40)
text("lbl_front", "DATUM", 1.05, (FL[0] - 6.6, FY - 0.015, FL[2]), rotF, F_BOLD, align="RIGHT",
     spacing=1.5)

# --- projected date on the table (soft light)
pd = text("projected_date", DATE, 10.5, (FL[0] - 1, FY - 30, 0.06), (0, 0, 0), F_ROMAN,
          mat=M_PROJ, spacing=1.05)
pd.data.offset = 0.0

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
fl = bpy.context.active_object
fl.name = "floor"
fl.data.materials.append(M_PLINTH)

world = bpy.data.worlds.new("studio")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.62, 0.63, 0.65, 1)
bg.inputs["Strength"].default_value = 0.09


def area(name, loc, target, size, size_y, energy, color=(1, 1, 1)):
    ld = bpy.data.lights.new(name, "AREA")
    ld.shape = "RECTANGLE"
    ld.size = size
    ld.size_y = size_y
    ld.energy = energy
    ld.color = color
    ob = link(bpy.data.objects.new(name, ld))
    ob.location = loc
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return ob


area("key", (-0.55, -0.30, 0.60), (0, 0, 0.01), 0.55, 0.55, 9, (1.0, 0.985, 0.96))
area("top_back", (0.10, 0.60, 0.55), (0, 0, 0.01), 1.4, 0.6, 7, (0.97, 0.98, 1.0))
area("fill", (0.65, -0.35, 0.22), (0, 0, 0.01), 0.7, 0.5, 2.2)
area("kicker", (0.45, 0.35, 0.10), (0, 0, 0.012), 0.3, 0.15, 1.0)

# ----------------------------------------------------------------- cameras
foc = link(bpy.data.objects.new("focus", None))


def camera(name, loc, target, lens, fstop):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.sensor_width = 36
    cd.clip_start = 0.01
    cd.dof.use_dof = True
    cd.dof.aperture_fstop = fstop
    cd.dof.aperture_blades = 7
    ob = link(bpy.data.objects.new(name, cd))
    ob.location = loc
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    f = link(bpy.data.objects.new(name + "_focus", None))
    f.location = target
    cd.dof.focus_object = f
    return ob


cams = {
    "hero": camera("hero", (-0.215, -0.40, 0.255), (0.006, -0.018, 0.010), 100, 6.3),
    "top": camera("top", (0.0, -0.02, 0.62), (0.0, 0.0, 0.0), 120, 11),
    "macro": camera("macro", (0.13, -0.17, 0.115), (0.022, 0.0, 0.028), 100, 4.0),
    "front": camera("front", (0.09, -0.55, 0.11), (0.002, -0.02, 0.012), 100, 8),
}
scene.camera = cams.get(CAM, cams["hero"])

# ----------------------------------------------------------------- render
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
    cy.device = "CPU"
cy.samples = SAMPLES
cy.use_adaptive_sampling = True
cy.adaptive_threshold = 0.01
cy.max_bounces = 16
cy.glossy_bounces = 8
cy.transmission_bounces = 16
cy.transparent_max_bounces = 16
cy.diffuse_bounces = 4
cy.sample_clamp_indirect = 8
cy.blur_glossy = 0.5
cy.caustics_reflective = True
cy.caustics_refractive = True
cy.use_denoising = True
try:
    cy.denoiser = "OPENIMAGEDENOISE"
except Exception:
    pass
scene.render.resolution_x = RX
scene.render.resolution_y = RY
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_depth = "16"
scene.view_settings.view_transform = "AgX"
for look in ("AgX - Medium High Contrast", "Medium High Contrast"):
    try:
        scene.view_settings.look = look
        break
    except Exception:
        pass
scene.view_settings.exposure = float(os.environ.get("ZL_EXPOSURE", "0.0"))
scene.render.filepath = OUT

if os.environ.get("ZL_SAVE"):
    bpy.ops.wm.save_as_mainfile(filepath=os.environ["ZL_SAVE"])
if not os.environ.get("ZL_NORENDER"):
    bpy.ops.render.render(write_still=True)
