import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MeshBVH } from '../geometry/bvh';
import {
  CELL_BOUNDARY,
  CELL_FLUID,
  CELL_SOLID,
  D3Q19_DIRECTIONS,
  voxelizeMeshToLattice,
} from '../geometry/voxelizer';
import { createPresetGeometry } from '../geometry/presets';

/**
 * Exact analytical ray-sphere intersection parameter t in (0, 1] for a sphere centered at (0,0,0)
 * with radius R, from fluid point F = (fx, fy, fz) outside the sphere (|F| > R) to solid point
 * S = F + V inside the sphere (|F + V| <= R).
 */
function analyticalSphereLinkQ(
  fx: number,
  fy: number,
  fz: number,
  vx: number,
  vy: number,
  vz: number,
  radius: number
): number {
  // |F + t * V|^2 = R^2  =>  (V.V) t^2 + 2 (F.V) t + (F.F - R^2) = 0
  const a = vx * vx + vy * vy + vz * vz;
  const b = 2.0 * (fx * vx + fy * vy + fz * vz);
  const c = fx * fx + fy * fy + fz * fz - radius * radius;
  const disc = b * b - 4.0 * a * c;
  if (disc < 0) return -1;
  const sqrtD = Math.sqrt(disc);
  const t1 = (-b - sqrtD) / (2.0 * a);
  const t2 = (-b + sqrtD) / (2.0 * a);
  if (t1 >= 0 && t1 <= 1.0) return t1;
  if (t2 >= 0 && t2 <= 1.0) return t2;
  return -1;
}

describe('Gate 2 Verification: Sub-Grid STL Voxelizer, BVH & Curved-Wall Distance Engine', () => {
  it('classifies inside/outside cells accurately on watertight meshes (Sphere & Cube)', () => {
    const cubeGeom = createPresetGeometry('cube'); // 1.0m x 1.0m x 1.0m centered at (0,0,0)
    const tunnel = { length: 4.0, height: 2.0, width: 2.0 };
    const grid = { nx: 80, ny: 40, nz: 40 }; // dx = dy = dz = 0.05m

    const result = voxelizeMeshToLattice(cubeGeom, undefined, tunnel, grid);

    // A 1m^3 cube with 0.05m cells spans exactly 20 x 20 x 20 = 8,000 solid cells!
    expect(result.solidCellCount).toBe(8000);
    expect(result.boundaryCellCount).toBeGreaterThan(2400);

    // Verify center of cube (0,0,0) -> (ix=40, iy=20, iz=20) is CELL_SOLID
    const centerIdx = 40 + 80 * (20 + 40 * 20);
    expect(result.cellFlags[centerIdx]).toBe(CELL_SOLID);

    // Verify far-field corner (ix=2, iy=2, iz=2) is CELL_FLUID
    const farIdx = 2 + 80 * (2 + 40 * 2);
    expect(result.cellFlags[farIdx]).toBe(CELL_FLUID);
  });

  it('classifies inside/outside cells robustly on a slightly non-manifold mesh (cube with missing face triangle)', () => {
    // Build a 1m cube and deliberately remove 1 triangle from its top face to make it non-manifold
    const rawCube = new THREE.BoxGeometry(1.0, 1.0, 1.0, 4, 4, 4).toNonIndexed();
    const posAttr = rawCube.getAttribute('position');
    const totalVerts = posAttr.count;
    // Drop the last triangle (3 vertices) so there is an open hole on one face
    const trimmedPositions = new Float32Array((totalVerts - 3) * 3);
    for (let i = 0; i < trimmedPositions.length; i++) {
      trimmedPositions[i] = (posAttr.array as Float32Array)[i];
    }
    const nonManifoldGeom = new THREE.BufferGeometry();
    nonManifoldGeom.setAttribute('position', new THREE.BufferAttribute(trimmedPositions, 3));

    const bvh = new MeshBVH(nonManifoldGeom);
    // Point inside the non-manifold cube should still be classified as inside via 3-ray majority vote
    expect(bvh.isPointInside(0.0, 0.0, 0.0)).toBe(true);
    expect(bvh.isPointInside(0.2, -0.1, 0.15)).toBe(true);
    // Point outside the cube should be classified as outside
    expect(bvh.isPointInside(0.8, 0.0, 0.0)).toBe(false);
    expect(bvh.isPointInside(0.0, 0.9, 0.0)).toBe(false);
  });

  it('matches exact analytical ray-sphere intersection for sub-grid q-distances to within 10^-4', () => {
    // Use a fine-tessellation sphere so the polyhedral chord sagitta (R * pi^2 / (2 * N^2) / dx) is < 5e-5
    const R = 0.5;
    const highSphere = new THREE.SphereGeometry(R, 840, 560);
    const tunnel = { length: 2.0, height: 2.0, width: 2.0 };
    const grid = { nx: 40, ny: 40, nz: 40 }; // dx = 0.05m

    const result = voxelizeMeshToLattice(highSphere, undefined, tunnel, grid);
    expect(result.boundaryCellCount).toBeGreaterThan(500);

    let meanError = 0;
    let comparedLinks = 0;

    for (let bIdx = 0; bIdx < result.boundaryCellCount; bIdx++) {
      const cellIdx = result.boundaryCellIndices[bIdx];
      const ix = cellIdx % grid.nx;
      const rem = (cellIdx - ix) / grid.nx;
      const iy = rem % grid.ny;
      const iz = (rem - iy) / grid.ny;

      const fx = result.originX + (ix + 0.5) * result.dx;
      const fy = result.originY + (iy + 0.5) * result.dy;
      const fz = result.originZ + (iz + 0.5) * result.dz;

      for (let d = 1; d <= 18; d++) {
        const qMesh = result.boundaryQValues[bIdx * 18 + (d - 1)];
        if (qMesh < 0) continue; // Not a cut solid link

        const dir = D3Q19_DIRECTIONS[d];
        const vx = dir[0] * result.dx;
        const vy = dir[1] * result.dy;
        const vz = dir[2] * result.dz;

        const qExact = analyticalSphereLinkQ(fx, fy, fz, vx, vy, vz, R);
        if (qExact > 0) {
          const err = Math.abs(qMesh - qExact);
          meanError += err;
          comparedLinks++;
        }
      }
    }

    meanError /= Math.max(1, comparedLinks);
    expect(comparedLinks).toBeGreaterThan(1000);
    expect(meanError).toBeLessThan(1e-4);
  });

  it('completes 3D voxelization and sub-grid q-distance calculation in < 50 ms for real-time interactive mode', () => {
    const rocketGeom = createPresetGeometry('rocket_nose');
    const rotMatrix = new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(12));
    const tunnel = { length: 6.0, width: 2.8, height: 2.4 };
    const interactiveGrid = { nx: 128, ny: 64, nz: 64 };

    // Warmup JIT
    voxelizeMeshToLattice(rocketGeom, rotMatrix, tunnel, interactiveGrid);

    const t0 = performance.now();
    const res = voxelizeMeshToLattice(rocketGeom, rotMatrix, tunnel, interactiveGrid);
    const elapsedMs = performance.now() - t0;

    expect(res.solidCellCount).toBeGreaterThan(100);
    expect(res.boundaryCellCount).toBeGreaterThan(100);
    expect(res.cellFlags[res.boundaryCellIndices[0]]).toBe(CELL_BOUNDARY);
    expect(elapsedMs).toBeLessThan(50);
  });
});
