# Payload robot replacements

Reference checked 2026-10-18. These are simulation assets, with payload ratings from manufacturer publications and metric meshes/kinematics from the corresponding ROS packages. They are not a tested physical integration.

| Role | Robot | Rated flange payload | Published reach |
|---|---|---|---|
| Cobot | Universal Robots UR20 | 20 kg; conditional expanded 25 kg is not assumed | 1,750 mm |
| Dual arm | Rainbow Robotics RB-Y1 | 3 kg **per arm** (does not meet the earlier 10 kg requirement) | 600 mm to wrist + hand |
| Industrial | ABB IRB 4600-60/2.05 | 60 kg, including tooling and wrist camera | 2,050 mm |

Sources:
- https://www.universal-robots.com/products/ur20/
- https://www.universal-robots.com/manuals/EN/TechSheets/UR20_techsheet_pdf_online/UR20_techsheet_en.pdf
- https://www.yaskawa.de/Global%20Assets/Downloads/Brochures_Catalogues/Robotics/MOTOMAN_Robots/SDA_Series/Flyer_Robot_SDA_Series_E_03.2017.pdf
- https://www.abb.com/gb/en/areas/robotics/products/robots/articulated-robots/medium-robots/irb-4600

Original link geometry, metre scale, joint origins, axes and limits are retained. UR20 retains its original UVs and OEM texture. RB-Y1 uses the official RB-Y1A v1.2 mobile base, six body axes, fourteen arm axes, two wheels and two head axes. Inspection cameras are custom attachments. No combined two-arm payload rating is inferred. Published ratings are not a dynamics/load certification for the simulation: tool, camera and centre-of-gravity constraints must be included in an actual integration.

Rebuild:

    blender -b --python blender/import_payload_robots.py

Outputs: assets/blender/{ur20,irb4600,rby1}.{glb,blend}, and preview PNGs. GLB rigs export at zero joint rotation; Blender files open in a posed preview scene. The Blender importer reads original COLLADA triangle geometry, UVs, node transforms and STL meshes without normalizing or stretching links.

Camera storage:

- Industrial arm has a camera housing and bracket mounted at its tool flange; view, recording and export share its physical optical transform.
- All stages with operating robots register it in RobotCamWall.allCameras(), including precision assembly, flexible/adaptive manufacturing, palletizers and inspection cells.
- RobotVideoRecorder automatically stores 5-minute WebM segments and a JSON index under the runtime data/robotcam directory. ffmpeg converts the mosaic and individual camera crops to H.264 MP4 when videos/AAS are exported.
- AAS VideoRecordings links the video to the robot asset and records camera name, time and crop coordinates.
- Verification creates a short actual simulated-scene video (not live physical camera footage) in outputs/robot-upgrade/recordings/robotcam. See outputs/robot-upgrade/validation.json.

Checks:

    node tests/payload-robots.mjs
    node tests/blender.mjs
    node tests/mp4.mjs
    node tests/aasvideo.mjs
    npx electron tools/check-payload-robots.cjs

Licenses and vendor revisions are retained in assets/vendor/README.md and its subdirectories.

Research context: Outlook and Teams profiles were rechecked as jin.park@camtic.or.kr. A narrow search of accessible records did not supply a manufacturer payload source used here; manufacturer publications above are the specification evidence. KakaoTalk records were not accessible in this session.

RB-Y1 source: https://rainbow-robotics.com/en/products/rb-y1/
Official model: https://github.com/RainbowRobotics/rby1-sdk/tree/main/models/rby1a/urdf (model_v1.2.urdf). Exact revision is recorded in assets/vendor/rainbow/REVISION; LICENSE and NOTICE retained. Published nominal dimensions: 600×690×1400 mm; arm reach: 600 mm to wrist plus hand. Dimensions vary with body posture. Build RB-Y1 using blender -b --python blender/import_rby1.py. Manufacturer GLBs contain ROS-coordinate geometry, so the importer reverses the glTF loader axis conversion inside each visual frame. Joint origins, mesh scale, materials and joint limits are preserved.
