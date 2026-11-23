# Zeitlinse ZL 2 — speculative temporal projector (moulded plastic, fog-projection optic).
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


M_ALU = principled("alu_beadblast", (0.62, 0.62, 0.63), metallic=1, rough=0.26,
                   grain=0.3, rough_var=0.03)
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
M_PLINTH = principled("plinth", (0.70, 0.70, 0.71), rough=0.88, spec=0.3)
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


F_MONO = font("BasierSquareMono-Regular.otf") or F_LIGHT


# ------------------------------------------------------------------ plastics
def lin(hexs):
    h = hexs.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def plastic(name, hexs, rough=0.46, sss=0.0, grain=0.07):
    """Moulded PC/ABS with a fine VDI-style spark-eroded texture."""
    return principled(name, lin(hexs), rough=rough, spec=0.5, grain=grain, rough_var=0.02, sss=sss)


P_BLACK = plastic("p_black", "#1a1a1b", rough=0.55)
P_BLACK_GLOSS = principled("p_black_gloss", lin("#0b0b0c"), rough=0.12, spec=0.5)
P_GAP = principled("p_gap", (0.002, 0.002, 0.002), rough=0.9, spec=0.05)
P_ORANGE = plastic("p_orange", "#f0531f", rough=0.42, sss=0.06, grain=0.04)
P_SMOKE = principled("p_smoke", lin("#0e0f10"), rough=0.06, spec=0.6, clearcoat=0.6)
M_DIGITS = emissive("digits", (1.0, 0.78, 0.55), 3.2)
M_LED2 = emissive("led2", (0.25, 1.0, 0.35), 14)


# ------------------------------------------------------------------ geometry helpers
def slab2(name, outer, holes, z0, z1, re, mat, loc=(0, 0, 0), re_hole=0.35, n_round=10):
    """Like slab(), but holes get their own (small) edge round so soft bodies keep crisp openings."""
    def prof_for(r):
        if r <= 0:
            return [(0, z1), (0, z0)]
        p = []
        for i in range(n_round + 1):
            a = math.pi / 2 * i / n_round
            p.append((-r + r * math.sin(a), z1 - r + r * math.cos(a)))
        for i in range(n_round + 1):
            a = math.pi / 2 * i / n_round
            p.append((-r + r * math.cos(a), z0 + r - r * math.sin(a)))
        return p
    loops = [(outer, prof_for(re))] + [(list(reversed(h)), prof_for(re_hole)) for h in holes]
    bm = bmesh.new()
    tops, bots = [], []
    for L, prof in loops:
        nrm = loop_normals(L)
        rings = [[bm.verts.new((p[0] + nv.x * o, p[1] + nv.y * o, z)) for p, nv in zip(L, nrm)]
                 for (o, z) in prof]
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
        for t in tessellate_polygon([[v.co.copy() for v in ring] for ring in caps]):
            try:
                bm.faces.new((flat[t[0]], flat[t[1]], flat[t[2]]))
            except ValueError:
                pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return to_obj(name, bm, mat, loc, weighted=True)


def ccw(pts):
    a = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1]
            for i in range(len(pts)))
    return pts if a > 0 else list(reversed(pts))


def strip(path, w):
    """Closed outline of a stroke of width w along an open polyline."""
    L, R = [], []
    for i, p in enumerate(path):
        p = Vector(p)
        if i == 0:
            d = Vector(path[1]) - p
        elif i == len(path) - 1:
            d = p - Vector(path[-2])
        else:
            d = (Vector(path[i + 1]) - Vector(path[i - 1]))
        d.normalize()
        n = Vector((-d.y, d.x)) * (w / 2)
        L.append((p.x + n.x, p.y + n.y))
        R.append((p.x - n.x, p.y - n.y))
    return ccw(dedupe(L + list(reversed(R))))


def xf(pts, s, ang, cx, cy):
    c, si = math.cos(ang), math.sin(ang)
    return [(cx + s * (x * c - y * si), cy + s * (x * si + y * c)) for x, y in pts]


def moulded(name, outline, z, mat, h=0.22):
    """Tone-on-tone raised detail, moulded into the part."""
    return slab2(name, outline, [], z - 0.3, z + h, 0.06, mat, n_round=3)


def shuffle_icon(name, cx, cy, z, size, mat, ang=0.0):
    """Two crossing arrows, moulded into the key top. `size` = half width in mm."""
    def s_path(sign):
        pts = [(-1.0, -0.5 * sign), (-0.55, -0.5 * sign)]
        for i in range(1, 15):
            t = i / 14
            e = t * t * (3 - 2 * t)
            pts.append((-0.55 + 1.05 * t, -0.5 * sign + 1.0 * sign * e))
        pts.append((0.62, 0.5 * sign))
        return pts
    for k, sign in enumerate((1, -1)):
        moulded("%s_s%d" % (name, k), xf(strip(s_path(sign), 0.17), size, ang, cx, cy), z, mat)
        head = [(0.58, 0.5 * sign + 0.27), (0.58, 0.5 * sign - 0.27), (1.0, 0.5 * sign)]
        moulded("%s_h%d" % (name, k), ccw(xf(head, size, ang, cx, cy)), z, mat)


def chevron(name, cx, cy, z, size, mat, up=True, ang=0.0):
    s = 1 if up else -1
    pts = [(-0.7, -0.35 * s), (0.0, 0.35 * s), (0.7, -0.35 * s)]
    moulded(name, xf(strip(pts, 0.22), size, ang, cx, cy), z, mat)


def dots(name, centers, r, mat, loc, rot=(0, 0, 0), segs=12):
    bm = bmesh.new()
    for (x, y) in centers:
        vs = [bm.verts.new((x + r * math.cos(2 * math.pi * i / segs),
                            y + r * math.sin(2 * math.pi * i / segs), 0)) for i in range(segs)]
        bm.faces.new(vs)
    o = to_obj(name, bm, mat, loc, smooth=False)
    o.rotation_euler = rot
    return o


def ring(name, r0, r1, z, mat, loc, segs=160):
    return lathe(name, [(r1, z), (r0, z)], mat, loc, segs=segs)


def floor_under(name, outline, z, mat=None):
    return slab2(name, outline, [], z - 0.5, z, 0, mat or P_GAP)


def optic(cx, cy, Z, R, bezel_mat):
    """Upward projection optic, scaled from the ZL 1 lens."""
    s = R / 19.0
    L = (cx, cy, Z)
    lathe("opt_bezel", [(R, -8 * s), (R, -0.35), (R - 1.2 * s, -0.35), (R - 2.2 * s, -1.5 * s),
                        (R - 2.2 * s, -2.1 * s)], bezel_mat, L, rad=[0, 0.3, 0.25, 0, 0])
    r1 = R - 2.2 * s
    lathe("opt_ring", [(r1, -2.1 * s), (12.7 * s, -2.1 * s), (12.7 * s, -2.45 * s)], P_BLACK, L)
    lathe("opt_retainer", [(12.7 * s, -2.45 * s), (11.05 * s, -2.45 * s), (11.05 * s, -9.0 * s)],
          P_BLACK_GLOSS, L, angle=20)
    rg = 11.0 * s
    sag = 0.75 * s
    Rs = (rg ** 2 + sag ** 2) / (2 * sag)
    g = [(0.0, -2.75 * s)]
    for i in range(1, 25):
        r = rg * i / 24
        g.append((r, -2.75 * s - (Rs - math.sqrt(Rs ** 2 - r * r))))
    g += [(rg, -5.2 * s), (0.0, -5.2 * s)]
    lathe("opt_glass", g, M_GLASS, L, angle=40)
    hexa = [(4.2 * s * math.cos(math.radians(30 + 60 * i)), 4.2 * s * math.sin(math.radians(30 + 60 * i)))
            for i in range(6)]
    slab("opt_iris", circle_pts(0, 0, rg, 96), [hexa], -6.6 * s, -6.3 * s, 0.0, M_BLACK_ANO, L)
    lathe("opt_emitter", [(0.0, -11.5 * s), (2.2 * s, -11.5 * s)], M_GLOW_CORE, L)
    lathe("opt_cavity", [(rg, -9.0 * s), (rg, -12.0 * s), (0.0, -12.0 * s)], P_BLACK, L)


def round_key(name, cx, cy, Z, r, mat, h=0.9, icon=True):
    lathe(name, [(0.0, h), (r - 0.6, h), (r, h - 0.55), (r, -3.0)], mat, (cx, cy, Z),
          rad=[0, 0.5, 0.35, 0], segs=96)
    floor_under(name + "_well", circle_pts(cx, cy, r + 0.6, 64), Z - 2.5)
    if icon:
        shuffle_icon(name + "_icon", cx, cy, Z + h, r * 0.5, mat)


def front_window(cx, FY, zc, w, h, r=2.2):
    """Centred rectangular date window: smoked lens over a warm segment-free readout."""
    rot = (math.pi / 2, 0, 0)
    o = slab2("win_lens", rr_pts(0, 0, w, h, r), [], -0.6, 0.1, 0.12, P_SMOKE, (cx, FY, zc), n_round=4)
    o.rotation_euler = rot
    text("win_digits", DATE, h * 0.42, (cx, FY - 0.115, zc - h * 0.02), rot, F_MONO,
         mat=M_DIGITS, spacing=1.12)


def led(x, y, Z):
    lathe("led_ring", [(0.0, 0.0), (0.7, 0.0)], P_BLACK_GLOSS, (x, y, Z + 0.01), segs=40)
    lathe("led", [(0.0, 0.0), (0.38, 0.0)], M_LED2, (x, y, Z + 0.02), segs=40)


def foot(W, D, CR):
    slab2("foot", rr_pts(0, 0, W - 8, D - 8, max(CR - 4, 2)), [], 0.0, 1.2, 0.3, P_BLACK)


def mist_plume(x, y, z, r, h):
    """Very faint fog column above the optic — the medium the image is projected into."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=1, depth=2)
    o = bpy.context.active_object
    o.name = "mist"
    o.scale = (r * MM, r * MM, h / 2 * MM)
    o.location = (x * MM, y * MM, (z + h / 2) * MM)
    mat = bpy.data.materials.new("mist")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    vol = nt.nodes.new("ShaderNodeVolumePrincipled")
    vol.inputs["Color"].default_value = (0.95, 0.96, 1.0, 1)
    vol.inputs["Emission Color"].default_value = (1.0, 0.82, 0.62, 1)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    # radial falloff (1 at axis -> 0 at the cylinder wall), widening as it rises
    xy = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(sep.outputs["X"], xy.inputs["X"])
    nt.links.new(sep.outputs["Y"], xy.inputs["Y"])
    ln = nt.nodes.new("ShaderNodeVectorMath")
    ln.operation = "LENGTH"
    nt.links.new(xy.outputs[0], ln.inputs[0])
    zz = nt.nodes.new("ShaderNodeMapRange")
    zz.inputs["From Min"].default_value = -1
    zz.inputs["From Max"].default_value = 1
    nt.links.new(sep.outputs["Z"], zz.inputs["Value"])          # 0 bottom .. 1 top
    wid = nt.nodes.new("ShaderNodeMath")
    wid.operation = "MULTIPLY_ADD"
    wid.inputs[1].default_value = 0.75
    wid.inputs[2].default_value = 0.25
    nt.links.new(zz.outputs[0], wid.inputs[0])                    # radius 0.25 .. 1.0
    rr = nt.nodes.new("ShaderNodeMath")
    rr.operation = "DIVIDE"
    nt.links.new(ln.outputs["Value"], rr.inputs[0])
    nt.links.new(wid.outputs[0], rr.inputs[1])
    rad = nt.nodes.new("ShaderNodeMapRange")
    rad.inputs["From Min"].default_value = 0.2
    rad.inputs["From Max"].default_value = 1.0
    rad.inputs["To Min"].default_value = 1
    rad.inputs["To Max"].default_value = 0
    rad.interpolation_type = "SMOOTHSTEP"
    nt.links.new(rr.outputs[0], rad.inputs["Value"])
    # vertical: fade in from the optic, fade out at the top
    vin = nt.nodes.new("ShaderNodeMapRange")
    vin.inputs["From Min"].default_value = 0.0
    vin.inputs["From Max"].default_value = 0.12
    vin.interpolation_type = "SMOOTHSTEP"
    nt.links.new(zz.outputs[0], vin.inputs["Value"])
    vout = nt.nodes.new("ShaderNodeMapRange")
    vout.inputs["From Min"].default_value = 1.0
    vout.inputs["From Max"].default_value = 0.35
    vout.interpolation_type = "SMOOTHSTEP"
    nt.links.new(zz.outputs[0], vout.inputs["Value"])
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 3.2
    nz.inputs["Detail"].default_value = 6
    nz.inputs["Roughness"].default_value = 0.6
    nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
    nzr = nt.nodes.new("ShaderNodeMapRange")
    nzr.inputs["From Min"].default_value = 0.35
    nzr.inputs["From Max"].default_value = 0.75
    nt.links.new(nz.outputs["Fac"], nzr.inputs["Value"])
    m1 = nt.nodes.new("ShaderNodeMath"); m1.operation = "MULTIPLY"
    m2 = nt.nodes.new("ShaderNodeMath"); m2.operation = "MULTIPLY"
    m3 = nt.nodes.new("ShaderNodeMath"); m3.operation = "MULTIPLY"
    nt.links.new(rad.outputs[0], m1.inputs[0]); nt.links.new(vin.outputs[0], m1.inputs[1])
    nt.links.new(m1.outputs[0], m2.inputs[0]); nt.links.new(vout.outputs[0], m2.inputs[1])
    nt.links.new(m2.outputs[0], m3.inputs[0]); nt.links.new(nzr.outputs[0], m3.inputs[1])
    dens = nt.nodes.new("ShaderNodeMath"); dens.operation = "MULTIPLY"
    dens.inputs[1].default_value = float(os.environ.get("ZL_MIST_DENSITY", "110"))
    nt.links.new(m3.outputs[0], dens.inputs[0])
    nt.links.new(dens.outputs[0], vol.inputs["Density"])
    em = nt.nodes.new("ShaderNodeMath"); em.operation = "MULTIPLY"
    em.inputs[1].default_value = 1.4
    nt.links.new(m3.outputs[0], em.inputs[0])
    nt.links.new(em.outputs[0], vol.inputs["Emission Strength"])
    nt.links.new(vol.outputs[0], out.inputs["Volume"])
    o.data.materials.append(mat)
    o.visible_shadow = False
    return o



# ------------------------------------------------------------------ the device
# ZL 2. Soft warm-white block on a long, low footprint.
#   top-left   the upward fog-projection optic, set well in from the edges, ringed by
#              micro-perforations that release the fog the hologram forms in
#   top-right  a large shuffle key and a slide power toggle (uncovers a green strip when on)
#   right end  a fluted crown sunk into a pocket in the end face: roll it to pick the year
#   front      a rectangular projection lens that throws the year onto the table
POWER_ON = os.environ.get("ZL_POWER", "1") == "1"
W, D, H = 112.0, 64.0, 20.0
CR = 12.0          # plan corner radius
RE = 2.6           # edge round: soft, not pillowy
ZB = 1.0           # body bottom (sits on a dark inset foot)
Z0 = ZB + H        # top surface
FY = -D / 2        # front face

LENS_C, LENS_R = (-24.0, 2.5), 18.0
CROWN_R, CROWN_T, CROWN_SINK = 10.0, 5.0, 1.4    # a slim, wide disc: radius, thickness, how deep it sits
CROWN_Z = 11.2                                   # axis height: the rim just breaks the top edge
KEY_C, KEY_W, KEY_D = (30.0, -10.0), 18.0, 11.0  # rectangular shuffle key
PWR_C, PWR_L, PWR_T = (30.0, 14.0), 18.0, 7.4    # toggle track centre, length, width
KNOB_L = 8.6
AP_W, AP_H, AP_DEPTH = 26.0, 3.4, 1.8            # front projection aperture

M_BODY = plastic("body_warm_white", "#ece9e2", sss=0.04)
M_TRIM = plastic("trim_grey", "#c9cdd2")
M_PWR_ON = emissive("power_on", (0.25, 1.0, 0.4), 2.2)


def boolean_cut(obj, cutter):
    m = obj.modifiers.new("cut_" + cutter.name, "BOOLEAN")
    m.operation = "DIFFERENCE"
    m.solver = "EXACT"
    m.object = cutter
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


pwr_slot = rr_pts(*PWR_C, PWR_L, PWR_T, PWR_T / 2)
body = slab2("body", rr_pts(0, 0, W, D, CR),
             [circle_pts(*LENS_C, LENS_R + 0.3), rr_pts(*KEY_C, KEY_W + 1.0, KEY_D + 1.0, 3.0), pwr_slot],
             ZB, Z0, RE, M_BODY, n_round=14)
foot(W, D, CR)

# pocket for the crown in the right end face, and the front projection aperture
cz = ZB + H / 2
pc = lathe("pocket_cut", [(0.0, -CROWN_SINK), (CROWN_R + 0.5, -CROWN_SINK), (CROWN_R + 0.5, 4.0),
                          (0.0, 4.0)], None, (W / 2, 0.0, CROWN_Z), segs=128)
pc.rotation_euler = (0, math.pi / 2, 0)
boolean_cut(body, pc)
ac = slab2("aperture_cut", rr_pts(0, 0, AP_W, AP_H, 1.2), [], -AP_DEPTH, 3.0, 0, None, (0.0, FY, cz))
ac.rotation_euler = (math.pi / 2, 0, 0)
boolean_cut(body, ac)
for poly in body.data.polygons:
    poly.use_smooth = True
body.data.set_sharp_from_angle(angle=math.radians(32))

# --- projection optic + fog perforations
optic(*LENS_C, Z0, LENS_R, M_BODY)
floor_under("lens_floor", circle_pts(*LENS_C, LENS_R + 0.5), Z0 - 9)
perf = []
for k, (rad, n) in enumerate(((LENS_R + 2.6, 56), (LENS_R + 3.7, 64))):
    for i in range(n):
        a = 2 * math.pi * (i + 0.5 * k) / n
        perf.append((rad * math.cos(a), rad * math.sin(a)))
dots("fog_perforations", perf, 0.26, P_GAP, (LENS_C[0], LENS_C[1], Z0 + 0.012))


# --- year: crown sunk in the right end, axis along X. Domed face; deep flutes along the
# whole rim so a thumb catches it anywhere.
def crown(name, R, T, mat, loc):
    """Slim wide disc: domed face rolling into a short rim, 18 narrow slots that wrap onto the face edge."""
    rr = T * 0.48                       # the rim is one big round, so the flutes wrap over it
    prof = [(0.0, T + 0.35)]
    for k in range(1, 9):              # shallow dome
        r = (R - rr) * k / 8
        prof.append((r, T + 0.35 * (1 - (k / 8) ** 2)))
    for k in range(1, 25):
        t = math.pi / 2 - math.pi * k / 24
        prof.append((R - rr + rr * math.cos(t), T / 2 + (T / 2) * math.sin(t)))
    prof.append((0.0, 0.0))
    o = lathe(name, prof, mat, loc, segs=256, angle=40)
    bm = bmesh.new()
    n, rs = 18, 0.55                  # 18 flutes, 1.1 mm wide, even depth, running out over the face edge
    z0, z1 = 0.0, T
    for i in range(n):
        a = 2 * math.pi * i / n
        cx, cy = (R - 0.3) * math.cos(a), (R - 0.3) * math.sin(a)
        seg, hr = 20, 6
        rows = [(-1, 0.0)]
        for k in range(1, hr + 1):
            t = math.pi / 2 * k / hr
            rows.append((z0 - rs * math.cos(t), rs * math.sin(t)))
        rows += [(z1, rs), (z1 + rs, 0.0)]
        ring = []
        bot = bm.verts.new((cx, cy, z0 - rs))
        for z, rr in rows[1:-1]:
            ring.append([bm.verts.new((cx + rr * math.cos(2 * math.pi * j / seg),
                                       cy + rr * math.sin(2 * math.pi * j / seg), z)) for j in range(seg)])
        top = bm.verts.new((cx, cy, z1 + rs))
        for j in range(seg):
            jn = (j + 1) % seg
            bm.faces.new((bot, ring[0][jn], ring[0][j]))
            for k in range(len(ring) - 1):
                bm.faces.new((ring[k][j], ring[k][jn], ring[k + 1][jn], ring[k + 1][j]))
            bm.faces.new((ring[-1][j], ring[-1][jn], top))
    boolean_cut(o, to_obj(name + "_cut", bm, None, loc, smooth=False))
    for p in o.data.polygons:
        p.use_smooth = True
    o.data.set_sharp_from_angle(angle=math.radians(40))
    return o


cr = crown("crown", CROWN_R, CROWN_T, M_ALU, (W / 2 - CROWN_SINK + 0.4, 0.0, CROWN_Z))
cr.rotation_euler = (0, math.pi / 2, 0)
cw = lathe("crown_axle", [(2.4, -1.0), (2.4, 0.5), (0.0, 0.5)], P_GAP, (W / 2 - CROWN_SINK, 0.0, CROWN_Z),
           segs=48)
cw.rotation_euler = (0, math.pi / 2, 0)

# --- plausible random futures: a wide rectangular key with a moulded shuffle icon
slab2("shuffle_key", rr_pts(*KEY_C, KEY_W, KEY_D, 2.5), [], Z0 - 3.0, Z0 + 1.3, 0.7, P_ORANGE, n_round=6)
floor_under("shuffle_key_well", rr_pts(*KEY_C, KEY_W + 1.2, KEY_D + 1.2, 3.1), Z0 - 2.5)
shuffle_icon("shuffle_key_icon", *KEY_C, Z0 + 1.3, 3.6, P_ORANGE)

# --- power: slide toggle; sliding right uncovers the green strip
floor_under("power_floor", rr_pts(*PWR_C, PWR_L + 0.6, PWR_T + 0.6, (PWR_T + 0.6) / 2), Z0 - 2.4)
slab2("power_on_strip", rr_pts(PWR_C[0] - PWR_L / 4, PWR_C[1], PWR_L / 2 - 1.6, 2.0, 1.0), [],
      Z0 - 2.4, Z0 - 2.3, 0, M_PWR_ON)          # hidden under the knob when off
kx = PWR_C[0] + (1 if POWER_ON else -1) * (PWR_L - KNOB_L) / 2 - (0.3 if POWER_ON else -0.3)
slab2("power_knob", rr_pts(0, 0, KNOB_L, PWR_T - 1.0, (PWR_T - 1.0) / 2), [], -2.0, 1.4, 0.8,
      M_TRIM, (kx, PWR_C[1], Z0), n_round=6)
for k in (-1, 0, 1):   # three grip ridges
    moulded("power_knob_ridge%d" % (k + 1), rr_pts(kx + k * 1.6, PWR_C[1], 0.55, PWR_T - 3.2, 0.27),
            Z0 + 1.4, M_TRIM, h=0.2)

# --- front: rectangular projection lens; the year lands on the table in front
rotF = (math.pi / 2, 0, 0)
for name, z0, z1, mat in (("aperture_back", -AP_DEPTH - 0.4, -AP_DEPTH + 0.05, P_BLACK),
                          ("front_lens", -0.9, -0.35, M_GLASS)):
    o = slab2(name, rr_pts(0, 0, AP_W + 0.2, AP_H + 0.2, 1.3), [], z0, z1, 0.15, mat, (0.0, FY, cz),
              n_round=4)
    o.rotation_euler = rotF
M_GLOW_FRONT.node_tree.nodes["Emission"].inputs["Strength"].default_value = 1.4
o = slab2("front_emitter", rr_pts(0, 0, AP_W - 8.0, 0.9, 0.45), [], -AP_DEPTH + 0.06, -AP_DEPTH + 0.1, 0,
          M_GLOW_FRONT, (0.0, FY, cz))
o.rotation_euler = rotF
pd = text("projected_date", DATE, 9.5, (0.0, FY - 34.0, 0.06), (0, 0, 0), F_ROMAN, mat=M_PROJ, spacing=1.05)

# ----------------------------------------------------------------- studio
bpy.ops.mesh.primitive_cube_add(size=1)
pl = bpy.context.active_object
pl.name = "plinth"
pl.scale = (4.0, 4.0, 0.40)          # seamless: no table edge in frame
pl.location = (0.0, 0.0, -0.20)
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
bg.inputs["Color"].default_value = (0.80, 0.80, 0.82, 1)     # high-key room: metal and gloss mirror light, not a void
bg.inputs["Strength"].default_value = float(os.environ.get("ZL_WORLD", "0.12"))


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


# soft, wrapping product light: a big overhead silk, a large key, broad fill, white bounce cards
area("overhead", (0.0, 0.05, 0.85), (0, 0, 0.0), 1.6, 1.6, 26, (1.0, 0.995, 0.985))
area("key", (-0.70, 0.05, 0.40), (0, 0, 0.01), 0.9, 0.9, 6, (1.0, 0.985, 0.965))
area("fill", (0.70, -0.40, 0.30), (0, 0, 0.01), 1.0, 0.8, 1.2, (0.98, 0.99, 1.0))
area("back", (0.10, 0.75, 0.35), (0, 0, 0.01), 1.6, 0.6, 5, (0.97, 0.98, 1.0))
area("side_r", (0.70, 0.10, 0.12), (0, 0, 0.012), 0.6, 0.3, 3.0)

# black flags (negative fill), hidden from the camera: they give metal and gloss dark bands to reflect,
# the way a product photographer shapes a white set
def flag(name, loc, w, h):
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = (w, h, 1)
    o.rotation_euler = (Vector((0, 0, 0.01)) - Vector(loc)).to_track_quat("Z", "Y").to_euler()
    o.data.materials.append(M_BLACK_MATTE)
    o.visible_camera = False
    o.visible_shadow = False
    return o


flag("flag_front", (0.08, -0.45, 0.10), 1.2, 0.30)
flag("flag_right", (0.50, 0.30, 0.08), 0.8, 0.25)

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
    "hero": camera("hero", (-0.215, -0.40, 0.255), (0.006, -0.018, 0.010), 100, 16),
    "top": camera("top", (0.0, -0.02, 0.62), (0.0, 0.0, 0.0), 120, 11),
    "macro": camera("macro", (0.13, -0.17, 0.115), (0.02, 0.0, 0.019), 100, 4.0),
    "front": camera("front", (0.09, -0.55, 0.11), (0.002, -0.02, 0.012), 100, 16),
    "hero_r": camera("hero_r", (0.235, -0.39, 0.25), (0.004, -0.016, 0.010), 100, 16),
    "crown_side": camera("crown_side", (0.068, -0.14, 0.03), (0.058, 0.0, 0.011), 100, 11),
    "crown": camera("crown", (0.17, -0.06, 0.035), (0.058, 0.0, 0.011), 100, 11),
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
for look in ((os.environ.get("ZL_LOOK", "AgX - Medium High Contrast"), "None")):
    try:
        scene.view_settings.look = look
        break
    except Exception:
        pass
scene.view_settings.exposure = float(os.environ.get("ZL_EXPOSURE", "-0.5"))
scene.render.filepath = OUT

if os.environ.get("ZL_SAVE"):
    bpy.ops.wm.save_as_mainfile(filepath=os.environ["ZL_SAVE"])
if not os.environ.get("ZL_NORENDER"):
    bpy.ops.render.render(write_still=True)
