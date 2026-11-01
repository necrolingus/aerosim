import { describe, expect, it } from 'vitest';
import { runSinglePhysicsBenchmark } from './testRunner';
import { analyticalSphereCd } from './analyticalCases';
import { createPresetGeometry } from '../geometry/presets';
import { computeMeshStats } from '../geometry/stlLoader';
import { voxelizeMeshToLattice } from '../geometry/voxelizer';
import { LBMCpuReferenceSolver } from '../solver/lbmCpuReference';
import { LBM_CONSTANTS } from '../solver/lbmConstants';
import {
  computeTrueMeshSurfaceArea,
  ForceConvergenceTracker,
  integrateLatticeMomentumExchange,
} from '../solver/forceIntegrator';
import { FLUID_PRESETS, type TunnelDimensions } from '../core/types';

describe('Deep Physics Validation Suite (Accuracy & Convergence)', () => {
  it('R2.3: Demonstrates monotonic grid convergence on smooth sphere towards Morrison target', () => {
    const resolutions = [
      { name: 'Coarse', ny: 24, nz: 24, nx: 48, steps: 300 },
      { name: 'Medium', ny: 36, nz: 36, nx: 60, steps: 350 },
      { name: 'Fine', ny: 48, nz: 48, nx: 72, steps: 400 },
    ];

    const tunnel: TunnelDimensions = { length: 6.0, width: 3.6, height: 3.6 };
    const geom = createPresetGeometry('sphere');
    const transform = {
      position: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
    const stats = computeMeshStats(geom, 'Sphere', transform);
    const trueSurfaceAreaM2 = computeTrueMeshSurfaceArea(geom);

    const targetU = 0.08;
    const targetRe = 400;
    const targetCd = analyticalSphereCd(targetRe);

    const measuredCds: number[] = [];

    for (const r of resolutions) {
      const grid = { nx: r.nx, ny: r.ny, nz: r.nz };
      const voxel = voxelizeMeshToLattice(geom, undefined, tunnel, grid);
      const cellsAcrossD = stats.characteristicLength / voxel.dx;
      const nuLattice = (targetU * cellsAcrossD) / targetRe;

      const solver = new LBMCpuReferenceSolver(voxel, {
        uInlet: 0.001,
        nuLattice,
        smagorinskyCs: LBM_CONSTANTS.DEFAULT_SMAGORINSKY_CS,
      });

      const tracker = new ForceConvergenceTracker();
      tracker.reset(40);
      const rampSteps = 80;
      let latestReadout = { meanCd: 0, meanCl: 0 };

      for (let s = 1; s <= r.steps; s++) {
        if (s <= rampSteps) {
          const frac = s / rampSteps;
          solver.uInlet = targetU * Math.sin(0.5 * Math.PI * frac) * Math.sin(0.5 * Math.PI * frac);
        } else {
          solver.uInlet = targetU;
        }

        solver.step(1);

        if (s > Math.floor(r.steps * 0.6)) {
          const forces = integrateLatticeMomentumExchange({
            voxel,
            fPreStream: solver.fDst,
            fPostBoundary: solver.fSrc,
            ux: solver.ux,
            uy: solver.uy,
            uz: solver.uz,
            rho: solver.rho,
            uInletLattice: targetU,
            nuLattice,
            trueSurfaceAreaM2,
            frontalAreaM2: stats.frontalArea,
            characteristicLengthM: stats.characteristicLength,
            boundingBoxSize: stats.boundingBoxSize,
            tunnel,
          });

          latestReadout = tracker.pushSample({
            step: solver.stepIndex,
            cd: forces.cdCorrected,
            cl: forces.cl,
            cm: forces.cmPitch,
            xcp: forces.centerOfPressureX,
            windSpeed: 25,
            fluid: FLUID_PRESETS.air_20c,
            frontalAreaM2: stats.frontalArea,
          });
        }
      }

      measuredCds.push(latestReadout.meanCd);
      console.log(
        `[Physics Deep Suite] Sphere ${r.name} (${cellsAcrossD.toFixed(1)} cells/D): Cd = ${latestReadout.meanCd.toFixed(3)} (Analytical Target = ${targetCd.toFixed(3)})`
      );
    }

    // Assert monotonic convergence: Coarse > Medium > Fine, bracketing empirical target
    expect(measuredCds[0]).toBeGreaterThan(measuredCds[1]);
    expect(measuredCds[1]).toBeGreaterThan(measuredCds[2]);
    expect(measuredCds[0]).toBeGreaterThanOrEqual(targetCd);
    expect(measuredCds[2]).toBeLessThanOrEqual(targetCd * 1.15);
  });

  it('validates Sharp-Edged Bluff Cube in fully developed wake flow (500 steps)', () => {
    const res = runSinglePhysicsBenchmark('cube', { steps: 500 });
    console.log(
      `[Physics Deep Suite] Bluff Cube: Cd = ${res.computedCd} (Target = ${res.effectiveTargetCd}, Error = ${res.relativeErrorPercent}%, Cl = ${res.computedCl})`
    );
    expect(res.computedCd).toBeGreaterThanOrEqual(res.toleranceMinCd);
    expect(res.computedCd).toBeLessThanOrEqual(res.toleranceMaxCd);
    expect(Math.abs(res.computedCl)).toBeLessThanOrEqual(0.02);
    expect(res.passed).toBe(true);
  });

  it('validates Finite Circular Cylinder (L/D=2) in developed wake flow (450 steps)', () => {
    const res = runSinglePhysicsBenchmark('cylinder', { steps: 450 });
    console.log(
      `[Physics Deep Suite] Finite Cylinder: Cd = ${res.computedCd} (Target = ${res.effectiveTargetCd}, Error = ${res.relativeErrorPercent}%, Cl = ${res.computedCl})`
    );
    expect(res.computedCd).toBeGreaterThanOrEqual(res.toleranceMinCd);
    expect(res.computedCd).toBeLessThanOrEqual(res.toleranceMaxCd);
    expect(res.passed).toBe(true);
  });
});
