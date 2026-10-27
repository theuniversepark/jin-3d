"""Boston Dynamics official low-resolution Spot SDK URDF. Metre scale, native joints."""
from pathlib import Path
src=Path(__file__).with_name('import_payload_robots.py').read_text()
exec(compile(src[:src.rfind('ur20();abb();dual()')],str(Path(__file__).with_name('import_payload_robots.py')),'exec'))
pkg=V/'spot';urdf=ET.parse(pkg/'model.urdf').getroot()
r=root('Spot','Spot',14,0,'Boston Dynamics','https://bostondynamics.com/products/spot/')
r['length_m']=1.1;r['width_m']=.5;r['walking_height_m']=.61;r['min_walking_height_m']=.52;r['max_walking_height_m']=.70;r['mass_kg']=33.8;r['legacy_2024_datasheet_mass_kg']=32.7;r['max_speed_mps']=1.6;r['dof']=12;r['battery_wh']=564;r['ingress_protection']='IP54';r['max_slope_deg']=30;r['max_step_height_m']=.3
r['representation']='Official SDK low-resolution URDF mesh, native metre scale and twelve joints; current product-page metadata; custom inspection payload'
r['geometry_source']='https://github.com/boston-dynamics/spot-sdk/blob/master/files/spot_base_urdf.zip'
r['dimension_source']='https://bostondynamics.com/wp-content/uploads/2020/10/spot-specifications.pdf'
yellow=material('SpotYellow','#efc52c',.12);dark=material('SpotDark','#25282d',.3);glass=material('THERMAL','#142834',.5)
glass.node_tree.nodes['Principled BSDF'].inputs['Emission Color'].default_value=(.005,.015,.02,1);glass.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value=.1
body=empty('Body',r);links={'base':body};codes=['fl','fr','hl','hr'];pose={}
for j in urdf.findall('joint'):
 name=j.attrib['name'];code,kind=name.split('.');i=codes.index(code);alias=f'HipRoll_{i}' if kind=='hx' else f'Hip_{i}' if kind=='hy' else f'Knee_{i}'
 o=j.find('origin');lim=j.find('limit');node=joint(alias,links[j.find('parent').attrib['link']],tuple(map(float,o.attrib['xyz'].split())),tuple(map(float,o.attrib['rpy'].split())),tuple(map(float,j.find('axis').attrib['xyz'].split())),float(lim.attrib['lower']),float(lim.attrib['upper']))
 node['original_joint']=name;rest=0 if kind=='hx' else .8 if kind=='hy' else -1.6;node['rest_angle']=rest
 # Bake rest into fixed origin, keeping native pivot rotation free for animation offsets.
 node.parent.rotation_euler.rotate_axis('X' if kind=='hx' else 'Y',rest)
 links[j.find('child').attrib['link']]=node
for li in urdf.findall('link'):
 vi=li.find('visual');file=pkg/vi.find('geometry/mesh').attrib['filename'];before=set(bpy.data.objects);bpy.ops.wm.obj_import(filepath=str(file),forward_axis='Y',up_axis='Z');added=set(bpy.data.objects)-before
 for obj in added:
  obj.parent=links[li.attrib['name']];obj.data.materials.clear();obj.data.materials.append(yellow if li.attrib['name']=='base' or 'uleg' in li.attrib['name'] else dark)
  for p in obj.data.polygons:p.use_smooth=True
# Establish 610 mm base-robot walking height by changing stance only, never scaling meshes.
def pts():
 bpy.context.view_layer.update();return [o.matrix_world@Vector(c) for o in r.children_recursive if o.type=='MESH' for c in o.bound_box]
a,b=.5,1.1
for _ in range(24):
 angle=(a+b)/2
 for i in range(4):
  bpy.data.objects[f'Hip_{i}'].parent.rotation_euler.y=angle;bpy.data.objects[f'Hip_{i}']['rest_angle']=angle
  bpy.data.objects[f'Knee_{i}'].parent.rotation_euler.y=-2*angle;bpy.data.objects[f'Knee_{i}']['rest_angle']=-2*angle
 pp=pts();height=max(v.z for v in pp)-min(v.z for v in pp)
 if height>.61:a=angle
 else:b=angle
p=pts();lo=min(v.z for v in p);hi=max(v.z for v in p);body.location.z=-lo;r['body_rest_height_m']=body.location.z;r['native_stance_height_m']=hi-lo
# Photo-derived sensor glass overlays; native mesh and kinematics stay unchanged.
for end in (-1,1):
 panel=box('FrontSensorPanel' if end==1 else 'RearSensorPanel',(.012,.17,.055),(end*.432,0,-.005),body,dark)
 for side in (-1,1):
  lens=cylinder(f'BaseLens_{end}_{side}',.015,.014,(end*.442,side*.045,-.005),body,glass);lens.rotation_euler.y=math.pi/2
for side in (-1,1):
 box(f'SideSensor_{side}',(.08,.012,.04),(-.08,side*.132,.005),body,dark)
# Inspection payload is additional equipment, not a Spot CAM OEM product.
top=hi-lo;box('PayloadBase',(.20,.16,.025),(0,0,top+.015),body,dark);bpy.data.objects['PayloadBase'].location.z-=body.location.z
mast=cylinder('PayloadMast',.018,.10,(0,0,top+.07-body.location.z),body,dark)
cam=empty('Cam',body,(0,0,top+.13-body.location.z));box('InspectionCamera',(.11,.16,.07),(0,0,0),cam,dark);lens=cylinder('InspectionLens',.023,.016,(.065,0,0),cam,glass);lens.rotation_euler.y=math.pi/2
save(r,'quadruped',{})
print('Native Spot base bounds',[(min(v[i] for v in p),max(v[i] for v in p)) for i in range(3)])
