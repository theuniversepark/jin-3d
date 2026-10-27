"""Import metric ROS geometry with original joint origins; export native Blender/GLB rigs.
blender -b --python blender/import_payload_robots.py
ROS +X forward, +Z up -> application +Z forward, +Y up. No mesh normalization.
"""
import bpy, math, json, re, xml.etree.ElementTree as ET
from pathlib import Path
from mathutils import Matrix, Vector, Euler
BASE=Path(__file__).resolve().parents[1]; V=BASE/'assets/vendor'; OUT=BASE/'assets/blender'
NS={'c':'http://www.collada.org/2005/11/COLLADASchema'}

def empty(name,parent=None,loc=(0,0,0),rpy=(0,0,0)):
 o=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(o);o.parent=parent;o.location=loc;o.rotation_euler=rpy;return o

def material(name,hex,metal=.25):
 h=hex.lstrip('#');cs=[int(h[i:i+2],16)/255 for i in (0,2,4)];cs=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in cs]
 m=bpy.data.materials.new(name);m.use_nodes=True;b=m.node_tree.nodes['Principled BSDF'];b.inputs['Base Color'].default_value=(*cs,1);b.inputs['Metallic'].default_value=metal;b.inputs['Roughness'].default_value=.36;return m

def box(name,size,loc,parent,mat):
 bpy.ops.mesh.primitive_cube_add(size=1);o=bpy.context.object;o.name=name;o.parent=parent;o.location=loc;o.scale=size;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(mat)
 b=o.modifiers.new('Edge finish','BEVEL');b.width=.006;b.segments=3;return o

def cylinder(name,r,h,loc,parent,mat):
 bpy.ops.mesh.primitive_cylinder_add(vertices=40,radius=r,depth=h);o=bpy.context.object;o.name=name;o.parent=parent;o.location=loc;o.data.materials.append(mat);return o

def mesh(path,parent,mat,offset=(0,0,0),rpy=(0,0,0)):
 path=Path(path);holder=empty('CAD_'+path.stem,parent,offset,rpy)
 if path.suffix.lower()=='.stl':
  bpy.ops.wm.stl_import(filepath=str(path),forward_axis='Y',up_axis='Z');o=bpy.context.object;o.parent=holder;o.data.materials.clear();o.data.materials.append(mat)
  for p in o.data.polygons:p.use_smooth=True
  o.data.set_sharp_from_angle(angle=math.radians(35));return holder
 # Blender 5 no longer imports Collada; read triangle geometry, UVs and scene transforms.
 tree=ET.parse(path).getroot();geoms={g.attrib['id']:g for g in tree.findall('.//c:library_geometries/c:geometry',NS)}
 unit=tree.find('c:asset/c:unit',NS);unit=float(unit.attrib.get('meter','1')) if unit is not None else 1
 def node(n,parentM):
  M=parentM.copy()
  for t in n:
   tag=t.tag.split('}')[-1];a=[float(x) for x in (t.text or '').split()] if tag in ('matrix','translate','rotate','scale') else []
   if tag=='matrix': M=M@Matrix([a[i:i+4] for i in range(0,16,4)])
   elif tag=='translate':M=M@Matrix.Translation(a)
   elif tag=='scale':M=M@Matrix.Diagonal(Vector((*a,1)))
   elif tag=='rotate':M=M@Matrix.Rotation(math.radians(a[3]),4,Vector(a[:3]))
  for ins in n.findall('c:instance_geometry',NS):
   g=geoms[ins.attrib['url'][1:]].find('c:mesh',NS);sources={}
   for src in g.findall('c:source',NS):
    f=src.find('c:float_array',NS)
    if f is None:continue
    stride=int(src.find('c:technique_common/c:accessor',NS).attrib.get('stride','3'));nums=list(map(float,f.text.split()));sources[src.attrib['id']]=[nums[i:i+stride] for i in range(0,len(nums),stride)]
   vertices={v.attrib['id']:v.find('c:input',NS).attrib['source'][1:] for v in g.findall('c:vertices',NS)}
   for tri in g.findall('c:triangles',NS):
    inputs=tri.findall('c:input',NS);stride=max(int(i.attrib['offset']) for i in inputs)+1
    vi=next(i for i in inputs if i.attrib['semantic']=='VERTEX');src=sources[vertices[vi.attrib['source'][1:]]];vo=int(vi.attrib['offset'])
    uv=next((i for i in inputs if i.attrib['semantic']=='TEXCOORD'),None);inds=list(map(int,tri.find('c:p',NS).text.split()));faces=[];uvs=[]
    for i in range(0,len(inds),stride*3):
     faces.append(tuple(inds[i+k*stride+vo] for k in range(3)))
     if uv is not None:uvs.extend(sources[uv.attrib['source'][1:]][inds[i+k*stride+int(uv.attrib['offset'])]][:2] for k in range(3))
    me=bpy.data.meshes.new(path.stem);me.from_pydata([M@Vector(p[:3])*unit for p in src],[],faces);me.update()
    o=bpy.data.objects.new('Surface_'+path.stem,me);bpy.context.collection.objects.link(o);o.parent=holder;me.materials.append(mat)
    if uvs:
     layer=me.uv_layers.new(name='UVMap')
     for loop,co in zip(layer.data,uvs):loop.uv=co
    for p in me.polygons:p.use_smooth=True
    me.set_sharp_from_angle(angle=math.radians(35))
  for c in n.findall('c:node',NS):node(c,M)
 for n in tree.findall('.//c:visual_scene/c:node',NS):node(n,Matrix.Identity(4))
 return holder

def joint(name,parent,xyz=(0,0,0),rpy=(0,0,0),axis=(0,0,1),lo=-math.pi,hi=math.pi):
 f=empty(name+'_Origin',parent,xyz,rpy);q=empty(name,f);q['axis']=[axis[0],axis[2],-axis[1]];q['lower']=lo;q['upper']=hi;return q

def root(name,model,payload,reach,manufacturer,source):
 bpy.ops.wm.read_factory_settings(use_empty=True);bpy.context.preferences.filepaths.save_version=0
 bpy.context.scene.unit_settings.system='METRIC';r=empty(name);r.rotation_euler.z=-math.pi/2
 for k,v in dict(model=model,payload_kg=payload,reach_m=reach,manufacturer=manufacturer,source=source,representation='Native ROS visual meshes / original joint origins; custom gripper and camera').items():r[k]=v
 return r

def gripper(parent,axis='Z'):
 st=material('ToolSteel','#9ba3ac',.8);d=material('ToolDark','#242930')
 # Parent frame +Z points out of the flange.
 box('CustomGripper',(.09,.08,.055),(0,0,.035),parent,d)
 for side in (-1,1):box('CustomFinger'+str(side),(.018,.03,.09),(side*.034,0,.105),parent,st)
 return empty('ToolTCP',parent,(0,0,.15))

def save(r,name,pose):
 bpy.ops.object.select_all(action='DESELECT')
 for o in [r,*r.children_recursive]:o.select_set(True)
 bpy.context.view_layer.objects.active=r
 bpy.ops.export_scene.gltf(filepath=str(OUT/(name+'.glb')),export_format='GLB',use_selection=True,export_extras=True,export_animations=False)
 for n,a in pose.items():
  o=bpy.data.objects[n];ax=o['axis'];o.rotation_mode='AXIS_ANGLE';o.rotation_axis_angle=(a,ax[0],-ax[2],ax[1])
 # Save editable preview pose, then frame model automatically.
 bpy.context.view_layer.update();pts=[o.matrix_world@Vector(c) for o in r.children_recursive if o.type=='MESH' for c in o.bound_box];lo=Vector([min(p[i] for p in pts)for i in range(3)]);hi=Vector([max(p[i] for p in pts)for i in range(3)]);center=(lo+hi)/2;span=max(hi-lo)
 bpy.ops.mesh.primitive_plane_add(size=20);floor=bpy.context.object;floor.name='PreviewFloor';floor.location.z=lo.z-.01;floor.data.materials.append(material('Floor','#626b75',0))
 bpy.ops.object.camera_add(location=center+Vector((span*1.6,-span*2.3,span*1.1)));cam=bpy.context.object;cam.rotation_euler=(center-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.lens=50;bpy.context.scene.camera=cam
 for loc,power,size in [(center+Vector((2,-3,5)),1800,4),(center+Vector((-3,1,3)),1100,3)]:
  bpy.ops.object.light_add(type='AREA',location=loc);o=bpy.context.object;o.data.energy=power;o.data.shape='DISK';o.data.size=size;o.rotation_euler=(center-o.location).to_track_quat('-Z','Y').to_euler()
 sc=bpy.context.scene;sc.world=bpy.data.worlds.new('World');sc.world.color=(.15,.15,.15);sc.render.engine='BLENDER_EEVEE';sc.render.resolution_x=1100;sc.render.resolution_y=900;sc.render.resolution_percentage=100;sc.render.filepath=str(OUT/('preview_'+name+'.png'))
 bpy.ops.wm.save_as_mainfile(filepath=str(OUT/(name+'.blend')));bpy.ops.render.render(write_still=True)

# UR20: original OEM textures and kinematics, standard 20 kg rating (25 kg conditional).
def ur20():
 r=root('UR20','UR20',20,1.75,'Universal Robots','https://www.universal-robots.com/products/ur20/')
 r['copyright']='© 2023 Universal Robots A/S. Use hereof is subject to Universal Robots A/S’ Terms and Conditions for Use of Graphical Documentation.'
 r['terms']='assets/vendor/ur/meshes/ur20/LICENSE.txt'
 m=material('UR20_OEM','#b3bdc8');b=m.node_tree.nodes['Principled BSDF'];tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(str(V/'ur/meshes/ur20/visual/UR20_DIFF_8bit_2K.png'));m.node_tree.links.new(tex.outputs['Color'],b.inputs['Base Color']);tex.image.pack()
 parent=empty('URBase',r,rpy=(0,0,math.pi));mesh(V/'ur/meshes/ur20/visual/base.dae',parent,m,rpy=(0,0,math.pi))
 # x,y,z,roll,pitch,yaw taken from config/ur20/default_kinematics.yaml
 defs=[('shoulder',(0,0,.2363),(0,0,0),'shoulder.dae',(0,0,0),(0,0,math.pi)),('upper_arm',(0,0,0),(math.pi/2,0,0),'upperarm.dae',(0,0,.260),(math.pi/2,0,-math.pi/2)),('forearm',(-.862,0,0),(0,0,0),'forearm.dae',(0,0,.043),(math.pi/2,0,-math.pi/2)),('wrist_1',(-.7287,0,.201),(0,0,0),'wrist1.dae',(0,0,-.0775),(math.pi/2,0,0)),('wrist_2',(0,-.1593,0),(math.pi/2,0,0),'wrist2.dae',(0,0,-.0749),(0,0,0)),('wrist_3',(0,.1543,0),(math.pi/2,math.pi,math.pi),'wrist3.dae',(0,0,-.07),(math.pi/2,0,0))]
 for i,(_,xyz,rpy,file,off,rot)in enumerate(defs):
  parent=joint('J'+str(i+1),parent,xyz,rpy,lo=-math.tau,hi=math.tau);mesh(V/('ur/meshes/ur20/visual/'+file),parent,m,off,rot)
 tool=empty('ToolFlange',parent);gripper(tool)
 save(r,'ur20',{f'J{i+1}':v for i,v in enumerate([0,-1.1,1.8,-2.25,-math.pi/2,0])})

def abb():
 r=root('ABB_IRB4600','IRB 4600-60/2.05',60,2.05,'ABB','https://www.abb.com/gb/en/areas/robotics/products/robots/articulated-robots/medium-robots/irb-4600')
 orange=material('ABB_Orange','#ed6527',.15);steel=material('Flange','#a8afb6',.8)
 macro=next(x for x in ET.parse(V/'abb/abb_irb4600_support/urdf/irb4600_60_205_macro.xacro').getroot() if x.tag.endswith('macro'))
 clean=lambda x:x.replace('${prefix}','');links={'base_link':empty('Base',r)}
 for i,j in enumerate([j for j in macro.findall('joint')if j.attrib['type']=='revolute']):
  xyz=tuple(map(float,j.find('origin').attrib['xyz'].split()));axis=tuple(map(float,j.find('axis').attrib['xyz'].split()));lim=j.find('limit');links[clean(j.find('child').attrib['link'])]=joint('J'+str(i+1),links[clean(j.find('parent').attrib['link'])],xyz,axis=axis,lo=float(lim.attrib['lower']),hi=float(lim.attrib['upper']))
 for link in macro.findall('link'):
  visual=link.find('visual')
  if visual is None:continue
  name=clean(link.attrib['name']);file=visual.find('geometry/mesh').attrib['filename'].replace('package://','');mesh(V/'abb'/file,links[name],steel if name=='link_6' else orange)
 flange=empty('ToolFlange',links['link_6'],rpy=(0,math.pi/2,0));gripper(flange)
 # Real camera housing + mounting bracket. Optical axis +Z of WristCamera.
 cam=empty('WristCamera',flange,(.095,0,.03));cam['custom_attachment']=True;d=material('CameraHousing','#222932');g=material('OpticalGlass','#182839',.65)
 box('CameraBracket',(.025,.06,.08),(-.035,0,-.005),cam,steel);box('CameraHousing',(.07,.055,.065),(0,0,0),cam,d);cylinder('CameraLens',.018,.018,(0,0,.04),cam,g);cylinder('CameraLensRim',.023,.008,(0,0,.031),cam,steel)
 save(r,'irb4600',{f'J{i+1}':v for i,v in enumerate([0,.35,-.55,0,.8,0])})

def val(s,reflect=1):
 return re.sub(r'\$\{([^}]+)\}',lambda m:str(eval(m.group(1),{'__builtins__':{}},{'reflect':reflect,'radians':math.radians})),s)
def nums(s,reflect=1):return tuple(map(float,val(s,reflect).split()))

def dual():
 r=root('SDA10F_Mobile','MOTOMAN SDA10F + custom mobile base',10,.720,'Yaskawa','https://www.yaskawa.de/Global%20Assets/Downloads/Brochures_Catalogues/Robotics/MOTOMAN_Robots/SDA_Series/Flyer_Robot_SDA_Series_E_03.2017.pdf')
 r['payload_basis']='10 kg per arm (including tooling); no summed dual-arm rating claimed';r['dof']=15;r['custom_equipment']='Mobile base, vertical lift and inspection cameras are simulated integrations, not a standard Yaskawa product.'
 blue=material('YaskawaBlue','#1675b8',.15);white=material('YaskawaWhite','#e9edf1',.1);dark=material('PlatformDark','#242c35');led=material('LED','#2aa8ff');led.node_tree.nodes['Principled BSDF'].inputs['Emission Color'].default_value=(.01,.3,.9,1);led.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value=2
 # Platform is in ROS coordinates. Convert for runtime using parent's transforms.
 platform=empty('CustomPlatform',r);box('MobileBase',(.88,.80,.26),(0,0,.18),platform,white);box('StatusLED',(.012,.66,.025),(.445,0,.23),platform,led)
 for x in (-.29,.29):
  for y in (-.39,.39):
   o=cylinder('Wheel',.09,.045,(x,y,.09),platform,dark);o.rotation_euler.x=math.pi/2
 # Lift is outside ROS orientation so application can keep changing its Y height.
 lift=empty('Lift',r,(0,0,.35));torso=empty('SDAFloorDatum',lift,(0,0,1.2))
 pkg=V/'motoman/motoman_sda10f_support';mesh(pkg/'meshes/sda10f/visual/base.stl',torso,blue)
 waist=joint('TorsoYaw',torso,lo=-math.radians(170),hi=math.radians(170));mesh(pkg/'meshes/sda10f/visual/link_b1.stl',waist,white)
 head=empty('Head',waist,(.10,0,.17));box('CustomHeadCamera',(.07,.19,.07),(0,0,0),head,dark)
 tips=[]
 for side,ref in [('L',1),('R',-1)]:
  parent=waist;macro=next(x for x in ET.parse(pkg/'urdf/arm_macro.xacro').getroot()if x.tag.endswith('macro'));links={}
  for i,j in enumerate([j for j in macro.findall('joint')if j.attrib['type']=='revolute']):
   org=j.find('origin');lim=j.find('limit');q=joint(side+'_J'+str(i+1),parent,nums(org.attrib['xyz'],ref),nums(org.attrib['rpy'],ref),nums(j.find('axis').attrib['xyz'],ref),float(val(lim.attrib['lower'],ref)),float(val(lim.attrib['upper'],ref)));child=j.find('child').attrib['link'];links[child]=q;parent=q
  for li in macro.findall('link'):
   vi=li.find('visual')
   if vi is None:continue
   name=li.attrib['name'];file=vi.find('geometry/mesh').attrib['filename'].replace('package://motoman_sda10f_support/','');mesh(pkg/file,links[name],blue if any(k in file for k in ('link_s.','link_e.','link_r.','link_t.'))else white)
  tool=empty(side+'_ToolFlange',parent);t=gripper(tool);t.name=side+'_ToolTCP';tips.append(t)
 pose={}
 for side,sd in [('L',1),('R',-1)]:
  pose.update({side+'_J'+str(i+1):q for i,q in enumerate([sd*.2,-sd*1.0,0,-sd*1.1,0,sd*.6,0])})
 save(r,'sda10f',pose)

ur20();abb();dual()
