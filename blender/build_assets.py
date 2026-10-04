# Jin-3D Blender 자산 생성 스크립트 — Blender(5.x)에서 실제로 모델링·재질 적용 후 glTF(.glb)로 내보낸다.
# 실행: blender -b --python blender/build_assets.py   (또는 npm run blender:assets)
# 결과: assets/blender/{amr,agv,forklift,drone,humanoid,quadruped,arm6,ammr,truck,gantry,eaxle,primitives}.glb  +  assets/blender/preview.png (Blender Eevee 렌더 미리보기)
#
# 좌표: Blender는 Z가 위, glTF로 내보내면 +Y가 위가 된다 (Blender X → three X, Blender Z → three Y, Blender −Y → three +Z).
#       three.js 모델의 "앞"(로컬 +z)은 Blender −Y 방향으로 만든다. 단위 1 = 1m (Jin-3D와 같은 크기·같은 원점: 바닥 중심)
# 이름 규칙 (three.js 코드가 찾아 쓰는 부분):
#   재질 LED          — AMR·AGV 상태 표시등 (코드가 발광색을 바꾼다)
#   재질 NAV_R·NAV_G·STROBE — 드론 항법등·스트로브 (코드가 깜빡인다)
#   빈 객체 Rotor_0~3 — 드론 로터 (코드가 돌린다)
import bpy, math, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'blender')
os.makedirs(OUT, exist_ok=True)

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # 이전 모델의 객체·메시·재질이 남아 있으면 이름이 겹쳐 Body.001처럼 바뀐다 — 모두 지워 코드가 찾는 이름을 그대로 둔다
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras):
        for x in list(coll): coll.remove(x)

MATS = {}
def mat(name, color, metal=0.0, rough=0.5, emit=None, strength=0.0, alpha=1.0):
    if name in MATS: return MATS[name]
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*color, 1.0)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1.0)
        b.inputs['Emission Strength'].default_value = strength
    if alpha < 1.0:
        b.inputs['Alpha'].default_value = alpha
        m.surface_render_method = 'BLENDED'
    MATS[name] = m
    return m

def srgb(h):   # '#rrggbb' → 선형 RGB (Blender 재질은 선형 값)
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

def setname(o, name):   # 같은 이름의 이전 객체(내보내기 임시 객체 등)가 있으면 비켜 두고 정확한 이름을 준다
    if o.name != name:
        old = bpy.data.objects.get(name)
        if old and old is not o: old.name = name + '_old'
        o.name = name
    return o

def finish(o, m, bevel=0.0, seg=3, smooth=True, parent=None):
    o.data.materials.append(m)
    if bevel > 0:
        md = o.modifiers.new('Bevel', 'BEVEL'); md.width = bevel; md.segments = seg; md.limit_method = 'ANGLE'; md.harden_normals = True
    if smooth:
        for p in o.data.polygons: p.use_smooth = True
    if parent: o.parent = parent
    return o

def box(name, size, loc, m, bevel=0.0, parent=None, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = setname(bpy.context.active_object, name); o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return finish(o, m, bevel, parent=parent, smooth=bevel > 0)

def cyl(name, r, depth, loc, m, axis='Z', parent=None, verts=32, bevel=0.0):
    rot = {'Z': (0, 0, 0), 'X': (0, math.pi / 2, 0), 'Y': (math.pi / 2, 0, 0)}[axis]
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot)
    o = setname(bpy.context.active_object, name)
    return finish(o, m, bevel, parent=parent)

def sphere(name, r, loc, m, parent=None, seg=24):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=seg // 2, radius=r, location=loc)
    o = setname(bpy.context.active_object, name)
    return finish(o, m, parent=parent)

def empty(name, loc=(0, 0, 0), parent=None):
    o = bpy.data.objects.new(name, None); bpy.context.collection.objects.link(o); setname(o, name); o.location = loc
    if parent: o.parent = parent
    return o

def wheel(name, r, w, loc, parent, axis='X'):
    t = cyl(name, r, w, loc, MATS['Rubber'], axis=axis, parent=parent, verts=40, bevel=r * 0.18)
    cyl(name + '_Hub', r * 0.55, w * 1.04, loc, MATS['Hub'], axis=axis, parent=parent, verts=24)
    return t

def common_mats():
    mat('Shell', srgb('#d6dbe1'), 0.05, 0.42)
    mat('ShellDark', srgb('#1d2228'), 0.3, 0.45)
    mat('Bumper', srgb('#15181c'), 0.0, 0.7)
    mat('Rubber', srgb('#111214'), 0.0, 0.85)
    mat('Hub', srgb('#9aa3ad'), 0.9, 0.3)
    mat('Steel', srgb('#a8b1ba'), 0.95, 0.28)
    mat('Accent', srgb('#2a6fdb'), 0.1, 0.35)
    mat('Yellow', srgb('#f2c230'), 0.1, 0.4)
    mat('Glass', srgb('#0e151d'), 0.6, 0.08)
    mat('LED', srgb('#2aa8ff'), 0.0, 0.3, emit=srgb('#2aa8ff'), strength=2.0)
    mat('Lidar', srgb('#0b0f14'), 0.4, 0.15, emit=srgb('#37e8ff'), strength=1.0)

def export(root, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in [root, *root.children_recursive]: o.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, f'{name}.glb'), export_format='GLB', use_selection=True, export_apply=True,
                              export_yup=True, export_materials='EXPORT', export_extras=True)

# ── 운반 AMR (0.95 × 1.45m, 지그 상판 높이 0.9m) ─────────────────
def build_amr():
    R = empty('AMR')
    box('Body', (0.93, 1.43, 0.26), (0, 0, 0.24), MATS['Shell'], bevel=0.05, parent=R)
    box('Skirt', (0.97, 1.47, 0.08), (0, 0, 0.09), MATS['Bumper'], bevel=0.025, parent=R)
    for s in (-1, 1):
        box(f'LED_{s}', (0.86, 0.02, 0.035), (0, s * 0.725, 0.3), MATS['LED'], parent=R)          # 앞뒤 상태등 띠
        box(f'Stripe_{s}', (0.012, 1.1, 0.05), (s * 0.466, 0, 0.26), MATS['Accent'], parent=R)    # 옆 파란 띠
        for y in (-0.5, 0.5): cyl(f'Caster_{s}_{y}', 0.055, 0.04, (s * 0.38, y, 0.055), MATS['Rubber'], axis='X', parent=R, verts=20)
    cyl('Lidar', 0.09, 0.07, (0, -0.55, 0.405), MATS['Lidar'], parent=R, verts=32, bevel=0.01)
    cyl('Lidar_Cap', 0.07, 0.02, (0, -0.55, 0.45), MATS['ShellDark'], parent=R)
    cyl('Lift', 0.11, 0.48, (0, 0.05, 0.6), MATS['Steel'], parent=R, verts=32)
    cyl('Lift_Collar', 0.15, 0.04, (0, 0.05, 0.38), MATS['ShellDark'], parent=R)
    box('Jig', (0.8, 1.1, 0.05), (0, 0.05, 0.875), MATS['ShellDark'], bevel=0.012, parent=R)
    for x, y in ((-0.36, 0.55), (0.36, 0.55), (-0.36, -0.45), (0.36, -0.45)): cyl(f'Pin_{x}_{y}', 0.025, 0.07, (x, y, 0.92), MATS['Yellow'], parent=R, verts=16)
    box('Display', (0.22, 0.012, 0.1), (0.3, -0.716, 0.22), MATS['Glass'], parent=R)
    export(R, 'amr')

# ── AGV (1.1 × 1.5m, 적재 플랫폼 높이 0.44m — 팔레트·박스는 코드가 그린다) ─────────────────
def build_agv():
    R = empty('AGV')
    box('Body', (1.08, 1.48, 0.28), (0, 0, 0.24), MATS['Shell'], bevel=0.05, parent=R)
    box('Skirt', (1.12, 1.52, 0.08), (0, 0, 0.09), MATS['Bumper'], bevel=0.025, parent=R)
    for s in (-1, 1):
        box(f'LED_{s}', (1.0, 0.02, 0.035), (0, s * 0.75, 0.31), MATS['LED'], parent=R)
        for k in range(5): box(f'Hazard_{s}_{k}', (0.14, 0.012, 0.06), (-0.4 + k * 0.2, s * 0.758, 0.2), MATS['Yellow'] if k % 2 else MATS['Bumper'], parent=R, rot=(0, 0.6, 0))
        for y in (-0.55, 0.55): cyl(f'Wheel_{s}_{y}', 0.07, 0.05, (s * 0.48, y, 0.07), MATS['Rubber'], axis='X', parent=R, verts=24)
    box('Deck', (1.0, 1.3, 0.035), (0, -0.05, 0.42), MATS['Steel'], bevel=0.01, parent=R)
    for x in (-0.3, 0, 0.3): box(f'Roller_{x}', (0.06, 1.2, 0.03), (x, -0.05, 0.44), MATS['ShellDark'], bevel=0.01, parent=R)
    cyl('Lidar', 0.1, 0.1, (0, -0.55, 0.43), MATS['Lidar'], parent=R, bevel=0.01)
    box('Emergency', (0.06, 0.06, 0.03), (0.45, -0.7, 0.4), mat('Red', srgb('#d23b3b'), 0.1, 0.4), parent=R)
    export(R, 'agv')

# ── 지게차 (차체 1.2 × 2.5m, 앞 = 포크 쪽 −Y) — 운전자·경광등·팔레트는 코드가 붙인다 ─────────────────
def build_forklift():
    R = empty('Forklift')
    orange = mat('ForkOrange', srgb('#f08a24'), 0.15, 0.38)
    D = MATS['ShellDark']; St = MATS['Steel']; Bk = MATS['Bumper']
    lamp = mat('Lamp', srgb('#fff2c0'), 0, 0.2, emit=srgb('#fff2c0'), strength=2.0)
    red = mat('ForkTail', srgb('#ff3030'), 0, 0.3, emit=srgb('#ff3030'), strength=1.2)
    # 차체: 하부 프레임 · 배터리 덮개(좌석 아래) · 앞 휀더 · 둥근 카운터웨이트
    box('Chassis', (1.18, 1.6, 0.42), (0, 0.22, 0.47), orange, bevel=0.07, parent=R)
    box('BatteryHood', (1.02, 0.85, 0.2), (0, 0.35, 0.78), orange, bevel=0.06, parent=R)
    box('Step', (0.9, 0.35, 0.05), (0, -0.25, 0.3), Bk, bevel=0.01, parent=R)
    for x in (-0.6, 0.6): box(f'Fender_{x}', (0.3, 0.75, 0.12), (x, -0.35, 0.64), orange, bevel=0.05, parent=R)
    box('Counterweight', (1.16, 0.6, 0.78), (0, 1.0, 0.62), D, bevel=0.2, parent=R)
    for x in (-0.42, 0.42): box(f'TailLamp_{x}', (0.12, 0.03, 0.07), (x, 1.302, 0.85), red, bevel=0.01, parent=R)
    # 운전석: 좌석·팔걸이·조향 기둥·핸들·레버
    box('Seat', (0.5, 0.45, 0.12), (0, 0.48, 0.95), Bk, bevel=0.045, parent=R)
    box('SeatBack', (0.5, 0.1, 0.48), (0, 0.7, 1.18), Bk, bevel=0.045, parent=R)
    for x in (-0.28, 0.28): box(f'Armrest_{x}', (0.06, 0.32, 0.05), (x, 0.5, 1.12), Bk, bevel=0.015, parent=R)
    cyl('SteerColumn', 0.04, 0.5, (0, -0.2, 1.05), D, parent=R, verts=24).rotation_euler = (0.5, 0, 0)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.17, minor_radius=0.018, location=(0, -0.08, 1.3), rotation=(0.5, 0, 0))
    finish(setname(bpy.context.active_object, 'Steering'), Bk, parent=R)
    for k, x in enumerate((-0.12, -0.04, 0.04)): cyl(f'Lever_{k}', 0.01, 0.22, (0.3 + x, -0.25, 1.0), Bk, parent=R, verts=12)
    for x, y in ((-0.6, -0.35), (0.6, -0.35)): wheel(f'Wheel_F_{x}', 0.3, 0.24, (x, y, 0.3), R)
    for x, y in ((-0.58, 0.8), (0.58, 0.8)): wheel(f'Wheel_R_{x}', 0.24, 0.2, (x, y, 0.24), R)
    # 마스트: 바깥·안쪽 레일 · 가로 보 · 리프트 실린더 · 틸트 실린더
    for x in (-0.45, 0.45):
        box(f'Mast_{x}', (0.1, 0.12, 2.25), (x, -0.75, 1.27), D, bevel=0.015, parent=R)
        box(f'MastInner_{x}', (0.07, 0.08, 2.1), (x * 0.82, -0.78, 1.3), D, bevel=0.01, parent=R)
        cyl(f'TiltCyl_{x}', 0.035, 0.5, (x * 0.9, -0.5, 0.8), St, parent=R, verts=16).rotation_euler = (1.2, 0, 0)
    box('Mast_Top', (1.0, 0.08, 0.08), (0, -0.75, 2.36), D, bevel=0.015, parent=R)
    box('Mast_Mid', (0.9, 0.06, 0.06), (0, -0.75, 1.45), D, bevel=0.01, parent=R)
    cyl('LiftCyl', 0.05, 1.7, (0, -0.7, 1.15), St, parent=R, verts=24, bevel=0.005)
    # 캐리지 · 짐받이(로드 백레스트) · 포크
    box('Carriage', (0.98, 0.07, 0.42), (0, -0.83, 0.42), D, bevel=0.015, parent=R)
    box('Backrest_Top', (0.98, 0.04, 0.04), (0, -0.86, 1.25), D, parent=R)
    for k in range(6): box(f'Backrest_{k}', (0.03, 0.03, 0.62), (-0.45 + k * 0.18, -0.86, 0.94), D, parent=R)
    for x in (-0.3, 0.3):
        box(f'Fork_{x}', (0.12, 1.1, 0.05), (x, -1.32, 0.15), St, bevel=0.01, parent=R)
        box(f'ForkHeel_{x}', (0.12, 0.05, 0.42), (x, -0.85, 0.34), St, bevel=0.01, parent=R)
        box(f'Chain_{x}', (0.03, 0.03, 2.0), (x * 0.5, -0.72, 1.2), MATS['Hub'], parent=R)
    # 오버헤드 가드: 원형 기둥(앞쪽은 기울임) · 지붕 판 · 격자
    box('Guard', (1.18, 1.3, 0.05), (0, 0.4, 2.1), D, bevel=0.02, parent=R)
    for x, y in ((-0.55, -0.2), (0.55, -0.2), (-0.55, 1.0), (0.55, 1.0)):
        c = cyl(f'Post_{x}_{y}', 0.035, 1.3, (x, y, 1.45), D, parent=R, verts=20)
        if y < 0: c.rotation_euler = (-0.12, 0, 0)
    for k in range(5): box(f'GuardBar_{k}', (1.12, 0.03, 0.03), (0, -0.2 + k * 0.3, 2.07), D, parent=R)
    for x in (-0.45, 0.45): box(f'Headlight_{x}', (0.12, 0.04, 0.09), (x, -0.62, 1.95), lamp, bevel=0.015, parent=R)
    box('BlueSpot', (0.08, 0.04, 0.05), (0, 1.0, 2.0), mat('BlueSpotLamp', srgb('#2a8cff'), 0, 0.2, emit=srgb('#2a8cff'), strength=2.0), parent=R)
    export(R, 'forklift')

# ── 화물트럭 (길이 10.5m · 폭 2.5m, 3D 모델과 같은 치수) — 캡오버 운전석 + 커튼 사이더 적재함 (특정 회사 모델이 아닌 일반형)
# 코드가 쓰는 부분: 재질 CabPaint(트럭마다 색) · TAIL(후미등 — 후진 시 흰색 점멸) · Tarp(반투명 커튼), 빈 객체 Door_L/Door_R(뒷문 경첩 — 코드가 연다)
# 좌표는 three.js 기준(x, y 위, z 앞 = 운전석)으로 적고 T()로 Blender 좌표로 바꾼다
def build_truck():
    L, W = 10.5, 2.5
    T = lambda x, y, z: (x, -z, y)
    S = lambda w, h, d: (w, d, h)
    paint = mat('CabPaint', srgb('#2a6fdb'), 0.35, 0.3)
    D = MATS['ShellDark']; St = MATS['Steel']; G = MATS['Glass']; Bk = MATS['Bumper']
    white = mat('BoxWhite', srgb('#e8ecf0'), 0.1, 0.45)
    tarp = mat('Tarp', srgb('#dfe6ee'), 0.0, 0.7, alpha=0.32)
    strap = mat('Strap', srgb('#3b4250'), 0.0, 0.6)
    lamp = mat('Lamp', srgb('#fff2c0'), 0, 0.2, emit=srgb('#fff2c0'), strength=2.0)
    tail = mat('TAIL', srgb('#ff3030'), 0, 0.3, emit=srgb('#ff3030'), strength=1.2)
    amber = mat('Amber', srgb('#ffa020'), 0, 0.3, emit=srgb('#ffa020'), strength=1.0)
    R = empty('Truck')
    def B(n, size, loc, m, bevel=0.0, rot=(0, 0, 0)): return box(n, S(*size), T(*loc), m, bevel=bevel, parent=R, rot=rot)
    cz = L / 2 - 1.15
    # 운전석(캡오버)
    B('CabLower', (W, 1.45, 2.2), (0, 1.27, cz), paint, bevel=0.1)
    B('CabUpper', (W - 0.04, 1.05, 2.05), (0, 2.5, cz - 0.07), paint, bevel=0.16)
    B('Deflector', (W - 0.3, 0.5, 1.3), (0, 3.2, cz - 0.35), paint, bevel=0.22)
    B('Windshield', (W - 0.3, 0.82, 0.04), (0, 2.5, cz + 0.96), G, bevel=0.02)
    for sd in (-1, 1):
        B(f'SideWindow_{sd}', (0.04, 0.6, 0.85), (sd * (W / 2 - 0.0), 2.55, cz + 0.4), G, bevel=0.01)
        B(f'MirrorArm_{sd}', (0.32, 0.04, 0.04), (sd * (W / 2 + 0.14), 2.45, cz + 0.95), D)
        B(f'Mirror_{sd}', (0.07, 0.5, 0.22), (sd * (W / 2 + 0.3), 2.3, cz + 0.95), D, bevel=0.02)
        B(f'Step_{sd}', (0.12, 0.05, 0.5), (sd * (W / 2 - 0.02), 0.62, cz + 0.45), St)
        B(f'Headlight_{sd}', (0.38, 0.18, 0.05), (sd * 0.85, 0.95, cz + 1.12), lamp, bevel=0.02)
        B(f'Indicator_{sd}', (0.12, 0.1, 0.05), (sd * 1.12, 0.95, cz + 1.1), amber, bevel=0.01)
        B(f'MarkerLight_{sd}', (0.1, 0.06, 0.05), (sd * 0.9, 3.42, cz + 0.25), amber)
        B(f'FrontFender_{sd}', (0.42, 0.1, 1.15), (sd * 1.05, 1.0, L / 2 - 1.3), Bk, bevel=0.03)
    B('Grille', (1.55, 0.6, 0.04), (0, 1.3, cz + 1.11), D, bevel=0.02)
    for k in range(5): B(f'GrilleBar_{k}', (1.45, 0.03, 0.03), (0, 1.07 + k * 0.115, cz + 1.135), St)
    B('Bumper', (W, 0.35, 0.3), (0, 0.55, cz + 1.0), D, bevel=0.06)
    # 섀시 · 연료탱크 · 바퀴 · 뒤 휀더 · 측면 보호대
    B('Chassis', (W - 0.4, 0.3, L - 0.3), (0, 0.6, 0), D)
    c = cyl('FuelTank', 0.3, 1.1, T(-1.0, 0.72, 2.35), St, axis='Y', parent=R, verts=40, bevel=0.03)
    B('FuelStrap', (0.62, 0.62, 0.04), (-1.0, 0.72, 2.35), D)
    for z in (L / 2 - 1.3, -L / 2 + 1.0, -L / 2 + 2.2):
        for x in (-1.05, 1.05): wheel(f'Wheel_{x}_{round(z, 2)}', 0.48, 0.34, T(x, 0.48, z), R)
    for sd in (-1, 1):
        B(f'RearFender_{sd}', (0.42, 0.06, 2.5), (sd * 1.05, 1.03, -L / 2 + 1.6), Bk, bevel=0.02)
        B(f'SideGuard_{sd}', (0.04, 0.22, 3.6), (sd * 1.16, 0.75, -0.6), St)
    # 적재함 (길이 7.8m, 중심 z = −L/2 + 3.9)
    bz = -L / 2 + 3.9
    B('CargoFloor', (W, 0.14, 7.8), (0, 1.2, bz), St)
    B('FrontWall', (W, 2.6, 0.1), (0, 2.55, bz + 3.85), white, bevel=0.02)
    for sd in (-1, 1):
        B(f'Tarp_{sd}', (0.05, 2.6, 7.8), (sd * W / 2, 2.55, bz), tarp)
        B(f'TopRail_{sd}', (0.08, 0.1, 7.9), (sd * W / 2, 3.86, bz), St, bevel=0.01)
        B(f'BottomRail_{sd}', (0.08, 0.12, 7.9), (sd * W / 2, 1.24, bz), St, bevel=0.01)
        for k in range(12): B(f'Strap_{sd}_{k}', (0.02, 2.45, 0.05), (sd * (W / 2 + 0.03), 2.55, bz - 3.6 + k * 0.655), strap)
        for z in (-3.85, -1.3, 1.3): B(f'BoxPost_{sd}_{z}', (0.08, 2.6, 0.08), (sd * W / 2, 2.55, bz + z), St)
    B('TarpRoof', (W, 0.05, 7.8), (0, 3.86, bz), tarp)
    B('RearHeader', (W + 0.04, 0.16, 0.1), (0, 3.86, bz - 3.9), St, bevel=0.01)
    B('RearBumper', (W, 0.12, 0.12), (0, 1.25, bz - 4.02), MATS['Yellow'], bevel=0.02)
    for sd, side in ((-1, 'L'), (1, 'R')):
        d = empty(f'Door_{side}', T(sd * W / 2, 2.55, bz - 3.9), R)
        box(f'DoorPanel_{side}', S(W / 2, 2.6, 0.06), (-sd * W / 4, 0, 0), white, bevel=0.015, parent=d)
        for k in (0.25, 0.75): box(f'DoorBar_{side}_{k}', S(0.04, 2.5, 0.04), (-sd * W / 2 * k, 0.04, 0), St, parent=d)
        box(f'DoorHandle_{side}', S(0.05, 0.25, 0.05), (-sd * (W / 2 - 0.12), 0.06, -0.2), D, parent=d)
        B(f'Tail_{side}', (0.25, 0.14, 0.05), (sd * 1.0, 1.0, -L / 2 - 0.02), tail, bevel=0.01)
    export(R, 'truck')

# ── 순찰 드론 (대각 약 1.1m) — 로터는 Rotor_0~3 (코드가 회전), 항법등 재질 NAV_R·NAV_G·STROBE ─────────────────
def build_drone():
    R = empty('Drone')
    shell = mat('DroneShell', srgb('#d6dbe1'), 0.1, 0.35)
    box('Body', (0.4, 0.5, 0.13), (0, 0, 0), shell, bevel=0.05, parent=R)
    box('Canopy', (0.28, 0.34, 0.06), (0, 0, 0.08), MATS['Accent'], bevel=0.03, parent=R)
    box('Battery', (0.2, 0.3, 0.05), (0, 0.04, 0.12), MATS['ShellDark'], bevel=0.015, parent=R)
    blade = mat('Blade', srgb('#2a2f36'), 0.2, 0.4)
    disc = mat('RotorDisc', srgb('#9aa4ad'), 0.0, 0.5, alpha=0.3)
    for i, (sx, sy) in enumerate(((1, -1), (-1, -1), (1, 1), (-1, 1))):   # three 순서: (+x,+z) (−x,+z) (+x,−z) (−x,−z)
        ang = math.atan2(sx, sy)
        box(f'Arm_{i}', (0.05, 0.5, 0.035), (sx * 0.2, sy * 0.2, 0.02), MATS['ShellDark'], bevel=0.012, parent=R, rot=(0, 0, -ang))
        cyl(f'Motor_{i}', 0.045, 0.08, (sx * 0.38, sy * 0.38, 0.06), MATS['Hub'], parent=R, verts=24, bevel=0.008)
        rot = empty(f'Rotor_{i}', (sx * 0.38, sy * 0.38, 0.11), parent=R)
        cyl(f'Disc_{i}', 0.2, 0.004, (0, 0, 0), disc, parent=rot, verts=48)
        for k in (0, 1):
            b = box(f'Blade_{i}_{k}', (0.19, 0.03, 0.006), (0.095 * (1 if k else -1), 0, 0.006), blade, bevel=0.002, parent=rot)
            b.rotation_euler = (0.15 * (1 if k else -1), 0, 0)
    for sx in (-1, 1):
        for sy in (-1, 1): box(f'Leg_{sx}_{sy}', (0.02, 0.02, 0.16), (sx * 0.15, sy * 0.12, -0.14), MATS['ShellDark'], parent=R)
        box(f'Skid_{sx}', (0.03, 0.42, 0.02), (sx * 0.15, 0, -0.22), MATS['ShellDark'], bevel=0.008, parent=R)
    g = empty('Gimbal', (0, -0.2, -0.12), parent=R)
    sphere('Gimbal_Ball', 0.07, (0, 0, 0), MATS['ShellDark'], parent=g)
    cyl('Gimbal_Lens', 0.03, 0.04, (0, -0.06, 0), MATS['Lidar'], axis='Y', parent=g)
    sphere('NavR', 0.03, (-0.38, -0.38, 0), mat('NAV_R', srgb('#ff3030'), 0, 0.3, emit=srgb('#ff3030'), strength=3), parent=R, seg=12)
    sphere('NavG', 0.03, (0.38, -0.38, 0), mat('NAV_G', srgb('#3dff8a'), 0, 0.3, emit=srgb('#3dff8a'), strength=3), parent=R, seg=12)
    sphere('Strobe', 0.035, (0, 0.24, 0.13), mat('STROBE', srgb('#ffffff'), 0, 0.3, emit=srgb('#ffffff'), strength=0.5), parent=R, seg=12)
    export(R, 'drone')

# ── 휴머노이드 (키 약 1.98m) — Boston Dynamics 전동식 Atlas의 분위기(회색 외장·짙은 관절·원형 얼굴판 링 조명)를 참고한 독자 디자인
# 관절 = 빈 객체 (코드가 rotation.x로 움직인다): Body(걸음 상하) · Waist(허리) · Head · Shoulder_L/R · Elbow_L/R · Hip_L/R · Knee_L/R
# 재질 VISOR(얼굴 링 조명 — 코드가 상태색으로 바꿈) · ACC(가슴 상태등 — 역할색)
def taper(name, r_bot, r_top, depth, loc, m, parent, verts=40, bevel=0.0):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r_bot, radius2=r_top, depth=depth, location=loc)
    return finish(setname(bpy.context.active_object, name), m, bevel, seg=3, parent=parent)
def build_humanoid():
    shell = mat('AtlasShell', srgb('#c9ced4'), 0.15, 0.36)
    joint = mat('AtlasJoint', srgb('#2a2e34'), 0.55, 0.38)
    panel = mat('AtlasPanel', srgb('#4a5058'), 0.3, 0.45)
    visor = mat('VISOR', srgb('#37e8ff'), 0.0, 0.2, emit=srgb('#37e8ff'), strength=2.5)
    acc = mat('ACC', srgb('#ff8a2a'), 0.0, 0.3, emit=srgb('#ff8a2a'), strength=1.5)
    R = empty('Humanoid'); B = empty('Body', (0, 0, 0), R)
    # 골반 · 고관절 액추에이터
    box('Pelvis', (0.3, 0.18, 0.16), (0, 0, 0.98), joint, bevel=0.045, parent=B)
    box('PelvisCover', (0.24, 0.02, 0.1), (0, -0.095, 0.98), panel, bevel=0.008, parent=B)
    for sd, side in ((-1, 'L'), (1, 'R')):
        x = sd * 0.12
        cyl(f'HipAct_{side}', 0.075, 0.09, (sd * 0.17, 0, 0.94), joint, axis='X', parent=B, verts=40, bevel=0.012)
        H = empty(f'Hip_{side}', (x, 0, 0.92), B)
        taper(f'Thigh_{side}', 0.062, 0.088, 0.36, (0, 0, -0.21), shell, H, bevel=0.03)
        box(f'ThighPanel_{side}', (0.1, 0.03, 0.22), (0, -0.075, -0.2), panel, bevel=0.012, parent=H)
        K = empty(f'Knee_{side}', (0, 0, -0.43), H)
        cyl(f'KneeAct_{side}', 0.062, 0.13, (0, 0, 0), joint, axis='X', parent=K, verts=40, bevel=0.012)
        box(f'KneeCap_{side}', (0.09, 0.05, 0.09), (0, -0.055, 0.01), shell, bevel=0.022, parent=K)
        taper(f'Shin_{side}', 0.045, 0.06, 0.36, (0, 0.01, -0.21), shell, K, bevel=0.025)
        box(f'Calf_{side}', (0.07, 0.06, 0.2), (0, 0.05, -0.14), joint, bevel=0.02, parent=K)
        sphere(f'Ankle_{side}', 0.045, (0, 0, -0.43), joint, parent=K, seg=24)
        box(f'Foot_{side}', (0.12, 0.27, 0.06), (0, -0.045, -0.46), joint, bevel=0.025, parent=K)
        box(f'FootTop_{side}', (0.1, 0.16, 0.02), (0, -0.07, -0.425), panel, bevel=0.008, parent=K)
    # 허리 위 상체
    W = empty('Waist', (0, 0, 1.0), B)
    cyl('WaistAct', 0.1, 0.14, (0, 0, 0.07), joint, parent=W, verts=40, bevel=0.015)
    box('Abdomen', (0.28, 0.2, 0.14), (0, 0, 0.17), shell, bevel=0.05, parent=W)
    box('Chest', (0.38, 0.25, 0.32), (0, 0, 0.37), shell, bevel=0.085, parent=W)
    box('ChestPanel', (0.22, 0.02, 0.14), (0, -0.126, 0.38), panel, bevel=0.01, parent=W)
    box('ChestLight', (0.15, 0.012, 0.025), (0, -0.138, 0.41), acc, bevel=0.004, parent=W)
    box('Backpack', (0.26, 0.1, 0.3), (0, 0.16, 0.33), joint, bevel=0.035, parent=W)
    for k in range(3): box(f'Vent_{k}', (0.18, 0.012, 0.012), (0, 0.212, 0.26 + k * 0.05), panel, parent=W)
    box('Yoke', (0.46, 0.16, 0.09), (0, 0, 0.5), joint, bevel=0.035, parent=W)
    cyl('Neck', 0.05, 0.1, (0, 0, 0.59), joint, parent=W, verts=32)
    Hd = empty('Head', (0, 0, 0.79), W)
    cyl('HeadShell', 0.15, 0.13, (0, 0.005, 0), shell, axis='Y', parent=Hd, verts=64, bevel=0.035)
    sphere('HeadBack', 0.12, (0, 0.05, 0), shell, parent=Hd, seg=40)
    f = cyl('Face', 0.12, 0.01, (0, -0.062, 0), MATS['Glass'], axis='Y', parent=Hd, verts=64)
    for p in f.data.polygons: p.use_smooth = False   # 평평한 얼굴판 (부드러운 셰이딩이면 가운데가 얼룩진다)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.106, minor_radius=0.009, major_segments=64, minor_segments=12, location=(0, -0.068, 0), rotation=(math.pi / 2, 0, 0))
    finish(setname(bpy.context.active_object, 'FaceRing'), visor, parent=Hd)
    cyl('HeadNeckMount', 0.06, 0.05, (0, 0, -0.14), joint, parent=Hd, verts=32)
    for sd, side in ((-1, 'L'), (1, 'R')):
        S = empty(f'Shoulder_{side}', (sd * 0.27, 0, 0.52), W)
        sphere(f'ShoulderAct_{side}', 0.078, (0, 0, 0), joint, parent=S, seg=32)
        cyl(f'ShoulderCap_{side}', 0.088, 0.07, (sd * 0.035, 0, 0), shell, axis='X', parent=S, verts=48, bevel=0.025)
        taper(f'UpperArm_{side}', 0.05, 0.062, 0.26, (0, 0, -0.17), shell, S, bevel=0.022)
        E = empty(f'Elbow_{side}', (0, 0, -0.32), S)
        cyl(f'ElbowAct_{side}', 0.048, 0.1, (0, 0, 0), joint, axis='X', parent=E, verts=32, bevel=0.01)
        taper(f'Forearm_{side}', 0.04, 0.05, 0.22, (0, 0, -0.13), shell, E, bevel=0.018)
        cyl(f'Wrist_{side}', 0.034, 0.04, (0, 0, -0.26), joint, parent=E, verts=24)
        box(f'Palm_{side}', (0.04, 0.085, 0.09), (0, 0, -0.32), joint, bevel=0.014, parent=E)
        for f, y in enumerate((-0.03, -0.01, 0.01, 0.03)):
            box(f'Finger_{side}_{f}', (0.022, 0.017, 0.065), (0, y, -0.395), joint, bevel=0.006, parent=E)
        box(f'Thumb_{side}', (0.02, 0.02, 0.05), (-sd * 0.025, -0.045, -0.33), joint, bevel=0.006, parent=E, rot=(0.4, 0, 0))
    export(R, 'humanoid')

# ── 사족보행 로봇 (몸통 약 0.95m) — Boston Dynamics Spot의 분위기(노란 상판 외장 · 짙은 몸체 · 앞 스테레오 카메라 · 뒤로 꺾인 무릎)를 참고한 독자 디자인
# 관절 = 빈 객체: Body(높이 0.55m) · Hip_0~3 · Knee_0~3 (코드가 rotation.x로 대각 보행) · Cam(센서 마스트 머리 — 코드가 좌우로 돌림)
# 다리 순서 = 3D 모델: 0 (−x 앞) · 1 (+x 앞) · 2 (−x 뒤) · 3 (+x 뒤). 정강이는 코드의 기본 무릎 각(0.15rad)에서 발이 바닥에 닿도록 놓았다
def build_quadruped():
    yel = mat('SpotYellow', srgb('#f2c230'), 0.1, 0.38)
    dark = mat('SpotDark', srgb('#24282e'), 0.4, 0.42)
    leg = mat('SpotLeg', srgb('#1a1d21'), 0.45, 0.4)
    thermal = mat('THERMAL', srgb('#ff6a3d'), 0.0, 0.3, emit=srgb('#ff6a3d'), strength=2.0)
    R = empty('Quadruped'); B = empty('Body', (0, 0, 0.55), R)
    box('Core', (0.32, 0.86, 0.17), (0, 0, -0.01), dark, bevel=0.04, parent=B)
    box('TopShell', (0.37, 0.8, 0.07), (0, 0, 0.075), yel, bevel=0.03, parent=B)
    for sd in (-1, 1):
        box(f'SidePanel_{sd}', (0.025, 0.56, 0.11), (sd * 0.17, 0, 0.0), yel, bevel=0.01, parent=B)
        box(f'Rail_{sd}', (0.02, 0.56, 0.015), (sd * 0.09, 0, 0.118), dark, parent=B)
        box(f'SideCam_{sd}', (0.008, 0.07, 0.03), (sd * 0.186, -0.12, 0.0), MATS['Glass'], parent=B)
    box('Nose', (0.3, 0.12, 0.15), (0, -0.47, -0.005), dark, bevel=0.045, parent=B)
    box('NoseCap', (0.26, 0.05, 0.05), (0, -0.46, 0.075), yel, bevel=0.018, parent=B)
    for sd in (-1, 1):
        box(f'StereoCam_{sd}', (0.07, 0.01, 0.035), (sd * 0.065, -0.531, -0.005), MATS['Glass'], bevel=0.004, parent=B)
    box('Tail', (0.28, 0.1, 0.14), (0, 0.46, -0.005), dark, bevel=0.04, parent=B)
    box('TailCam', (0.08, 0.01, 0.03), (0, 0.512, 0.0), MATS['Glass'], parent=B)
    cyl('Mast', 0.025, 0.35, (0.08, 0.2, 0.27), dark, parent=B, verts=24)
    C = empty('Cam', (0.08, 0.2, 0.47), B)
    box('CamHead', (0.16, 0.14, 0.12), (0, 0, 0), dark, bevel=0.025, parent=C)
    box('CamHood', (0.17, 0.1, 0.02), (0, -0.01, 0.07), yel, bevel=0.008, parent=C)
    cyl('ThermalLens', 0.035, 0.05, (0, -0.08, 0), thermal, axis='Y', parent=C, verts=32)
    cyl('AcousticArray', 0.022, 0.03, (0.05, -0.075, -0.025), MATS['Glass'], axis='Y', parent=C, verts=24)
    for i, (x, zf) in enumerate(((-0.21, 0.36), (0.21, 0.36), (-0.21, -0.36), (0.21, -0.36))):
        sd = -1 if x < 0 else 1
        H = empty(f'Hip_{i}', (x, -zf, -0.05), B)
        cyl(f'HipAct_{i}', 0.062, 0.09, (0, 0, 0), dark, axis='X', parent=H, verts=40, bevel=0.012)
        box(f'HipCap_{i}', (0.02, 0.1, 0.1), (sd * 0.05, 0, 0), yel, bevel=0.012, parent=H)
        box(f'Thigh_{i}', (0.075, 0.095, 0.32), (0, 0.072, -0.1315), leg, bevel=0.03, parent=H, rot=(0.5, 0, 0))
        K = empty(f'Knee_{i}', (0, 0.144, -0.263), H)
        cyl(f'KneeAct_{i}', 0.04, 0.08, (0, 0, 0), dark, axis='X', parent=K, verts=32, bevel=0.008)
        box(f'Shin_{i}', (0.045, 0.05, 0.26), (0, -0.0865, -0.0915), leg, bevel=0.018, parent=K, rot=(-0.757, 0, 0))
        sphere(f'Foot_{i}', 0.036, (0, -0.173, -0.183), MATS['Rubber'], parent=K, seg=24)
    export(R, 'quadruped')

# ── 6축 협동로봇 팔 (배율 1 = 3D 모델의 makeArm 치수: 베이스 0.4 · 어깨 0.42 · 상완 1.1 · 전완 0.9 · 플랜지 0.13m)
# Rainbow Robotics RB20-1900의 분위기(흰 원통 관절 하우징 · 짙은 관절 캡 · 가는 원통 링크)를 참고한 독자 디자인
# 관절마다 따로 내보낸다: Seg_Base · Seg_Turret(J1) · Seg_Shoulder(J2) · Seg_Elbow(J3) · Seg_Wrist(J4) · Seg_Wrist2(J5) · Seg_Flange(J6)
# 각 마디는 자기 관절 회전 중심이 원점 — 코드가 마디를 관절 그룹에 붙이고 배율(s)만 곱한다 (관절 계층·역기구학은 3D 모델 그대로)
def build_arm6():
    W = mat('ArmWhite', srgb('#e8ebee'), 0.1, 0.32)
    D = mat('ArmDark', srgb('#363b42'), 0.4, 0.4)
    A = mat('ArmAcc', srgb('#2a7fff'), 0.1, 0.35)
    St = MATS['Steel']
    R = empty('Arm6')
    def seg(name): return empty(name, (0, 0, 0), R)
    def jointX(pfx, r, w, z, parent):   # 좌우(X)축 관절 하우징 + 양쪽 캡 + 가는 색 링
        cyl(pfx, r, w, (0, 0, z), W, axis='X', parent=parent, verts=64, bevel=r * 0.12)
        for sd in (-1, 1):
            cyl(f'{pfx}_Cap_{sd}', r * 0.96, 0.025, (sd * (w / 2 + 0.008), 0, z), D, axis='X', parent=parent, verts=64, bevel=0.006)
            cyl(f'{pfx}_Ring_{sd}', r * 0.55, 0.006, (sd * (w / 2 + 0.022), 0, z), A, axis='X', parent=parent, verts=48)
    b = seg('Seg_Base')
    cyl('BasePlate', 0.3, 0.04, (0, 0, 0.02), D, parent=b, verts=64, bevel=0.01)
    cyl('BaseBody', 0.22, 0.34, (0, 0, 0.21), W, parent=b, verts=64, bevel=0.025)
    cyl('BaseRing', 0.226, 0.03, (0, 0, 0.385), D, parent=b, verts=64)
    t = seg('Seg_Turret')
    cyl('J1Body', 0.2, 0.26, (0, 0, 0.13), W, parent=t, verts=64, bevel=0.03)
    jointX('J2Housing', 0.19, 0.36, 0.42, t)
    sh = seg('Seg_Shoulder')
    cyl('UpperLink', 0.1, 0.86, (0, 0, 0.55), W, parent=sh, verts=48, bevel=0.01)
    cyl('UpperCollarA', 0.125, 0.07, (0, 0, 0.2), W, parent=sh, verts=48, bevel=0.015)
    cyl('UpperCollarB', 0.125, 0.07, (0, 0, 0.92), W, parent=sh, verts=48, bevel=0.015)
    cyl('UpperBand', 0.102, 0.02, (0, 0, 0.55), D, parent=sh, verts=48)
    e = seg('Seg_Elbow')
    jointX('J3Housing', 0.145, 0.3, 0.0, e)
    cyl('ForeLink', 0.075, 0.66, (0, 0, 0.45), W, parent=e, verts=48, bevel=0.008)
    cyl('ForeCollar', 0.095, 0.06, (0, 0, 0.16), W, parent=e, verts=48, bevel=0.012)
    cyl('ForeCollarB', 0.095, 0.06, (0, 0, 0.77), W, parent=e, verts=48, bevel=0.012)
    w = seg('Seg_Wrist')
    jointX('J4Housing', 0.1, 0.22, 0.0, w)
    w2 = seg('Seg_Wrist2')
    cyl('J5Housing', 0.085, 0.18, (0, 0, 0.065), W, axis='Y', parent=w2, verts=48, bevel=0.012)
    for sd in (-1, 1): cyl(f'J5Cap_{sd}', 0.082, 0.02, (0, sd * 0.098, 0.065), D, axis='Y', parent=w2, verts=48, bevel=0.005)
    f = seg('Seg_Flange')
    cyl('J6Body', 0.07, 0.07, (0, 0, -0.005), D, parent=f, verts=48, bevel=0.008)
    cyl('ToolFlange', 0.052, 0.02, (0, 0, 0.04), St, parent=f, verts=48)
    box('GripperBody', (0.13, 0.08, 0.07), (0, 0, 0.085), D, bevel=0.015, parent=f)
    for sd in (-1, 1): box(f'Finger_{sd}', (0.022, 0.03, 0.07), (sd * 0.042, 0, 0.15), St, bevel=0.006, parent=f)
    export(R, 'arm6')

# ── AMMR 양팔 모바일 매니퓰레이터 — Rainbow Robotics RB-Y1의 분위기(둥근 바퀴형 이동 베이스 · 접히는 몸통 기둥 · 흰 가슴 · 카메라 머리)를 참고한 독자 디자인
# 빈 객체: Lift(몸통 승강 — 코드가 높이를 바꾼다) · Head(코드가 좌우로 돌림). 팔(6축)은 코드가 arm6 마디로 가슴 양옆(±0.33m)에 단다. 재질 LED = 상태등
def build_ammr():
    W = mat('ArmWhite', srgb('#e8ebee'), 0.1, 0.32)
    D = mat('ArmDark', srgb('#363b42'), 0.4, 0.4)
    R = empty('AMMR')
    box('BaseBody', (0.78, 0.62, 0.24), (0, 0, 0.22), W, bevel=0.1, parent=R)
    box('BaseBumper', (0.83, 0.67, 0.07), (0, 0, 0.075), D, bevel=0.03, parent=R)
    box('BaseTop', (0.6, 0.46, 0.02), (0, 0.02, 0.345), D, bevel=0.008, parent=R)
    for sd in (-1, 1):
        wheel(f'Drive_{sd}', 0.1, 0.06, (sd * 0.37, 0, 0.1), R)
        for yy in (-0.23, 0.23): sphere(f'Caster_{sd}_{yy}', 0.04, (sd * 0.26, yy, 0.04), MATS['Rubber'], parent=R, seg=16)
    box('LEDStrip', (0.62, 0.015, 0.025), (0, -0.33, 0.24), MATS['LED'], bevel=0.005, parent=R)
    cyl('Lidar', 0.065, 0.06, (0, -0.24, 0.38), MATS['Lidar'], parent=R, verts=40, bevel=0.01)
    L = empty('Lift', (0, 0.05, 0.35), R)
    cyl('ColumnLow', 0.09, 0.3, (0, 0, 0.15), W, parent=L, verts=48, bevel=0.015)
    cyl('ColumnKnee', 0.085, 0.2, (0, 0, 0.32), D, axis='X', parent=L, verts=48, bevel=0.012)
    box('ColumnHigh', (0.19, 0.16, 0.26), (0, 0, 0.47), W, bevel=0.05, parent=L)
    box('Chest', (0.46, 0.28, 0.3), (0, 0, 0.73), W, bevel=0.07, parent=L)
    box('ChestPanel', (0.28, 0.02, 0.13), (0, -0.142, 0.74), D, bevel=0.012, parent=L)
    box('ChestBand', (0.465, 0.285, 0.03), (0, 0, 0.6), D, bevel=0.01, parent=L)
    for sd in (-1, 1): cyl(f'ShoulderMount_{sd}', 0.075, 0.1, (sd * 0.27, 0, 0.7), D, axis='X', parent=L, verts=40, bevel=0.01)
    cyl('Neck', 0.045, 0.1, (0, 0, 0.9), D, parent=L, verts=32)
    H = empty('Head', (0, -0.02, 0.98), L)
    box('HeadShell', (0.24, 0.19, 0.17), (0, 0, 0), W, bevel=0.065, parent=H)
    box('HeadFace', (0.19, 0.012, 0.085), (0, -0.096, 0.005), MATS['Glass'], bevel=0.01, parent=H)
    cam = mat('HeadCam', srgb('#37e8ff'), 0.0, 0.2, emit=srgb('#37e8ff'), strength=2.0)
    for sd in (-1, 1): cyl(f'Stereo_{sd}', 0.017, 0.012, (sd * 0.05, -0.103, 0.008), cam, axis='Y', parent=H, verts=24)
    export(R, 'ammr')

# ── 직교 3축 갠트리 로봇 (산업용 일반형: 앵커 고정 철골 기둥 · T슬롯 알루미늄 프로파일 빔 · 리니어 가이드·랙 · 서보모터+감속기 · 케이블 체인 · 공압 그리퍼)
# 셀마다 X축 길이가 달라 부품별로 내보낸다 (좌표는 three.js 기준 — T()로 변환):
#   Post   기둥 1개 (원점 = 기둥 바닥 중심)        XBeam  X축 빔 (길이 1m — 코드가 셀 길이로 늘림, 높이 그대로)
#   Bridge X축 주행 브리지 (코드가 X로 움직임)      Carriage Y축 캐리지 (원점 = 캐리지 중심 y 2.7)      ZAxis 승강축 (원점 = 승강축 중심)
#   재질 GantryAcc = 캐리지 도장색 (코드가 셀 색으로 바꿈)
def build_gantry():
    T = lambda x, y, z: (x, -z, y)
    S = lambda w, h, d: (w, d, h)
    frame = mat('GantryFrame', srgb('#3c434c'), 0.45, 0.42)
    alu = mat('Alu', srgb('#d3d8de'), 0.45, 0.32)
    slot = mat('Slot', srgb('#262a30'), 0.3, 0.5)
    motor = mat('Motor', srgb('#16191d'), 0.5, 0.35)
    chainm = mat('CableChain', srgb('#1d2024'), 0.1, 0.6)
    acc = mat('GantryAcc', srgb('#f08a24'), 0.2, 0.38)
    St = MATS['Steel']; Y = MATS['Yellow']
    R = empty('Gantry')
    def part(n): return empty(n, (0, 0, 0), R)
    def B(n, size, loc, m, par, bevel=0.0, rot=(0, 0, 0)): return box(n, S(*size), T(*loc), m, bevel=bevel, parent=par, rot=rot)
    def C(n, r, h, loc, m, par, axis='Y3', verts=32, bevel=0.0):   # axis: three.js 축 (Y3 = 위아래, X3, Z3)
        return cyl(n, r, h, T(*loc), m, axis={'Y3': 'Z', 'X3': 'X', 'Z3': 'Y'}[axis], parent=par, verts=verts, bevel=bevel)
    def servo(n, loc, par, axis='Y3', length=0.22):   # 서보모터(검정 몸체 · 은색 플랜지 · 엔코더 캡)
        x, y, z = loc
        d = {'Y3': (0, 1, 0), 'X3': (1, 0, 0), 'Z3': (0, 0, 1)}[axis]
        C(n + '_Body', 0.058, length, loc, motor, par, axis, 32, 0.01)
        C(n + '_Flange', 0.068, 0.04, (x - d[0] * length / 2, y - d[1] * length / 2, z - d[2] * length / 2), alu, par, axis, 32)
        C(n + '_Cap', 0.045, 0.03, (x + d[0] * length / 2, y + d[1] * length / 2, z + d[2] * length / 2), slot, par, axis, 24)
    # 기둥
    P = part('Post')
    B('PostBase', (0.42, 0.03, 0.42), (0, 0.015, 0), frame, P, bevel=0.008)
    for bx in (-0.16, 0.16):
        for bz in (-0.16, 0.16): C(f'Anchor_{bx}_{bz}', 0.016, 0.05, (bx, 0.045, bz), St, P, verts=12)
    B('PostColumn', (0.16, 2.56, 0.16), (0, 1.31, 0), frame, P, bevel=0.012)
    for k, (gx, gz, w, d) in enumerate(((0, 0.081, 0.02, 0.004), (0, -0.081, 0.02, 0.004), (0.081, 0, 0.004, 0.02), (-0.081, 0, 0.004, 0.02))):
        B(f'PostSlot_{k}', (w, 2.4, d), (gx, 1.32, gz), slot, P)
    for sd in (-1, 1): B(f'Gusset_{sd}', (0.02, 0.22, 0.22), (sd * 0.09, 0.14, 0), frame, P, rot=(0, math.radians(45), 0))
    B('PostTop', (0.26, 0.03, 0.26), (0, 2.6, 0), frame, P, bevel=0.006)
    B('PostSign', (0.005, 0.18, 0.12), (0.082, 1.5, 0), Y, P)
    # X축 빔 (길이 1 — 코드가 늘림)
    X = part('XBeam')
    B('XProfile', (1, 0.18, 0.18), (0, 2.7, 0), alu, X)
    for sd in (-1, 1): B(f'XSlot_{sd}', (1, 0.022, 0.004), (0, 2.7, sd * 0.091), slot, X)
    B('XRail', (1, 0.03, 0.05), (0, 2.805, 0), St, X)
    B('XRack', (1, 0.035, 0.02), (0, 2.73, 0.1), slot, X)
    B('XChainTray', (1, 0.03, 0.14), (0, 2.6, -0.17), alu, X)
    B('XChain', (1, 0.07, 0.09), (0, 2.655, -0.17), chainm, X)
    # 브리지 (X축 주행)
    Bg = part('Bridge')
    B('YProfile', (0.24, 0.22, 3.4), (0, 2.92, 0), alu, Bg, bevel=0.012)
    for sd in (-1, 1): B(f'YSlot_{sd}', (0.004, 0.024, 3.3), (sd * 0.121, 2.92, 0), slot, Bg)
    B('YRail', (0.05, 0.03, 3.3), (0, 3.045, 0), St, Bg)
    B('YRack', (0.02, 0.035, 3.3), (0.13, 2.96, 0), slot, Bg)
    B('YChain', (0.09, 0.07, 1.8), (-0.17, 3.08, 0.75), chainm, Bg, bevel=0.01)
    for z in (-1.6, 1.6):
        B(f'Truck_{z}', (0.42, 0.06, 0.34), (0, 2.8, z), alu, Bg, bevel=0.01)
        B(f'TruckBlock_{z}', (0.16, 0.05, 0.12), (0, 2.85, z), St, Bg)
        B(f'EndCap_{z}', (0.26, 0.24, 0.02), (0, 2.92, z * 1.0625), slot, Bg)
        C(f'XGear_{z}', 0.065, 0.1, (0.22, 2.88, z + 0.1), alu, Bg, verts=32)
        servo(f'XServo_{z}', (0.22, 3.04, z + 0.1), Bg)
    # 캐리지 (Y축 이송, 원점 = 캐리지 중심)
    Cg = part('Carriage')
    B('CarPlate', (0.4, 0.32, 0.06), (0, 0, 0.17), acc, Cg, bevel=0.012)
    B('CarBody', (0.34, 0.28, 0.3), (0, 0, 0), acc, Cg, bevel=0.03)
    B('CarTop', (0.4, 0.04, 0.36), (0, 0.2, 0), alu, Cg, bevel=0.008)
    B('ZGuideBlock', (0.16, 0.36, 0.06), (0, -0.02, 0.0), St, Cg)
    servo('YServo', (0.12, 0.34, -0.08), Cg)
    servo('ZServo', (-0.1, 0.36, 0.08), Cg, length=0.26)
    B('CarLabel', (0.005, 0.08, 0.16), (0.172, 0.0, 0), Y, Cg)
    # 승강축 (원점 = 축 중심, 길이 1.0) · 공압 그리퍼
    Z = part('ZAxis')
    B('ZProfile', (0.1, 1.0, 0.1), (0, 0, 0), alu, Z, bevel=0.006)
    for sd in (-1, 1): B(f'ZSlot_{sd}', (0.004, 0.95, 0.02), (sd * 0.051, 0, 0), slot, Z)
    B('ZRail', (0.03, 0.96, 0.02), (0, 0, 0.06), St, Z)
    B('ZRack', (0.02, 0.96, 0.02), (0, 0, -0.06), slot, Z)
    B('ZStopTop', (0.14, 0.03, 0.14), (0, 0.5, 0), slot, Z)
    B('ToolFlange', (0.2, 0.03, 0.2), (0, -0.485, 0), alu, Z, bevel=0.005)
    B('GripperBody', (0.34, 0.06, 0.18), (0, -0.53, 0), MATS['ShellDark'], Z, bevel=0.012)
    C('GripperValve', 0.025, 0.06, (0.12, -0.47, 0.06), St, Z, verts=16)
    for sd in (-1, 1): B(f'GripFinger_{sd}', (0.03, 0.12, 0.16), (sd * 0.15, -0.6, 0), St, Z, bevel=0.006)
    export(R, 'gantry')

# ── e-axle (전기차 동축형 전동 구동축: 모터 + 감속기 + 인버터, 길이 1.04m · 지름 약 0.44m) — 축 = three.js x, 바닥(받침대) 원점
# 모터·감속기 하우징 앞 위쪽을 잘라낸 단면(cutaway)으로 고정자 철심 · 구리 권선 · 회전자 · 헬리컬 기어가 보인다
# 빈 객체 FastenBolts = 체결 공정 후에 보이는 플랜지 볼트 (코드가 켠다)
def build_eaxle():
    cz = 0.27
    cast = mat('CastAlu', srgb('#b9bfc6'), 0.55, 0.38)
    lam = mat('Lamination', srgb('#5d646e'), 0.5, 0.38)
    copper = mat('Copper', srgb('#d9823f'), 0.7, 0.28)
    gear = mat('GearSteel', srgb('#9aa2ab'), 0.95, 0.25)
    orange = mat('HVOrange', srgb('#ff7a1a'), 0.1, 0.4)
    inv = mat('InverterCase', srgb('#2c3138'), 0.4, 0.4)
    St = MATS['Steel']; Bk = MATS['Bumper']
    R = empty('Eaxle')
    def cx(n, r, L, x, m, y=0.0, z=cz, verts=64, bevel=0.0, par=R): return cyl(n, r, L, (x, y, z), m, axis='X', parent=par, verts=verts, bevel=bevel)
    def cut(o, lo, hi):   # 앞(−Y) 위(+Z) 사분면을 잘라낸다
        bpy.ops.mesh.primitive_cube_add(size=1); c = bpy.context.active_object
        c.scale = (hi - lo, 0.4, 0.4); c.location = ((lo + hi) / 2, -0.2, cz + 0.2)
        md = o.modifiers.new('Cut', 'BOOLEAN'); md.object = c; md.operation = 'DIFFERENCE'; md.solver = 'EXACT'
        bpy.context.view_layer.objects.active = o; bpy.ops.object.modifier_apply(modifier='Cut')
        bpy.data.objects.remove(c, do_unlink=True)
        return o
    def hollow(o, r_in, x, L):
        bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=r_in, depth=L, location=(x, 0, cz), rotation=(0, math.pi / 2, 0)); c = bpy.context.active_object
        md = o.modifiers.new('Hole', 'BOOLEAN'); md.object = c; md.operation = 'DIFFERENCE'; md.solver = 'EXACT'
        bpy.context.view_layer.objects.active = o; bpy.ops.object.modifier_apply(modifier='Hole')
        bpy.data.objects.remove(c, do_unlink=True)
        return o
    # 받침대 (V블록)
    for x in (-0.3, 0.3): box(f'Cradle_{x}', (0.1, 0.34, 0.1), (x, 0, 0.05), Bk, bevel=0.015, parent=R)
    # 모터부 (x −0.06 ~ 0.44): 하우징(속 빈 원통) · 냉각 리브 · 고정자 · 권선 · 회전자
    mh = cut(hollow(cx('MotorHousing', 0.19, 0.5, 0.19, cast), 0.172, 0.19, 0.46), 0.0, 0.4)
    for k in range(7):
        x = 0.03 + k * 0.055
        cut(hollow(cx(f'CoolingRib_{k}', 0.202, 0.016, x, cast, verts=64), 0.185, x, 0.03), -0.1, 0.42)
    cut(hollow(cx('Stator', 0.171, 0.3, 0.19, lam), 0.098, 0.19, 0.32), 0.0, 0.4)
    for x in (0.02, 0.36):
        bpy.ops.mesh.primitive_torus_add(major_radius=0.135, minor_radius=0.032, major_segments=48, minor_segments=12, location=(x, 0, cz), rotation=(0, math.pi / 2, 0))
        o = finish(setname(bpy.context.active_object, f'EndWinding_{x}'), copper, parent=R); cut(o, -0.1, 0.42)
    cx('Rotor', 0.09, 0.3, 0.19, lam, verts=48)
    for k in range(6): cx(f'RotorBand_{k}', 0.0915, 0.008, 0.06 + k * 0.052, St, verts=48)
    cx('Shaft', 0.035, 0.98, 0.0, St, verts=32)
    cx('MotorEndCap', 0.175, 0.04, 0.455, cast, bevel=0.01)
    # 감속기부 (x −0.48 ~ −0.06): 큰 하우징 · 아래 앞쪽 보조축 돌출 · 결합 플랜지 · 헬리컬 기어
    gh = cut(hollow(cx('GearHousing', 0.22, 0.42, -0.27, cast), 0.2, -0.27, 0.38), -0.44, -0.1)
    cut(cx('LayshaftBulge', 0.14, 0.34, -0.29, cast, y=-0.09, z=cz - 0.09, verts=48), -0.44, -0.1)
    cx('JointFlange', 0.24, 0.035, -0.065, cast, verts=64, bevel=0.006)
    for k in range(12):
        a = k * math.pi * 2 / 12
        cx(f'FlangeBolt_{k}', 0.012, 0.05, -0.065, St, y=math.cos(a) * 0.225, z=cz + math.sin(a) * 0.225, verts=6)
    for n, r, w, x in (('GearA', 0.16, 0.06, -0.22), ('GearB', 0.1, 0.05, -0.36)):
        g = cx(n, r, w, x, gear, verts=48)
        for k in range(36 if r > 0.12 else 24):   # 기어 이(헬리컬 느낌으로 약간 비틀어)
            a = k * math.pi * 2 / (36 if r > 0.12 else 24)
            box(f'{n}_T{k}', (w, 0.016, 0.02), (x, math.cos(a) * (r + 0.008), cz + math.sin(a) * (r + 0.008)), gear, parent=R, rot=(a, 0, 0.35))
    cx('GearShaft', 0.05, 0.3, -0.29, St, y=-0.09, z=cz - 0.09, verts=24)
    cx('GearHousingCap', 0.205, 0.035, -0.49, cast, bevel=0.01)
    # 출력 플랜지 (양 끝, 6각 볼트 플랜지)
    for sd, x0 in ((1, 0.475), (-1, -0.505)):
        cx(f'OutShaft_{sd}', 0.045, 0.05, x0 + sd * 0.01, St, verts=32)
        cx(f'OutFlange_{sd}', 0.085, 0.03, x0 + sd * 0.04, St, verts=6, bevel=0.006)
    # 인버터 (모터 위 뒤쪽) · 고전압 커넥터 · 케이블
    box('Inverter', (0.34, 0.2, 0.1), (0.2, 0.06, cz + 0.235), inv, bevel=0.02, parent=R)
    for k in range(5): box(f'InvRib_{k}', (0.3, 0.008, 0.015), (0.2, -0.02 + k * 0.04, cz + 0.292), inv, parent=R)
    box('HVConnector', (0.07, 0.06, 0.06), (0.04, 0.1, cz + 0.27), orange, bevel=0.01, parent=R)
    c = cyl('HVCable', 0.02, 0.2, (-0.06, 0.1, cz + 0.27), orange, axis='X', parent=R, verts=16)
    box('InvMount', (0.3, 0.12, 0.05), (0.2, 0.08, cz + 0.17), cast, parent=R)
    # 체결 볼트 (체결 공정 후 표시): 양 끝 덮개 둘레
    B = empty('FastenBolts', (0, 0, 0), R)
    for x, rr in ((0.48, 0.15), (-0.515, 0.17)):
        for k in range(8):
            a = k * math.pi * 2 / 8 + 0.2
            cyl(f'FBolt_{x}_{k}', 0.014, 0.03, (x, math.cos(a) * rr, cz + math.sin(a) * rr), MATS['Yellow'], axis='X', parent=B, verts=6)
    export(R, 'eaxle')

def preview_one(build, name, cam_loc, cam_rot, lens, res):
    reset(); MATS.clear(); common_mats(); build()
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0)); bpy.context.active_object.data.materials.append(mat('Floor', srgb('#8b9096'), 0, 0.8))
    cam = bpy.data.objects.new('Cam_', bpy.data.cameras.new('Cam_')); bpy.context.collection.objects.link(cam)
    cam.location = cam_loc; cam.rotation_euler = tuple(math.radians(a) for a in cam_rot); cam.data.lens = lens; bpy.context.scene.camera = cam
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); sun.data.energy = 3.5; sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(30)); bpy.context.collection.objects.link(sun)
    w = bpy.data.worlds.new('W'); bpy.context.scene.world = w; w.use_nodes = True; w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.06, 0.08, 1); w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8
    sc = bpy.context.scene; sc.render.engine = 'BLENDER_EEVEE'; sc.render.resolution_x, sc.render.resolution_y = res; sc.render.filepath = os.path.join(OUT, f'preview_{name}.png')
    bpy.ops.render.render(write_still=True)

def build_truck_fork():   # 미리보기용: 트럭 옆에 지게차
    build_truck(); before = set(bpy.data.objects); build_forklift()
    for o in bpy.data.objects:
        if o not in before and o.parent is None: o.location = (3.2, -1.0, 0); o.rotation_euler = (0, 0, math.radians(-35))

def preview_humanoid():
    reset(); MATS.clear(); common_mats(); build_humanoid()
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0)); bpy.context.active_object.data.materials.append(mat('Floor', srgb('#8b9096'), 0, 0.8))
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); bpy.context.collection.objects.link(cam)
    cam.location = (1.6, -3.6, 1.55); cam.rotation_euler = (math.radians(86), 0, math.radians(24)); cam.data.lens = 50; bpy.context.scene.camera = cam
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); sun.data.energy = 3.5; sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(30)); bpy.context.collection.objects.link(sun)
    w = bpy.data.worlds.new('W'); bpy.context.scene.world = w; w.use_nodes = True; w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.06, 0.08, 1); w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8
    sc = bpy.context.scene; sc.render.engine = 'BLENDER_EEVEE'; sc.render.resolution_x = 720; sc.render.resolution_y = 900; sc.render.filepath = os.path.join(OUT, 'preview_humanoid.png')
    bpy.ops.render.render(write_still=True)

# ── 미리보기 렌더 (Eevee): 네 모델을 나란히 놓고 한 장 ─────────────────
def preview():
    reset(); MATS.clear(); common_mats()
    for fn, x in ((build_amr, -2.6), (build_agv, -0.9), (build_forklift, 1.1), (build_drone, 2.9)):
        before = set(bpy.data.objects); fn(); new = [o for o in bpy.data.objects if o not in before and o.parent is None]
        for o in new: o.location.x += x; o.location.z += (1.2 if fn is build_drone else 0)
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0)); bpy.context.active_object.data.materials.append(mat('Floor', srgb('#8b9096'), 0, 0.8))
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); bpy.context.collection.objects.link(cam)
    cam.location = (0.3, -10.5, 4.6); cam.rotation_euler = (math.radians(70), 0, 0); cam.data.lens = 40; bpy.context.scene.camera = cam
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); sun.data.energy = 3.5; sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(30)); bpy.context.collection.objects.link(sun)
    w = bpy.data.worlds.new('W'); bpy.context.scene.world = w; w.use_nodes = True; w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.06, 0.08, 1); w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8
    sc = bpy.context.scene; sc.render.engine = 'BLENDER_EEVEE'; sc.render.resolution_x = 1280; sc.render.resolution_y = 560; sc.render.filepath = os.path.join(OUT, 'preview.png')
    bpy.ops.render.render(write_still=True)

# ── 기본 도형 라이브러리 (나머지 로봇·시설·설비 전체) ─────────────────
# tools/collect-primitives.cjs가 앱 화면에서 모은 상자·원기둥·구 치수(blender/primitives.json)를 같은 치수로 Blender에서 다시 만든다:
# 상자 → 둥근 모서리(Bevel, 짧은 변의 18%·최대 2.5cm) · 원기둥 → 면 수 늘림(최대 64) + 모서리 라운드 · 구 → 고해상도.
# 노드 이름 = 치수 키를 이름 규칙으로 바꾼 것 (three.js 로더가 '.' '|'를 이름에서 지우므로 '.'→'p', '|'→'_')
import json
def key_name(k): return k.replace('.', 'p').replace('|', '_').replace('-', 'm')
def build_primitives():
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'primitives.json')
    if not os.path.exists(src): print('primitives.json 없음 — npm run blender:collect 먼저'); return
    keys = json.load(open(src))['keys']
    R = empty('Primitives'); m = mat('Prim', srgb('#bfc5cc'), 0.1, 0.5)
    for k in keys:
        t, *v = k.split('|'); v = [float(x) for x in v]
        if t == 'B':
            w, h, d = v; mn = min(w, h, d)
            bpy.ops.mesh.primitive_cube_add(size=1); o = setname(bpy.context.active_object, key_name(k)); o.scale = (w, d, h); bpy.ops.object.transform_apply(scale=True)
            finish(o, m, bevel=min(0.025, mn * 0.18) if mn >= 0.01 else 0.0, seg=3 if mn > 0.05 else 2, parent=R)
        elif t == 'C':
            rt, rb, h, seg, op = v; r = max(rt, rb)
            n = int(min(64, max(seg * 2, 24 if r < 0.1 else 40)))
            bpy.ops.mesh.primitive_cone_add(vertices=n, radius1=rb, radius2=rt, depth=h, end_fill_type='NOTHING' if op else 'NGON')
            o = setname(bpy.context.active_object, key_name(k))
            finish(o, m, bevel=0.0 if op else min(0.012, min(r, h) * 0.12), seg=2, parent=R)
        elif t == 'S':
            r = v[0]; segs = 48 if r > 0.25 else 32
            bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=segs // 2, radius=r); o = setname(bpy.context.active_object, key_name(k))
            finish(o, m, parent=R)
    export(R, 'primitives')
    print('primitives', len(keys))

reset(); MATS.clear(); build_primitives()
for fn in (build_amr, build_agv, build_forklift, build_drone, build_humanoid, build_quadruped, build_arm6, build_ammr, build_truck, build_gantry, build_eaxle):
    reset(); MATS.clear(); common_mats(); fn()
try:
    preview(); preview_humanoid(); preview_one(build_quadruped, 'quadruped', (-1.9, -2.15, 1.45), (70, 0, -42), 40, (960, 720)); preview_one(build_eaxle, 'eaxle', (1.25, -1.45, 0.95), (68, 0, 40), 45, (960, 640)); preview_one(build_truck_fork, 'truck', (11.5, -9.5, 4.6), (72, 0, 52), 32, (1280, 720))
except Exception as e:   # 렌더 장치가 없는 환경에서는 미리보기만 건너뛴다
    print('preview skipped:', e)
print('Jin-3D Blender assets →', os.path.abspath(OUT), sorted(os.listdir(OUT)))
