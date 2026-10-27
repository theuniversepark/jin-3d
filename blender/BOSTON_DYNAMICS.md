# Spot / Atlas visualization models

Reference checked: 2026-10-18. Units: metres. Blender Z-up; exported glTF Y-up.

| Robot | Published dimensions used | Other published metadata |
|---|---|---|
| Spot | length 1.10, width 0.50, default walking height 0.61 | 33.8 kg incl. battery (current product page); payload 14 kg; speed 1.6 m/s |
| Atlas, 2026 production design | standing height 1.90 | 90 kg; 56 DoF; reach 2.3 m |

Sources:
- https://bostondynamics.com/wp-content/uploads/2020/10/spot-specifications.pdf (document updated 2024-05-22, linked from current product page)
- https://bostondynamics.com/wp-content/uploads/2026/01/atlas-spec-sheet.pdf (sheet dated 2025-12-23)

Spot now uses the manufacturer SDK low-resolution OBJ/URDF geometry and original 12 joint origins, limits and mesh scale. Atlas remains a custom Blender reconstruction. Neither is a validated dynamics model.
Spot nominal length/width are product specifications; the simplified SDK mesh in the selected stance has a smaller bounding envelope (approximately 1.02×0.44 m), and is deliberately not stretched to force those nominal values. The hip/knee stance is solved for a 610 mm base height. Atlas width/depth (0.70/0.40), individual link dimensions, surface details and joint locations are estimates from official photographs. Published weight, reach and DoF are asset metadata, not a claim that the animation rig implements all real joints or dynamics.
Spot's custom inspection camera is an additional payload excluded from the 0.61 m base height. The animated default stance uses the fitted body's rest height, with zero additional joint offset at rest; real hip/knee rest angles are retained in fixed origin transforms.

Rebuild only these two models:

    blender -b --python blender/build_assets.py -- --boston-dynamics

Outputs: assets/blender/{humanoid,quadruped}.{blend,glb} and preview PNGs.
Validate: node tests/blender.mjs (base Spot dimensions and Atlas height within 5 mm).

Spot primary sources: https://bostondynamics.com/products/spot/ and https://github.com/boston-dynamics/spot-sdk/blob/master/files/spot_base_urdf.zip . SDK license retained at assets/vendor/spot/LICENSE. Current website mass is 33.8 kg; linked 2024-05-22 PDF says 32.7 kg. We explicitly store the latter as legacy metadata and use the current web mass. The website displays “110mm (43.3 in)” for length, an inconsistent unit entry; the linked PDF explicitly gives 1100 mm, which is the length used. Older Spot Gamma documentation is not used to substitute its 840 mm standing height for current 610 mm default walking height. Photo-derived sensor glass overlays and inspection camera are additions, not OEM CAD. Rebuild Spot alone: blender -b --python blender/import_spot.py.
