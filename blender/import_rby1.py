"""Official Rainbow Robotics RB-Y1A v1.2 URDF and original GLB visual meshes."""
from pathlib import Path
src=Path(__file__).with_name('import_payload_robots.py').read_text()
exec(compile(src[:src.rfind('ur20();abb();dual()')],str(Path(__file__).with_name('import_payload_robots.py')),'exec'))
pkg=V/'rainbow';urdf=ET.parse(pkg/'model.urdf').getroot()
r=root('Rainbow_RBY1','RB-Y1',3,.6,'Rainbow Robotics','https://rainbow-robotics.com/en/products/rb-y1/')
r['representation']='Official RB-Y1A v1.2 URDF / original GLB visual meshes and joint origins; additional inspection cameras'
r['revision']=(pkg/'REVISION').read_text().strip();r['payload_basis']='3 kg per arm; 600 mm reach to wrist plus hand';r['dof']=24;r['dimensions_mm']=[600,690,1400]
links={'base':empty('Base',r)};pose={}
for j in urdf.findall('joint'):
 name=j.attrib['name'];parent=links[j.find('parent').attrib['link']];o=j.find('origin');xyz=tuple(map(float,o.attrib.get('xyz','0 0 0').split())) if o is not None else (0,0,0);rot=tuple(map(float,o.attrib.get('rpy','0 0 0').split())) if o is not None else (0,0,0)
 if j.attrib['type'] in ('revolute','continuous'):
  axis=tuple(map(float,j.find('axis').attrib['xyz'].split()));lim=j.find('limit');lo=float(lim.attrib.get('lower',-math.pi)) if lim is not None else -math.pi;hi=float(lim.attrib.get('upper',math.pi)) if lim is not None else math.pi
  alias=name
  for side,code in [('left','L'),('right','R')]:
   if name.startswith(side+'_arm_'):alias=code+'_J'+str(int(name[-1])+1)
  node=joint(alias,parent,xyz,rot,axis,lo,hi);node['original_joint']=name
 else:node=empty(name,parent,xyz,rot)
 links[j.find('child').attrib['link']]=node
for li in urdf.findall('link'):
 parent=links.get(li.attrib['name'])
 if parent is None:continue
 for vi in li.findall('visual'):
  me=vi.find('geometry/mesh')
  if me is None:continue
  o=vi.find('origin');xyz=tuple(map(float,o.attrib.get('xyz','0 0 0').split())) if o is not None else (0,0,0);rot=tuple(map(float,o.attrib.get('rpy','0 0 0').split())) if o is not None else (0,0,0)
  holder=empty('Visual_'+li.attrib['name'],parent,xyz,rot);before=set(bpy.data.objects);path=pkg/me.attrib['filename'].replace('.dae','.glb');bpy.ops.import_scene.gltf(filepath=str(path));added=set(bpy.data.objects)-before
  for obj in added:
   if obj.parent not in added:
    obj.parent=holder;obj.matrix_basis=Matrix.Rotation(-math.pi/2,4,'X')@obj.matrix_basis
for side,code in [('left','L'),('right','R')]:
 empty(code+'_ToolTCP',links['ee_'+side],(0,0,-.12))
 pose.update({code+'_J'+str(i+1):q for i,q in enumerate([-.2, .35 if code=='L' else -.35,0,-1.1,0,.5,0])})
empty('Head',links['link_head_2']);empty('BodyCameraAnchor',links['link_torso_5'])
save(r,'rby1',pose)
