// Manufacturer ratings include all equipment carried by the flange.
export const ROBOT_SPECS = Object.freeze({
  cobot: { asset: 'ur20', manufacturer: 'Universal Robots', model: 'UR20', payload: 20, reach: 1.75, axes: 6, source: 'https://www.universal-robots.com/products/ur20/' },
  articulated: { asset: 'irb4600', manufacturer: 'ABB', model: 'IRB 4600-60/2.05', payload: 60, reach: 2.05, axes: 6, source: 'https://www.abb.com/gb/en/areas/robotics/products/robots/articulated-robots/medium-robots/irb-4600' },
  ammr: { asset: 'rby1', manufacturer: 'Rainbow Robotics', model: 'RB-Y1', payload: 3, payloadBasis: '팔당 3kg (공식 정격, 기존 10kg 조건 미충족)', reach: 0.600, axes: 24, dimensionsMm: [600,690,1400], source: 'https://rainbow-robotics.com/en/products/rb-y1/' },
});
export function robotSpecTech(r) {
  const s = r.spec; return s ? { ReferenceManufacturer: s.manufacturer, ReferenceModel: s.model, ReachMeters: s.reach, ...(s.dimensionsMm ? {NominalDimensionsMm: s.dimensionsMm, ReachBasis: '손목까지 600mm + 핸드', RatedArmPayloadKg: s.payload, Previous10kgRequirementMet: false} : {}), PayloadBasis: s.payloadBasis ?? '툴·카메라 포함 플랜지 정격', SpecificationSource: s.source, Representation: r.kind === 'ammr' ? '공식 RB-Y1A v1.2 URDF·형상 + 추가 검사 카메라' : '공개 ROS 형상·관절 기반 시뮬레이션' } : {};
}
