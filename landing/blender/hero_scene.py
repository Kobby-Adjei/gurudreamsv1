"""
AirBridge hero: a white folded paper plane gliding over moonlit clouds at night.

Fully procedural and reproducible. No external assets.
Tested with Blender 4.2.23 LTS (see README.md).

Usage (headless):
  blender -b --factory-startup -P hero_scene.py -- [options]

Options (after the `--`):
  --quality preview|prod     sampling preset (default: preview)
  --res WxH                  output resolution (default: 1920x1080)
  --frames 1,72,140          comma list and/or ranges (e.g. 1-144) to render
  --out DIR                  output directory (default: ./frames)
  --prefix NAME              file prefix (default: hero_)
  --device auto|cpu|optix|cuda  Cycles device (auto = OPTIX > CUDA > HIP > CPU)
  --save-blend PATH          also save the generated .blend
  --no-render                build the scene only

The shot is a seamless 6 s loop at 24 fps (frames 1..144; frame 145 == frame 1).
Everything that moves is a periodic function of t = (frame-1)/144:
  * plane bank / lift / yaw: sums of sines with whole-number cycles per loop
  * clouds: the density field drifts along the flight direction by L per loop.
    Two copies of the noise field (offset by exactly L) are cross-blended with
    weights (1-t, t), variance-normalised so contrast never dips mid-loop.
    At t=0 the field is N(p); at t=1 it is N(p + L - L) = N(p)  -> exact loop.
"""

import bpy
import math
import sys
import time
import os
from mathutils import Vector, Euler

# --------------------------------------------------------------------------------------
# args
# --------------------------------------------------------------------------------------
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
            return argv[i + 1]
        return True
    return default


QUALITY = arg("--quality", "preview")
RES = arg("--res", "1920x1080")
FRAMES_ARG = arg("--frames", "1")
OUT = os.path.abspath(arg("--out", "frames"))
PREFIX = arg("--prefix", "hero_")
DEVICE = arg("--device", "auto")
SAVE_BLEND = arg("--save-blend", None)
NO_RENDER = bool(arg("--no-render", False))


def parse_frames(s):
    out = []
    for part in str(s).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-")
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return out


FRAMES = parse_frames(FRAMES_ARG)
RES_X, RES_Y = (int(v) for v in RES.lower().split("x"))

# --------------------------------------------------------------------------------------
# look constants (the "art direction" knobs)
# --------------------------------------------------------------------------------------
FPS = 24
LOOP = 144                       # frames per loop (6 s)
HEADING_DEG = 38.0               # flight heading, degrees right of the camera's view axis
DRIFT_PER_LOOP = 11.0            # how far the cloud field travels per loop (scene units)

CAM_LENS = 40.0
CAM_PITCH_DEG = -3.0             # slight downward tilt
CAM_FSTOP = 11.0                 # deep-ish focus: no "miniature" look

# cloud deck (scene units; the plane is ~1 unit long)
DECK_TOP = -7.0                  # mean cloud-top height (camera at z=0)
DECK_AMP = 9.0                  # how much coverage raises/lowers the tops
BILLOW_AMP = 5.0                 # cumulus billow amplitude on top of the deck
EARTH_R = 1100.0                 # fake planet curvature -> horizon dips below frame centre
CLOUD_DENSITY = 3.2              # extinction inside a cloud (per unit)
EDGE_SOFT = 0.40                 # width of the soft cloud boundary (units)

MOON_ELEV_DEG = 17.0
MOON_LEFT_DEG = 112.0            # azimuth left of the view axis (>90 = behind-left of camera)
MOON_STRENGTH = 9.0
MOON_COLOR = (0.86, 0.91, 1.0)

FOG_DIST = 220.0                 # aerial perspective distance (scene units)
CLOUD_ALBEDO = (0.93, 0.95, 1.0)
CLOUD_G = 0.62                   # Henyey-Greenstein anisotropy (forward scattering)
HORIZON_COLOR = (0.030, 0.045, 0.078)
ZENITH_COLOR = (0.0012, 0.0019, 0.0042)

EXPOSURE = 0.0

PRESETS = {
    # quick look-dev
    "preview": dict(samples=32, adaptive=0.05, vol_bounces=3, max_bounces=6,
                    step_rate=3.0, near_voxel=0.45, far_voxel=1.4),
    # final
    "prod": dict(samples=160, adaptive=0.015, vol_bounces=4, max_bounces=8,
                 step_rate=1.0, near_voxel=0.30, far_voxel=0.9),
}
P = PRESETS[QUALITY]

# --------------------------------------------------------------------------------------
# reset
# --------------------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = "AirBridgeHero"

# --------------------------------------------------------------------------------------
# render settings
# --------------------------------------------------------------------------------------
scene.render.engine = "CYCLES"
cy = scene.cycles


def configure_device(pref):
    cy.device = "CPU"
    if pref == "cpu":
        return "CPU"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
    except KeyError:
        return "CPU"
    order = ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL")
    if pref.upper() in order:
        order = (pref.upper(),) + tuple(o for o in order if o != pref.upper())
    for backend in order:
        try:
            prefs.compute_device_type = backend
            prefs.refresh_devices()
        except TypeError:
            continue
        gpus = [d for d in prefs.devices if d.type == backend]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == backend
            cy.device = "GPU"
            return backend
    prefs.compute_device_type = "NONE"
    return "CPU"


USED_DEVICE = configure_device(DEVICE)
print(f"[hero] device: {USED_DEVICE}")

cy.samples = P["samples"]
cy.use_adaptive_sampling = True
cy.adaptive_threshold = P["adaptive"]
cy.adaptive_min_samples = 0
cy.use_denoising = True
cy.denoiser = "OPENIMAGEDENOISE"
cy.denoising_input_passes = "RGB_ALBEDO_NORMAL"
try:
    cy.denoising_prefilter = "ACCURATE"
    cy.denoising_quality = "HIGH"
except Exception:
    pass
cy.max_bounces = P["max_bounces"]
cy.diffuse_bounces = 3
cy.glossy_bounces = 2
cy.transmission_bounces = 4
cy.transparent_max_bounces = 8
cy.volume_bounces = P["vol_bounces"]
cy.volume_step_rate = P["step_rate"]
cy.volume_preview_step_rate = P["step_rate"]
cy.volume_max_steps = 512
cy.sample_clamp_indirect = 6.0
cy.blur_glossy = 1.0
cy.caustics_reflective = False
cy.caustics_refractive = False
cy.seed = 7
cy.use_animated_seed = True       # temporal noise varies -> reads as fine grain, not crawling patterns
try:
    cy.use_light_tree = True
except Exception:
    pass

scene.render.resolution_x = RES_X
scene.render.resolution_y = RES_Y
scene.render.resolution_percentage = 100
scene.render.fps = FPS
scene.frame_start = 1
scene.frame_end = LOOP
scene.render.use_persistent_data = True
scene.render.film_transparent = False
scene.render.dither_intensity = 1.0   # breaks 8-bit banding in the navy gradient
scene.render.use_motion_blur = False

img = scene.render.image_settings
img.file_format = "PNG"
img.color_mode = "RGB"
img.color_depth = "16"
img.compression = 15

# colour management: AgX, calm contrast
scene.display_settings.display_device = "sRGB"
scene.view_settings.view_transform = "AgX"
try:
    scene.view_settings.look = "AgX - Medium High Contrast"
except TypeError:
    scene.view_settings.look = "Medium High Contrast"
scene.view_settings.exposure = EXPOSURE
scene.view_settings.gamma = 1.0

# --------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------
HEADING = math.radians(HEADING_DEG)
FWD = Vector((math.sin(HEADING), math.cos(HEADING), 0.0))   # flight direction (world)


def loop_t(frame):
    return ((frame - 1) % LOOP) / LOOP


def link(nt, a, b):
    nt.links.new(a, b)


# --------------------------------------------------------------------------------------
# world: night sky gradient + very faint sparse stars
# --------------------------------------------------------------------------------------
world = bpy.data.worlds.new("NightSky")
scene.world = world
world.use_nodes = True
wn = world.node_tree.nodes
wl = world.node_tree.links
wn.clear()
w_out = wn.new("ShaderNodeOutputWorld")
w_bg = wn.new("ShaderNodeBackground")
w_tc = wn.new("ShaderNodeTexCoord")
w_sep = wn.new("ShaderNodeSeparateXYZ")
wl.new(w_tc.outputs["Generated"], w_sep.inputs[0])

# elevation -> gradient: horizon glow (narrow) + navy body + deep zenith
w_ramp_in = wn.new("ShaderNodeMapRange")
w_ramp_in.clamp = True
w_ramp_in.inputs["From Min"].default_value = -0.15
w_ramp_in.inputs["From Max"].default_value = 1.0
wl.new(w_sep.outputs["Z"], w_ramp_in.inputs["Value"])
w_ramp = wn.new("ShaderNodeValToRGB")
cr = w_ramp.color_ramp
cr.interpolation = "B_SPLINE"
cr.elements[0].position = 0.0
cr.elements[0].color = (*[c * 0.85 for c in HORIZON_COLOR], 1)
cr.elements[1].position = 1.0
cr.elements[1].color = (*ZENITH_COLOR, 1)
e = cr.elements.new(0.13)                      # horizon
e.color = (*HORIZON_COLOR, 1)
e = cr.elements.new(0.24)
e.color = (0.010, 0.016, 0.032, 1)
e = cr.elements.new(0.45)
e.color = (0.0035, 0.0060, 0.0125, 1)
wl.new(w_ramp_in.outputs["Result"], w_ramp.inputs["Fac"])

# stars: tiny voronoi cells on the direction vector, only well above the horizon
w_vor = wn.new("ShaderNodeTexVoronoi")
w_vor.feature = "F1"
w_vor.inputs["Scale"].default_value = 260.0
w_vor.inputs["Randomness"].default_value = 1.0
wl.new(w_tc.outputs["Generated"], w_vor.inputs["Vector"])
w_dot = wn.new("ShaderNodeMapRange")              # distance -> point
w_dot.clamp = True
w_dot.inputs["From Min"].default_value = 0.035
w_dot.inputs["From Max"].default_value = 0.0
wl.new(w_vor.outputs["Distance"], w_dot.inputs["Value"])
w_pick = wn.new("ShaderNodeMath")                 # keep only ~4% of cells
w_pick.operation = "GREATER_THAN"
w_pick.inputs[1].default_value = 0.96
wl.new(w_vor.outputs["Color"], w_pick.inputs[0])  # color -> float (avg) is fine as random
w_star = wn.new("ShaderNodeMath")
w_star.operation = "MULTIPLY"
wl.new(w_dot.outputs["Result"], w_star.inputs[0])
wl.new(w_pick.outputs[0], w_star.inputs[1])
w_up = wn.new("ShaderNodeMapRange")
w_up.clamp = True
w_up.inputs["From Min"].default_value = 0.12
w_up.inputs["From Max"].default_value = 0.45
wl.new(w_sep.outputs["Z"], w_up.inputs["Value"])
w_star2 = wn.new("ShaderNodeMath")
w_star2.operation = "MULTIPLY"
wl.new(w_star.outputs[0], w_star2.inputs[0])
wl.new(w_up.outputs["Result"], w_star2.inputs[1])
w_star3 = wn.new("ShaderNodeMath")
w_star3.operation = "MULTIPLY"
w_star3.inputs[1].default_value = 0.09            # very faint
wl.new(w_star2.outputs[0], w_star3.inputs[0])
w_add = wn.new("ShaderNodeMix")
w_add.data_type = "RGBA"
w_add.blend_type = "ADD"
w_add.inputs["Factor"].default_value = 1.0
wl.new(w_ramp.outputs["Color"], w_add.inputs["A"])
w_scol = wn.new("ShaderNodeCombineXYZ")
for i in range(3):
    wl.new(w_star3.outputs[0], w_scol.inputs[i])
wl.new(w_scol.outputs[0], w_add.inputs["B"])
wl.new(w_add.outputs["Result"], w_bg.inputs["Color"])
w_bg.inputs["Strength"].default_value = 1.0
wl.new(w_bg.outputs[0], w_out.inputs["Surface"])
world.cycles_visibility.diffuse = True

# --------------------------------------------------------------------------------------
# moon (sun lamp)
# --------------------------------------------------------------------------------------
moon_data = bpy.data.lights.new("Moon", "SUN")
moon_data.energy = MOON_STRENGTH
moon_data.color = MOON_COLOR
moon_data.angle = math.radians(0.55)
moon = bpy.data.objects.new("Moon", moon_data)
scene.collection.objects.link(moon)
# sun points along its local -Z. Aim it from (az, elev) toward the scene.
az = math.radians(MOON_LEFT_DEG)
el = math.radians(MOON_ELEV_DEG)
TO_MOON = Vector((-math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
moon.rotation_euler = (-TO_MOON).to_track_quat("-Z", "Y").to_euler()

# --------------------------------------------------------------------------------------
# camera
# --------------------------------------------------------------------------------------
cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = CAM_LENS
cam_data.sensor_fit = "HORIZONTAL"
cam_data.sensor_width = 36.0
cam_data.clip_start = 0.1
cam_data.clip_end = 5000.0
cam_data.dof.use_dof = True
cam_data.dof.aperture_fstop = CAM_FSTOP
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

# --------------------------------------------------------------------------------------
# paper plane: classic dart, built from folded planar facets
# --------------------------------------------------------------------------------------
def build_dart():
    """Local frame: nose at +Y, tail at y=0, up = +Z. Length 1.0 unit."""
    L = 1.0
    span = 0.255          # half wingspan at the tail
    keel = 0.085          # keel depth at the tail
    dihedral = 0.030      # wing tip rise at the tail
    crease = 0.42         # inner fold line position (fraction of half-span at the tail)
    gap = 0.0035          # keel layers sit a hair apart at the top

    nose = Vector((0.0, L, 0.0))
    # each side: wing root (top of keel) -> inner wing crease -> wing tip; keel bottom
    verts = []
    faces = []

    def v(p):
        verts.append(Vector(p))
        return len(verts) - 1

    i_nose = v(nose)
    i_keel = v((0.0, 0.0, -keel))
    for s in (-1, 1):
        i_root = v((s * gap, 0.0, 0.0))
        i_crs = v((s * span * crease, 0.0, dihedral * crease + 0.004))
        i_tip = v((s * span, 0.0, dihedral))
        # point along leading edge where the outer layer's fold begins (adds a 2nd crease)
        i_le = v((s * span * 0.16, L * 0.70, dihedral * 0.16))
        # keel side
        faces.append((i_nose, i_keel, i_root) if s > 0 else (i_nose, i_root, i_keel))
        # inner wing panel (between root and crease)
        faces.append((i_nose, i_root, i_crs) if s > 0 else (i_nose, i_crs, i_root))
        # outer wing panel, split along a second faint fold
        faces.append((i_nose, i_crs, i_le) if s > 0 else (i_nose, i_le, i_crs))
        faces.append((i_le, i_crs, i_tip) if s > 0 else (i_le, i_tip, i_crs))

    me = bpy.data.meshes.new("PaperDart")
    me.from_pydata([tuple(p) for p in verts], [], faces)
    me.update()
    ob = bpy.data.objects.new("PaperDart", me)
    scene.collection.objects.link(ob)

    # subdivide (simple) so the paper can carry a very slight, natural bow
    mod = ob.modifiers.new("Subd", "SUBSURF")
    mod.subdivision_type = "SIMPLE"
    mod.levels = mod.render_levels = 3
    bend = ob.modifiers.new("Bow", "SIMPLE_DEFORM")
    bend.deform_method = "BEND"
    bend.angle = math.radians(-4.0)
    bend.deform_axis = "Y"
    sol = ob.modifiers.new("Paper", "SOLIDIFY")
    sol.thickness = 0.0016
    sol.offset = 0.0
    sol.use_even_offset = True
    for p in me.polygons:
        p.use_smooth = False
    return ob


plane = build_dart()
plane.rotation_mode = "YXZ"


def paper_material():
    m = bpy.data.materials.new("Paper")
    m.use_nodes = True
    nt = m.node_tree
    n = nt.nodes
    n.clear()
    out = n.new("ShaderNodeOutputMaterial")
    bsdf = n.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (0.82, 0.82, 0.80, 1)
    bsdf.inputs["Roughness"].default_value = 0.72
    bsdf.inputs["Specular IOR Level"].default_value = 0.35
    bsdf.inputs["Subsurface Weight"].default_value = 0.12
    bsdf.inputs["Subsurface Radius"].default_value = (0.004, 0.004, 0.004)
    bsdf.inputs["Subsurface Scale"].default_value = 1.0
    trans = n.new("ShaderNodeBsdfTranslucent")
    trans.inputs["Color"].default_value = (0.80, 0.80, 0.76, 1)
    mix = n.new("ShaderNodeMixShader")
    mix.inputs["Fac"].default_value = 0.22      # thin paper: moonlight glows through
    # paper fibre bump
    tc = n.new("ShaderNodeTexCoord")
    nz = n.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 900.0
    nz.inputs["Detail"].default_value = 4.0
    nz.inputs["Roughness"].default_value = 0.6
    mapping = n.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (1.0, 0.35, 1.0)  # fibres slightly stretched
    nt.links.new(tc.outputs["Object"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], nz.inputs["Vector"])
    bump = n.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.06
    bump.inputs["Distance"].default_value = 0.0004
    nt.links.new(nz.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bump.outputs["Normal"], trans.inputs["Normal"])
    nt.links.new(bsdf.outputs[0], mix.inputs[1])
    nt.links.new(trans.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return m


plane.data.materials.append(paper_material())

# --------------------------------------------------------------------------------------
# motion: camera follows the plane; both breathe with periodic, physically small motion
# --------------------------------------------------------------------------------------
# plane placement in camera-relative terms (camera at origin looking +Y, pitched down)
PLANE_DIST = 3.9
PLANE_RIGHT = 0.18
PLANE_DOWN_DEG = 10.0    # angle below horizontal -> sits in the lower-middle third


def periodic(t, terms):
    return sum(a * math.sin(2 * math.pi * (k * t) + ph) for (a, k, ph) in terms)


for f in range(1, LOOP + 2):
    t = loop_t(f) if f <= LOOP else 1.0  # f = LOOP+1 equals f = 1 (keys for clean cycling)
    # camera: tiny drift so the frame feels hand-flown, not locked off
    cam.location = (periodic(t, [(0.035, 1, 0.3)]),
                    periodic(t, [(0.04, 1, 1.9)]),
                    periodic(t, [(0.05, 1, 0.0), (0.012, 2, 1.1)]))
    cam.rotation_euler = Euler((math.radians(90 + CAM_PITCH_DEG + periodic(t, [(0.18, 1, 2.2)])),
                                math.radians(periodic(t, [(0.25, 1, 0.7)])),
                                math.radians(periodic(t, [(0.20, 1, 4.0)]))), "XYZ")
    cam.keyframe_insert("location", frame=f)
    cam.keyframe_insert("rotation_euler", frame=f)

    # plane: soft lift, bank and yaw; slightly out of phase with the camera
    down = math.radians(PLANE_DOWN_DEG)
    base = Vector((PLANE_RIGHT, PLANE_DIST * math.cos(down), -PLANE_DIST * math.sin(down)))
    plane.location = base + Vector((periodic(t, [(0.05, 1, 1.2)]),
                                    periodic(t, [(0.06, 1, 0.4)]),
                                    periodic(t, [(0.085, 1, 0.9), (0.02, 2, 0.2)])))
    bank = periodic(t, [(4.5, 1, 0.5), (1.0, 2, 2.0)])
    pitch = 3.0 + periodic(t, [(1.4, 1, 2.4)])
    yaw = periodic(t, [(2.0, 1, 1.0)])
    plane.rotation_euler = Euler((math.radians(pitch),
                                  math.radians(bank),
                                  -HEADING + math.radians(yaw)), "YXZ")
    plane.keyframe_insert("location", frame=f)
    plane.keyframe_insert("rotation_euler", frame=f)

for ob in (cam, plane):
    if ob.animation_data and ob.animation_data.action:
        for fc in ob.animation_data.action.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"   # keys every frame already -> no overshoot

# focus on the plane
cam_data.dof.focus_object = plane

# --------------------------------------------------------------------------------------
# clouds: Geometry Nodes "Volume Cube" evaluates a procedural density field into a grid
# --------------------------------------------------------------------------------------
def build_cloud_nodes():
    ng = bpy.data.node_groups.new("CloudField", "GeometryNodeTree")
    ng.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    for name, typ, dv in (("Min", "NodeSocketVector", (0, 0, 0)),
                          ("Max", "NodeSocketVector", (1, 1, 1)),
                          ("Voxel", "NodeSocketFloat", 0.4)):
        s = ng.interface.new_socket(name, in_out="INPUT", socket_type=typ)
        s.default_value = dv
    ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    N = ng.nodes
    gi = N.new("NodeGroupInput")
    go = N.new("NodeGroupOutput")

    def L(a, b):
        ng.links.new(a, b)

    def math_node(op, a=None, b=None, c=None):
        m = N.new("ShaderNodeMath")
        m.operation = op
        for i, x in enumerate((a, b, c)):
            if x is None:
                continue
            if isinstance(x, (int, float)):
                m.inputs[i].default_value = x
            else:
                L(x, m.inputs[i])
        return m.outputs[0]

    def vmath(op, a=None, b=None, scale=None):
        m = N.new("ShaderNodeVectorMath")
        m.operation = op
        for i, x in enumerate((a, b)):
            if x is None:
                continue
            if isinstance(x, (tuple, list, Vector)):
                m.inputs[i].default_value = tuple(x)
            else:
                L(x, m.inputs[i])
        if scale is not None:
            if isinstance(scale, (int, float)):
                m.inputs["Scale"].default_value = scale
            else:
                L(scale, m.inputs["Scale"])
        return m.outputs[0] if op not in ("LENGTH", "DOT_PRODUCT", "DISTANCE") else m.outputs[1]

    def maprange(x, a, b, c=0.0, d=1.0, smooth=True):
        m = N.new("ShaderNodeMapRange")
        m.clamp = True
        m.interpolation_type = "SMOOTHSTEP" if smooth else "LINEAR"
        L(x, m.inputs["Value"])
        m.inputs["From Min"].default_value = a
        m.inputs["From Max"].default_value = b
        m.inputs["To Min"].default_value = c
        m.inputs["To Max"].default_value = d
        return m.outputs["Result"]

    def noise(vec, scale, detail, rough, distort=0.0, lac=2.0):
        n = N.new("ShaderNodeTexNoise")
        n.noise_dimensions = "3D"
        try:
            n.noise_type = "FBM"
        except Exception:
            pass
        n.normalize = True
        L(vec, n.inputs["Vector"])
        n.inputs["Scale"].default_value = scale
        n.inputs["Detail"].default_value = detail
        n.inputs["Roughness"].default_value = rough
        n.inputs["Lacunarity"].default_value = lac
        n.inputs["Distortion"].default_value = distort
        return n.outputs["Fac"]

    def voronoi(vec, scale, warp=None, warp_amt=0.0):
        v = N.new("ShaderNodeTexVoronoi")
        v.voronoi_dimensions = "3D"
        v.feature = "SMOOTH_F1"
        v.distance = "EUCLIDEAN"
        v.normalize = False
        v.inputs["Scale"].default_value = scale
        v.inputs["Randomness"].default_value = 0.85
        v.inputs["Smoothness"].default_value = 0.6
        if warp is not None:
            cx = N.new("ShaderNodeCombineXYZ")
            w = math_node("MULTIPLY", math_node("SUBTRACT", warp, 0.5), warp_amt)
            L(w, cx.inputs[0]); L(w, cx.inputs[1])
            L(math_node("MULTIPLY", w, 0.5), cx.inputs[2])
            vec = vmath("ADD", vec, cx.outputs[0])
        L(vec, v.inputs["Vector"])
        return v.outputs["Distance"]

    pos = N.new("GeometryNodeInputPosition").outputs[0]
    st = N.new("GeometryNodeInputSceneTime")
    # t = ((frame-1) mod LOOP) / LOOP
    t = math_node("DIVIDE", math_node("FLOORED_MODULO", math_node("SUBTRACT", st.outputs["Frame"], 1.0), float(LOOP)), float(LOOP))
    one_minus_t = math_node("SUBTRACT", 1.0, t)
    norm = math_node("SQRT", math_node("ADD", math_node("MULTIPLY", t, t), math_node("MULTIPLY", one_minus_t, one_minus_t)))
    w1 = math_node("DIVIDE", one_minus_t, norm)
    w2 = math_node("DIVIDE", t, norm)

    # drift along flight direction: q1 = p + FWD * (t*L);  q2 = q1 - FWD*L
    s = math_node("MULTIPLY", t, DRIFT_PER_LOOP)
    q1 = vmath("ADD", pos, vmath("SCALE", FWD, None, scale=s))
    q2 = vmath("SUBTRACT", q1, FWD * DRIFT_PER_LOOP)

    def field(q, seed_off):
        # squash vertically: clouds are wider than tall
        qs = vmath("MULTIPLY", q, (1.0, 1.0, 1.7))
        qs = vmath("ADD", qs, seed_off)
        cover = noise(qs, 1.0 / 70.0, 2.0, 0.5, distort=0.2)          # big-scale: gaps / stratus / towers
        billow = noise(qs, 1.0 / 11.0, 7.0, 0.52, distort=0.35)        # cumulus masses
        fine = noise(qs, 1.0 / 3.2, 4.0, 0.6)                          # small turbulent detail
        # rounded cumulus "cauliflower" caps: inverted smooth-F1 voronoi at two scales,
        # domain-warped by the billow noise so the puffs don't look like spheres on a grid
        puff_a = voronoi(qs, 1.0 / 8.0, warp=billow, warp_amt=4.0)
        return cover, billow, fine, puff_a

    c1, b1, f1, pa1 = field(q1, (0.0, 0.0, 0.0))
    c2, b2, f2, pa2 = field(q2, (0.0, 0.0, 0.0))

    def blend(a, b):
        # 0.5 + w1*(a-0.5) + w2*(b-0.5)  (variance-preserving)
        return math_node("ADD", 0.5, math_node("ADD",
                                              math_node("MULTIPLY", w1, math_node("SUBTRACT", a, 0.5)),
                                              math_node("MULTIPLY", w2, math_node("SUBTRACT", b, 0.5))))

    cover = blend(c1, c2)
    billow = blend(b1, b2)
    fine = blend(f1, f2)
    puff_a = blend(pa1, pa2)

    sep = N.new("ShaderNodeSeparateXYZ")
    L(pos, sep.inputs[0])
    z = sep.outputs["Z"]
    # curvature drop (camera-relative, not drifting): r^2 / 2R
    r2 = math_node("ADD", math_node("MULTIPLY", sep.outputs["X"], sep.outputs["X"]),
                   math_node("MULTIPLY", sep.outputs["Y"], sep.outputs["Y"]))
    drop = math_node("DIVIDE", r2, 2.0 * EARTH_R)

    # deck top height from coverage: gaps sink, towers rise
    cov_c = maprange(cover, 0.30, 0.72, 0.0, 1.0, smooth=True)
    top = math_node("ADD", DECK_TOP - DECK_AMP * 0.45, math_node("MULTIPLY", cov_c, DECK_AMP))
    top = math_node("SUBTRACT", top, drop)
    # billow amplitude grows with coverage: flat stratus where cover is mid-low
    amp = math_node("ADD", 0.8, math_node("MULTIPLY", maprange(cover, 0.42, 0.70), BILLOW_AMP))
    shape = math_node("ADD",
                      math_node("MULTIPLY", math_node("SUBTRACT", billow, 0.5), 2.0),
                      math_node("MULTIPLY", math_node("SUBTRACT", fine, 0.5), 0.6))
    shape = math_node("ADD", shape, math_node("MULTIPLY", math_node("SUBTRACT", 0.5, puff_a), 0.7))
    sdf = math_node("ADD", math_node("SUBTRACT", top, z), math_node("MULTIPLY", shape, amp))
    dens = maprange(sdf, 0.0, EDGE_SOFT * 2.0, 0.0, 1.0, smooth=True)
    # thin out a little near the edges so tops read as fluffy, not plastic
    dens = math_node("MULTIPLY", dens, CLOUD_DENSITY)

    vc = N.new("GeometryNodeVolumeCube")
    L(dens, vc.inputs["Density"])
    vc.inputs["Background"].default_value = 0.0
    L(gi.outputs["Min"], vc.inputs["Min"])
    L(gi.outputs["Max"], vc.inputs["Max"])
    # resolution = (max-min)/voxel
    size = vmath("SUBTRACT", gi.outputs["Max"], gi.outputs["Min"])
    sz = N.new("ShaderNodeSeparateXYZ")
    L(size, sz.inputs[0])
    for axis, sock in (("X", "Resolution X"), ("Y", "Resolution Y"), ("Z", "Resolution Z")):
        r = math_node("CEIL", math_node("DIVIDE", sz.outputs[axis], gi.outputs["Voxel"]))
        L(r, vc.inputs[sock])
    setmat = N.new("GeometryNodeSetMaterial")
    L(vc.outputs[0], setmat.inputs["Geometry"])
    setmat.inputs["Material"].default_value = bpy.data.materials["Cloud"]
    L(setmat.outputs[0], go.inputs[0])
    return ng


def cloud_material():
    """Principled Volume driven by the baked density grid.

    Aerial perspective is folded into the cloud shader itself (noise-free, no extra
    volume): with distance d from the camera, a fraction f = 1 - exp(-d/FOG_DIST) of the
    cloud's scattering albedo is traded for emission at the horizon colour. For optically
    thick clouds this converges to the horizon colour, giving a soft horizon without a line.
    """
    m = bpy.data.materials.new("Cloud")
    m.use_nodes = True
    nt = m.node_tree
    n = nt.nodes
    n.clear()
    lk = nt.links.new
    out = n.new("ShaderNodeOutputMaterial")
    pv = n.new("ShaderNodeVolumePrincipled")
    attr = n.new("ShaderNodeAttribute")
    attr.attribute_name = "density"
    attr.attribute_type = "GEOMETRY"
    lk(attr.outputs["Fac"], pv.inputs["Density"])

    camd = n.new("ShaderNodeCameraData")
    ex = n.new("ShaderNodeMath"); ex.operation = "MULTIPLY"; ex.inputs[1].default_value = -1.0 / FOG_DIST
    lk(camd.outputs["View Distance"], ex.inputs[0])
    ee = n.new("ShaderNodeMath"); ee.operation = "EXPONENT"
    lk(ex.outputs[0], ee.inputs[0])                     # T_air = exp(-d/FOG_DIST)
    fogf = n.new("ShaderNodeMath"); fogf.operation = "SUBTRACT"; fogf.inputs[0].default_value = 1.0
    lk(ee.outputs[0], fogf.inputs[1])                   # f = 1 - T_air

    alb = n.new("ShaderNodeMix"); alb.data_type = "RGBA"
    alb.inputs["A"].default_value = (*CLOUD_ALBEDO, 1)
    alb.inputs["B"].default_value = (0.0, 0.0, 0.0, 1)
    lk(fogf.outputs[0], alb.inputs["Factor"])
    lk(alb.outputs["Result"], pv.inputs["Color"])

    # emission = horizon colour * f * extinction  (radiance of a thick slab -> horizon colour)
    em_s = n.new("ShaderNodeMath"); em_s.operation = "MULTIPLY"
    lk(fogf.outputs[0], em_s.inputs[0])
    lk(attr.outputs["Fac"], em_s.inputs[1])
    pv.inputs["Emission Color"].default_value = (*HORIZON_COLOR, 1)
    lk(em_s.outputs[0], pv.inputs["Emission Strength"])

    pv.inputs["Anisotropy"].default_value = CLOUD_G
    pv.inputs["Absorption Color"].default_value = (0.0, 0.0, 0.0, 1)
    lk(pv.outputs[0], out.inputs["Volume"])
    m.cycles.volume_interpolation = "CUBIC"
    m.cycles.homogeneous_volume = False
    return m


cloud_material()
cloud_ng = build_cloud_nodes()


def cloud_object(name, vmin, vmax, voxel):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    mod = ob.modifiers.new("CloudField", "NODES")
    mod.node_group = cloud_ng
    ids = {s.name: s.identifier for s in cloud_ng.interface.items_tree if s.item_type == "SOCKET" and s.in_out == "INPUT"}
    mod[ids["Min"]] = vmin
    mod[ids["Max"]] = vmax
    mod[ids["Voxel"]] = voxel
    ob.data.materials.append(bpy.data.materials["Cloud"])
    return ob


# Near grid covers the visible frustum close to camera at fine resolution; far grid at coarse.
NEAR_Y = 95.0
cloud_object("CloudsNear", (-62.0, 6.0, -26.0), (62.0, NEAR_Y, -1.5), P["near_voxel"])
cloud_object("CloudsFar", (-260.0, NEAR_Y, -46.0), (260.0, 330.0, -4.0), P["far_voxel"])

# --------------------------------------------------------------------------------------
# compositor: whisper of film grain + gentle vignette (keeps 8-bit encodes band-free)
# --------------------------------------------------------------------------------------
scene.use_nodes = True
ct = scene.node_tree
for nd in list(ct.nodes):
    ct.nodes.remove(nd)
rl = ct.nodes.new("CompositorNodeRLayers")
comp = ct.nodes.new("CompositorNodeComposite")
# vignette: ellipse mask, blurred, multiplied lightly
mask = ct.nodes.new("CompositorNodeEllipseMask")
mask.width = 1.15
mask.height = 1.35
mask.y = 0.55
blur = ct.nodes.new("CompositorNodeBlur")
blur.filter_type = "FAST_GAUSS"
blur.use_relative = True
blur.factor_x = blur.factor_y = 30.0
blur.size_x = blur.size_y = 1
ct.links.new(mask.outputs[0], blur.inputs[0])
vig = ct.nodes.new("CompositorNodeMapRange")
vig.inputs["To Min"].default_value = 0.80
vig.inputs["To Max"].default_value = 1.0
ct.links.new(blur.outputs[0], vig.inputs["Value"])
mul = ct.nodes.new("CompositorNodeMixRGB")
mul.blend_type = "MULTIPLY"
mul.inputs[0].default_value = 1.0
ct.links.new(rl.outputs["Image"], mul.inputs[1])
ct.links.new(vig.outputs[0], mul.inputs[2])
ct.links.new(mul.outputs[0], comp.inputs["Image"])

# --------------------------------------------------------------------------------------
# render
# --------------------------------------------------------------------------------------
if SAVE_BLEND:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(SAVE_BLEND))

if not NO_RENDER:
    os.makedirs(OUT, exist_ok=True)
    timings = []
    for f in FRAMES:
        scene.frame_set(f)
        scene.render.filepath = os.path.join(OUT, f"{PREFIX}{f:04d}.png")
        t0 = time.time()
        bpy.ops.render.render(write_still=True)
        dt = time.time() - t0
        timings.append(dt)
        print(f"[hero] frame {f} -> {scene.render.filepath}  {dt:.1f}s", flush=True)
    if timings:
        print(f"[hero] {len(timings)} frames, mean {sum(timings) / len(timings):.1f}s/frame "
              f"({QUALITY}, {RES_X}x{RES_Y}, {USED_DEVICE})", flush=True)
