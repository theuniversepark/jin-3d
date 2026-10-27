# Robot mesh sources and notices

Downloaded 2026-10-18. Geometry is imported through Blender with the original metre units, link origins, revolute axes and limits. Grippers, wrist camera, mobile platform/lift and additional inspection cameras are custom simulation attachments. These files are visual references, not validated robot controllers.

- Universal Robots UR20: UniversalRobots/Universal_Robots_ROS2_Description, rolling, revision in ur/REVISION. Code license: ur/LICENSE. UR20 graphical files are subject to ur/meshes/ur20/LICENSE.txt (included verbatim). The OEM texture and UVs are retained. © 2023 Universal Robots A/S. Use hereof is subject to Universal Robots A/S' Terms and Conditions for Use of Graphical Documentation.
- ABB IRB 4600-60/2.05: ros-industrial/abb, kinetic-devel, revision in abb/REVISION. Apache 2.0 as declared in abb/abb_irb4600_support/package.xml; full license in abb/APACHE-2.0.txt. Authors: Jonathan Meyer (Southwest Research Institute), Rik Tonnaer (SAM|XL). Meshes and URDF origins retained.
- Yaskawa MOTOMAN SDA10F: ros-industrial/motoman, noetic-devel, revision in motoman/REVISION. BSD-3-Clause as declared in motoman/motoman_sda10f_support/package.xml. Author: Shaun Edwards; package maintainer Yaskawa Motoman. Upstream attribution and package declaration retained. It is the 15-axis robot (two seven-axis arms and torso yaw), plus our external lift and mobile base.

Manufacturer specifications and representation limits: ../../blender/PAYLOAD_ROBOTS.md.
