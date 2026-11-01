import { describe, expect, it } from 'vitest';
import { runSinglePhysicsBenchmark } from './testRunner';
import { analyticalSphereCd } from './analyticalCases';
import { createPresetGeometry } from '../geometry/presets';
import { CELL_FLUID, CELL_SOLID, D3Q19_DIRECTIONS, voxelizeMeshToLattice } from '../geometry/voxelizer';
import { LBMCpuReferenceSolver } from '../solver/lbmCpuReference';
import { integrateLatticeMomentumExchange } from '../solver/forceIntegrator';
import { computeMeshStats } from '../geometry/stlLoader';

describe('Gate 4 Verification: Quantitative Aerodynamics, Force Integration & Physics Validation', () => {
  it('R3.5 Sanity: Zero inflow produces strictly zero hydrodynamic force (|F| < 1e-6)', () => {
    const geom = createPresetGeometry('sphere');
    const tunnel = { length: 4.8, height: 2.4, width: 2.4 };
    const grid = { nx: 48, ny: 24, nz: 24 };
    const voxel = voxelizeMeshToLattice(geom, undefined, tunnel, grid);
    const stats = computeMeshStats(geom, 'Sphere', {
      position: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });

    const solver = new LBMCpuReferenceSolver(voxel, {
      uInlet: 0.0, // Zero freestream flow
      nuLattice: 0.005,
    });
    solver.step(5);

    const forces = integrateLatticeMomentumExchange({
      voxel,
      fPreStream: solver.fDst,
      fPostBoundary: solver.fSrc,
      ux: solver.ux,
      uy: solver.uy,
      uz: solver.uz,
      rho: solver.rho,
      uInletLattice: 0.08,
      nuLattice: 0.005,
      trueSurfaceAreaM2: stats.frontalArea * 4,
      frontalAreaM2: stats.frontalArea,
      characteristicLengthM: stats.characteristicLength,
      boundingBoxSize: stats.boundingBoxSize,
      tunnel,
    });

    expect(Math.abs(forces.fxLattice)).toBeLessThan(1e-6);
    expect(Math.abs(forces.fyLattice)).toBeLessThan(1e-6);
    expect(Math.abs(forces.fzLattice)).toBeLessThan(1e-6);
    expect(Math.abs(forces.cdRaw)).toBeLessThan(1e-6);
    expect(Math.abs(forces.cl)).toBeLessThan(1e-6);
  });

  it('R2.1 & R2.4 Geometry Sanity: Strict cubic cells (dx===dy===dz) and voxel link consistency', () => {
    const presets = ['sphere', 'cube', 'cylinder', 'rocket_nose', 'shed'] as const;
    const tunnel = { length: 5.4, height: 2.7, width: 2.7 };
    const grid = { nx: 54, ny: 27, nz: 27 };

    for (const id of presets) {
      const geom = createPresetGeometry(id);
      const voxel = voxelizeMeshToLattice(geom, undefined, tunnel, grid);

      // R2.1: Assert cubic cell property
      expect(voxel.dx).toBe(voxel.dy);
      expect(voxel.dy).toBe(voxel.dz);

      // R2.4: Assert no CELL_FLUID touches CELL_SOLID, and boundary links match solid neighbors
      const { nx, ny, nz, cellFlags, boundaryCellCount, boundaryCellIndices, boundaryQValues } = voxel;

      // Check all cells: no CELL_FLUID may be directly adjacent to a CELL_SOLID
      for (let idx = 0; idx < nx * ny * nz; idx++) {
        if (cellFlags[idx] === CELL_FLUID) {
          const ix = idx % nx;
          const rem = (idx - ix) / nx;
          const iy = rem % ny;
          const iz = (rem - iy) / ny;

          for (let d = 1; d <= 18; d++) {
            const dir = D3Q19_DIRECTIONS[d];
            const nix = ix + dir[0];
            const niy = iy + dir[1];
            const niz = iz + dir[2];
            if (nix >= 0 && nix < nx && niy >= 0 && niy < ny && niz >= 0 && niz < nz) {
              const nIdx = nix + nx * (niy + ny * niz);
              expect(cellFlags[nIdx]).not.toBe(CELL_SOLID);
            }
          }
        }
      }

      // Check boundary cells: every link pointing to a solid neighbor must have q in (0, 1]
      for (let bIdx = 0; bIdx < boundaryCellCount; bIdx++) {
        const cellIdx = boundaryCellIndices[bIdx];
        const ix = cellIdx % nx;
        const rem = (cellIdx - ix) / nx;
        const iy = rem % ny;
        const iz = (rem - iy) / ny;

        const qBase = bIdx * 18;
        for (let d = 1; d <= 18; d++) {
          const dir = D3Q19_DIRECTIONS[d];
          const nix = ix + dir[0];
          const niy = iy + dir[1];
          const niz = iz + dir[2];
          const q = boundaryQValues[qBase + (d - 1)];

          if (nix >= 0 && nix < nx && niy >= 0 && niy < ny && niz >= 0 && niz < nz) {
            const nIdx = nix + nx * (niy + ny * niz);
            if (cellFlags[nIdx] === CELL_SOLID) {
              expect(q).toBeGreaterThan(0.0);
              expect(q).toBeLessThanOrEqual(1.0);
            } else {
              expect(q).toBe(-1.0);
            }
          }
        }
      }
    }
  });

  it('validates Sharp-Edged Bluff Cube drag coefficient (Cd ≈ 1.05)', () => {
    const res = runSinglePhysicsBenchmark('cube', { steps: 350 });
    console.log(
      `[Gate 4] Bluff Cube: Computed Cd = ${res.computedCd} (Target = ${res.effectiveTargetCd}, Band = [${res.toleranceMinCd}, ${res.toleranceMaxCd}], Error = ${res.relativeErrorPercent}%, Cl = ${res.computedCl})`
    );
    expect(res.computedCd).toBeGreaterThanOrEqual(res.toleranceMinCd);
    expect(res.computedCd).toBeLessThanOrEqual(res.toleranceMaxCd);
    expect(Math.abs(res.computedCl)).toBeLessThanOrEqual(0.02); // R3.5 symmetry
    expect(res.passed).toBe(true);
  });

  it('validates Smooth Sphere drag coefficient (matches Morrison curve at simulated Re)', () => {
    const res = runSinglePhysicsBenchmark('sphere', { steps: 350 });
    console.log(
      `[Gate 4] Smooth Sphere: Computed Cd = ${res.computedCd} (Target = ${res.effectiveTargetCd}, Band = [${res.toleranceMinCd}, ${res.toleranceMaxCd}], Error = ${res.relativeErrorPercent}%, Re = ${res.simulatedRe})`
    );
    expect(res.computedCd).toBeGreaterThanOrEqual(res.toleranceMinCd);
    expect(res.computedCd).toBeLessThanOrEqual(res.toleranceMaxCd);
    expect(Math.abs(res.computedCl)).toBeLessThanOrEqual(0.02); // R3.5 symmetry
    expect(res.passed).toBe(true);
  });

  it('validates Finite Circular Cylinder (L/D=2) cross-flow drag coefficient (Hoerner Cd ≈ 0.68)', () => {
    const res = runSinglePhysicsBenchmark('cylinder', { steps: 350 });
    console.log(
      `[Gate 4] Finite Cylinder (L/D=2): Computed Cd = ${res.computedCd} (Target = ${res.effectiveTargetCd}, Band = [${res.toleranceMinCd}, ${res.toleranceMaxCd}], Error = ${res.relativeErrorPercent}%, Cl = ${res.computedCl})`
    );
    expect(res.computedCd).toBeGreaterThanOrEqual(res.toleranceMinCd);
    expect(res.computedCd).toBeLessThanOrEqual(res.toleranceMaxCd);
    expect(res.passed).toBe(true);
  });

  it('validates Streamlined Ogive Rocket Nose Cone drag coefficient', () => {
    const res = runSinglePhysicsBenchmark('rocket_nose', { steps: 350 });
    console.log(
      `[Gate 4] Ogive Rocket Nose Cone: Computed Cd = ${res.computedCd} (Target = ${res.effectiveTargetCd}, Band = [${res.toleranceMinCd}, ${res.toleranceMaxCd}], Error = ${res.relativeErrorPercent}%, Cl = ${res.computedCl})`
    );
    expect(res.computedCd).toBeGreaterThanOrEqual(res.toleranceMinCd);
    expect(res.computedCd).toBeLessThanOrEqual(res.toleranceMaxCd);
    expect(res.passed).toBe(true);
  });

  it('matches Morrison empirical Sphere Cd(Re) curve across subcritical Reynolds numbers', () => {
    const cdRe1e4 = analyticalSphereCd(1e4);
    const cdRe1e5 = analyticalSphereCd(1e5);
    expect(cdRe1e4).toBeGreaterThan(0.38);
    expect(cdRe1e4).toBeLessThan(0.50);
    expect(cdRe1e5).toBeGreaterThan(0.42);
    expect(cdRe1e5).toBeLessThan(0.52);
  });
});
