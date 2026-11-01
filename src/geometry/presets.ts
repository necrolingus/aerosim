import * as THREE from 'three';
import type { PresetModelId } from '../core/types';

export interface PresetModelMetadata {
  id: PresetModelId;
  name: string;
  category: 'Calibration' | 'Rocketry' | 'Architecture';
  description: string;
  theoreticalCd: string;
  defaultGroundPlane: boolean;
}

export const PRESET_MODELS: Record<PresetModelId, PresetModelMetadata> = {
  sphere: {
    id: 'sphere',
    name: 'Calibration Sphere (Ø 1.0m)',
    category: 'Calibration',
    description: 'Smooth 1.0m diameter sphere. Analytical frontal area A_ref = π·r² ≈ 0.7854 m².',
    theoreticalCd: '0.47 (Subcritical Re)',
    defaultGroundPlane: false,
  },
  cube: {
    id: 'cube',
    name: 'Calibration Cube (1.0m³)',
    category: 'Calibration',
    description: 'Sharp-edged 1.0m × 1.0m × 1.0m bluff cube. Analytical frontal area A_ref = 1.0000 m² at 0°.',
    theoreticalCd: '1.05',
    defaultGroundPlane: false,
  },
  cylinder: {
    id: 'cylinder',
    name: 'Cross-Flow Cylinder (Ø 0.6m × 1.2m)',
    category: 'Calibration',
    description: 'Circular cylinder perpendicular to the wind for Karman vortex street shedding (St ≈ 0.20).',
    theoreticalCd: '1.17',
    defaultGroundPlane: false,
  },
  rocket_nose: {
    id: 'rocket_nose',
    name: 'Ogive Rocket Nose Cone (Ø 0.5m, L 1.4m)',
    category: 'Rocketry',
    description: 'Tangent ogive nose cone with cylindrical body skirt pointing into the +X wind.',
    theoreticalCd: '0.15 – 0.22',
    defaultGroundPlane: false,
  },
  shed: {
    id: 'shed',
    name: 'Gable-Roof Backyard Shed (1.2m × 1.0m × 0.9m)',
    category: 'Architecture',
    description: 'DIY gable-roof structure for inspecting roof uplift suction, windward stagnation, and leeward vortex traps.',
    theoreticalCd: '0.95 – 1.15',
    defaultGroundPlane: true,
  },
};

/**
 * Generates watertight, high-resolution procedural meshes for the 5 built-in calibration & domain presets.
 */
export function createPresetGeometry(id: PresetModelId): THREE.BufferGeometry {
  switch (id) {
    case 'sphere': {
      // 1.0m diameter -> radius = 0.5m. Use 96x64 segments so polyhedral radius matches analytical sphere closely.
      const geom = new THREE.SphereGeometry(0.5, 96, 64);
      geom.computeVertexNormals();
      return geom;
    }

    case 'cube': {
      // 1.0m x 1.0m x 1.0m cube centered at origin
      const geom = new THREE.BoxGeometry(1.0, 1.0, 1.0, 4, 4, 4);
      geom.computeVertexNormals();
      return geom;
    }

    case 'cylinder': {
      // Diameter 0.6m (radius 0.3m), height 1.2m along Z or Y axis (perpendicular to +X wind)
      const geom = new THREE.CylinderGeometry(0.3, 0.3, 1.2, 80, 4, false);
      geom.computeVertexNormals();
      return geom;
    }

    case 'rocket_nose': {
      // Tangent ogive nose cone pointing into incoming wind (-X tip, +X aft base)
      // Total length 1.4m (1.0m ogive + 0.4m body tube), base radius R = 0.25m (diameter 0.5m)
      const L = 1.0;
      const bodyL = 0.4;
      const R = 0.25;
      // Tangent ogive radius of curvature rho_o = (R^2 + L^2) / (2 * R)
      const rho = (R * R + L * L) / (2 * R);

      const points: THREE.Vector2[] = [];
      const axialSteps = 60;
      // Tip at x = 0
      for (let i = 0; i <= axialSteps; i++) {
        const x = (i / axialSteps) * L;
        const y = Math.sqrt(Math.max(0, rho * rho - (L - x) * (L - x))) + R - rho;
        points.push(new THREE.Vector2(Math.max(0, y), x));
      }
      // Cylindrical body tube section from L to L + bodyL
      points.push(new THREE.Vector2(R, L + bodyL));
      // Close aft base cap to centerline
      points.push(new THREE.Vector2(0, L + bodyL));

      const lathe = new THREE.LatheGeometry(points, 72);
      // LatheGeometry revolves around Y axis (from y = 0 to y = 1.4).
      // Rotate -90 deg around Z so tip is at -X (facing into +X wind) and base is at +X.
      lathe.rotateZ(-Math.PI / 2);
      lathe.center();
      lathe.computeVertexNormals();
      return lathe;
    }

    case 'shed': {
      // Watertight Gable-Roof Shed:
      // Width (X, streamwise depth) = 0.9m, Length (Z, spanwise) = 1.2m, Wall height = 0.65m, Ridge height = 0.95m
      const shape = new THREE.Shape();
      const hw = 0.45; // half-width along X
      const wallH = 0.65;
      const ridgeH = 0.95;

      shape.moveTo(-hw, 0);
      shape.lineTo(hw, 0);
      shape.lineTo(hw, wallH);
      shape.lineTo(0, ridgeH);
      shape.lineTo(-hw, wallH);
      shape.closePath();

      const extrudeSettings: THREE.ExtrudeGeometryOptions = {
        depth: 1.2,
        bevelEnabled: false,
        steps: 2,
      };

      const geom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
      geom.center();
      geom.computeVertexNormals();
      return geom;
    }
  }
}
