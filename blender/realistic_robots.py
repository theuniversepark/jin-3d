# Official dimension targets; cosmetic details reconstructed from product photographs.
# Loaded in build_assets.py's namespace so geometry helpers stay shared.
from mathutils import Vector

def label(name, text, loc, size, material, parent, rot=(math.pi / 2, 0, 0)):
    c = bpy.data.curves.new(name, 'FONT'); c.body = text; c.size = size; c.extrude = 0.00015
    o = bpy.data.objects.new(name, c); bpy.context.collection.objects.link(o)
    o.parent = parent; o.location = loc; o.rotation_euler = rot; c.materials.append(material)
    bpy.context.view_layer.objects.active = o; o.select_set(True)
    bpy.ops.object.convert(target='MESH'); o.select_set(False)
    return bpy.context.view_layer.objects.active

def tube(name, points, radius, material, parent):
    c = bpy.data.curves.new(name, 'CURVE'); c.dimensions = '3D'; c.bevel_depth = radius; c.bevel_resolution = 2
    sp = c.splines.new('POLY'); sp.points.add(len(points)-1)
    for p, co in zip(sp.points, points): p.co = (*co, 1)
    o = bpy.data.objects.new(name,c); bpy.context.collection.objects.link(o); o.parent=parent; c.materials.append(material)
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active=o
    bpy.ops.object.convert(target='MESH'); o.select_set(False)

def dimension_fit(root, target, exclude=()):
    bpy.context.view_layer.update()
    objs = [o for o in root.children_recursive if o.type == 'MESH' and not any(p in exclude for p in [o])]
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector(tuple(min(p[i] for p in pts) for i in range(3))); hi = Vector(tuple(max(p[i] for p in pts) for i in range(3)))
    f = Vector(tuple(target[i]/(hi[i]-lo[i]) for i in range(3)))
    # Bake scale into each local transform and mesh: runtime joint rotations stay unscaled.
    for o in root.children_recursive:
        if any(p in exclude for p in [o]): continue
        o.location = Vector(tuple(o.location[i]*f[i] for i in range(3)))
        if o.parent == root: o.location.z -= lo.z*f.z
        if o.type == 'MESH':
            # Geometry may be rotated locally; convert the world-axis scaling into local axes.
            r=o.rotation_euler.to_matrix(); sm=__import__('mathutils').Matrix.Diagonal(f)
            for v in o.data.vertices: v.co = r.inverted() @ sm @ r @ v.co
            for mod in o.modifiers:
                if mod.type=='BEVEL': mod.width *= min(f)
    bpy.context.view_layer.update()

_base_atlas = build_humanoid
_base_spot = build_quadruped

def build_humanoid():
    _base_atlas()
    R=bpy.data.objects['Atlas']; W=bpy.data.objects['Waist']; Hd=bpy.data.objects['Head']
    shell=MATS['AtlasShell']; shell.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(*srgb('#7394bb'),1)
    shell.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=0.3
    dark=MATS['AtlasJoint']; glass=MATS['Glass']; steel=MATS['Steel']
    white=mat('Marking',srgb('#dce4ec'),0.05,0.55)
    # Production Atlas has blue panels, a black shoulder yoke and warm face rim.
    for n in ['Chest','Abdomen','ChestPanel','ChestLight','ChestArmor_L','ChestArmor_R','HeadBack','HeadNeckMount','FaceRing','Yoke','ThighPanel_L','ThighPanel_R','KneeCap_L','KneeCap_R','Palm_L','Palm_R','Thumb_L','Thumb_R']:
        o=bpy.data.objects.get(n)
        if o: bpy.data.objects.remove(o,do_unlink=True)
    for o in list(bpy.data.objects):
        if o.name.startswith('Finger_'): bpy.data.objects.remove(o,do_unlink=True)
    box('AtlasChestYoke',(0.40,0.265,0.17),(0,0,0.455),dark,bevel=0.05,parent=W)
    box('AtlasAbdominalPanel',(0.34,0.24,0.32),(0,0,0.235),shell,bevel=0.045,parent=W)
    box('AtlasStatusLED',(0.018,0.008,0.008),(0.15,0.135,0.49),MATS['ACC'],bevel=0.002,parent=W)
    label('AtlasBrand','Boston Dynamics',(-0.13,-0.142,0.43),0.022,white,W)
    # Circular face with recessed stereo camera bar and perforated speaker grille.
    rim=MATS['VISOR']; b=rim.node_tree.nodes['Principled BSDF']; b.inputs['Base Color'].default_value=(*srgb('#fff0bb'),1); b.inputs['Emission Color'].default_value=(*srgb('#fff0bb'),1); b.inputs['Emission Strength'].default_value=0.7
    bpy.ops.mesh.primitive_torus_add(major_radius=0.131,minor_radius=0.011,major_segments=72,minor_segments=12,location=(0,-0.076,0),rotation=(math.pi/2,0,0))
    finish(setname(bpy.context.active_object,'FaceRing'),rim,parent=Hd)
    box('StereoBar',(0.17,0.018,0.039),(0,-0.079,-0.047),dark,bevel=0.009,parent=Hd)
    for sd in (-1,1):
        cyl(f'AtlasStereo_{sd}',0.014,0.006,(sd*0.058,-0.091,-0.047),glass,axis='Y',parent=Hd)
    for row in range(11):
        for col in range(17):
            x=(col-8)*0.011; z=(row-5)*0.011+0.025
            if x*x+z*z<0.103**2 and z>-0.021:
                cyl(f'FacePerforation_{row}_{col}',0.0022,0.002,(x,-0.069,z),dark,axis='Y',parent=Hd,verts=8)
    box('HeadTopSensor',(0.025,0.025,0.045),(0,0.015,0.145),white,bevel=0.005,parent=Hd)
    for sd,side in ((-1,'L'),(1,'R')):
        for part,z,length,r in [('Shoulder',-0.08,0.10,0.066),('Elbow',-0.065,0.06,0.045),('Hip',-0.075,0.08,0.066)]:
            P=bpy.data.objects[f'{part}_{side}']
            for i in range(8): cyl(f'{part}Bellows_{side}_{i}',r,length/12,(0,0,z+i*length/8),dark,parent=P,verts=32)
        K=bpy.data.objects[f'Knee_{side}']
        bpy.data.objects.remove(bpy.data.objects[f'Shin_{side}'],do_unlink=True)
        cyl(f'AnkleDrive_{side}',0.051,0.13,(0,0,-0.405),shell,axis='X',parent=K,bevel=0.008)
        box(f'CalfDriveCover_{side}',(0.115,0.12,0.35),(0,0.025,-0.205),dark,bevel=0.045,parent=K)
        for j in range(6): box(f'SoleTread_{side}_{j}',(0.125,0.018,0.009),(0,-0.155+j*0.043,-0.488),dark,bevel=0.003,parent=K)
        E=bpy.data.objects[f'Elbow_{side}']
        box(f'Palm_{side}',(0.082,0.05,0.10),(0,-0.005,-0.32),shell,bevel=0.016,parent=E)
        for j,x in enumerate((-0.028,0,0.028)):
            for k in range(3):
                box(f'Finger_{side}_{j}_{k}',(0.019,0.028,0.026),(x,-0.005-k*0.004,-0.385-k*0.027),dark,bevel=0.007,parent=E)
                cyl(f'FingerPin_{side}_{j}_{k}',0.008,0.021,(x,-0.005-k*0.004,-0.375-k*0.027),steel,axis='X',parent=E,verts=12)
        box(f'Thumb_{side}',(0.026,0.03,0.065),(-sd*0.053,-0.005,-0.35),dark,bevel=0.009,parent=E,rot=(0,-sd*0.5,0))
        # Service fasteners around actuator caps.
        for part in ('Shoulder','Elbow','Knee'):
            P=bpy.data.objects[f'{part}_{side}']
            for a in range(6):
                ang=a*math.tau/6
                cyl(f'{part}Bolt_{side}_{a}',0.004,0.004,(sd*0.078,math.sin(ang)*0.04,math.cos(ang)*0.04),steel,axis='X',parent=P,verts=6)
    dimension_fit(R,(0.70,0.40,1.90))  # Width/depth reconstructed; only height is published.
    R['height_m']=1.9; R['mass_kg']=90; R['dof']=56; R['reach_m']=2.3
    R['source']='https://bostondynamics.com/wp-content/uploads/2026/01/atlas-spec-sheet.pdf'
    R['representation']='2026 production Atlas; published height; photograph-derived proportions; simplified animated rig'
    export(R,'humanoid')

def build_quadruped():
    import runpy
    runpy.run_path(str(__import__('pathlib').Path(__file__).with_name('import_spot.py')), run_name='__main__')
