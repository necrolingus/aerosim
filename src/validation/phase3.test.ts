import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { voxelizeMeshToLattice } from '../geometry/voxelizer';
import { LBMCpuReferenceSolver } from '../solver/lbmCpuReference';
import { createPresetGeometry } from '../geometry/presets';

describe('Gate 3 Verification: Core 3D Fluid Solver (D3Q19 Regularized LBM + Smagorinsky LES)', () => {
  it('maintains strict mass conservation and unconditional stability over 10,000 steps at Re = 100,000 without NaN/divergence', () => {
    const sphereGeom = createPresetGeometry('sphere'); // 1.0m diameter sphere
    const tunnel = { length: 4.0, height: 2.0, width: 2.0 };
    // Compact 3D grid so 10,000 steps execute in ~4 seconds in unit tests
    const grid = { nx: 16, ny: 8, nz: 8 };

    const voxel = voxelizeMeshToLattice(sphereGeom, undefined, tunnel, grid);

    // For Re = U_lat * D_lat / nu_lat = 100,000:
    // D_lat = 6 cells, U_lat = 0.09 => nu_lat = (0.09 * 6) / 100,000 = 5.4e-6
    const uInlet = 0.09;
    const dLat = 6.0;
    const targetRe = 100000;
    const nuLattice = (uInlet * dLat) / targetRe;

    const solver = new LBMCpuReferenceSolver(voxel, {
      uInlet,
      nuLattice,
      smagorinskyCs: 0.14,
      groundNoSlip: false,
    });

    const initialStats = solver.computeFluidMassStats();
    expect(initialStats.hasNaN).toBe(false);
    expect(initialStats.meanRho).toBeCloseTo(1.0, 3);

    // Run 10,000 full 3D D3Q19 LBM + LES steps at Re = 100,000
    solver.step(10000);

    const finalStats = solver.computeFluidMassStats();
    expect(finalStats.hasNaN).toBe(false);
    // Mean fluid density must remain conserved within 1.5% of ambient rho0 = 1.0
    expect(Math.abs(finalStats.meanRho - 1.0)).toBeLessThan(0.015);
    expect(finalStats.maxSpeed).toBeGreaterThan(0.01);
    expect(finalStats.maxSpeed).toBeLessThan(0.25);
  });

  it('spontaneously develops an alternating Karman Vortex Street behind a circular cylinder with Strouhal number St = f*D/U ≈ 0.20', () => {
    // 2D-extruded (quasi-3D) circular cylinder perpendicular to +X flow:
    // Diameter D = 0.25 m -> D_lat = 5 lattice cells (dx = 0.05 m), H = 2.0 m (ny = 40 -> 12.5% blockage)
    const D = 0.25;
    const cylGeom = new THREE.CylinderGeometry(D / 2, D / 2, 1.0, 64, 1, false);
    // CylinderGeometry is aligned along Y by default; rotate 90 deg around X so cylinder axis is along Z (spanwise)
    cylGeom.rotateX(Math.PI / 2);
    // Place cylinder upstream at x = -1.2m so there is a long wake region downstream
    const worldMatrix = new THREE.Matrix4().makeTranslation(-1.2, 0.0, 0.0);

    const tunnel = { length: 4.8, height: 2.0, width: 0.15 };
    const grid = { nx: 96, ny: 40, nz: 3 }; // dx = dy = 0.05m -> D_lat = 5.0 cells
    const voxel = voxelizeMeshToLattice(cylGeom, worldMatrix, tunnel, grid);

    // Classic Karman Vortex Street regime: Re = 180 (U_lat = 0.10, D_lat = 5.0 => nu_lat = 0.00277)
    const uInlet = 0.10;
    const dLat = 5.0;
    const nuLattice = (uInlet * dLat) / 180.0;

    const solver = new LBMCpuReferenceSolver(voxel, {
      uInlet,
      nuLattice,
      smagorinskyCs: 0.04,
      groundNoSlip: false,
    });

    // Probe point in the cylinder wake: 3 diameters downstream of cylinder center along centerline (y = ny/2, z = 1)
    // Cylinder center is at x = -1.2m -> ix = (-1.2 - (-2.4)) / 0.05 = 24.
    // 3 * D_lat downstream -> ix = 24 + 15 = 39.
    const probeIx = 39;
    const probeIy = Math.floor(grid.ny / 2);
    const probeIz = 1;
    const probeIdx = probeIx + grid.nx * (probeIy + grid.ny * probeIz);

    // Warmup 700 steps for initial boundary layer separation and vortex street onset
    solver.step(700);

    const sampleSteps = 1400;
    const uyHistory = new Float32Array(sampleSteps);
    for (let s = 0; s < sampleSteps; s++) {
      solver.step(1);
      uyHistory[s] = solver.uy[probeIdx];
    }

    // Remove DC mean and count zero-crossings (rising edge) + peak oscillation amplitude
    let meanUy = 0;
    let maxAmp = 0;
    for (let s = 0; s < sampleSteps; s++) {
      meanUy += uyHistory[s];
    }
    meanUy /= sampleSteps;

    const crossingSteps: number[] = [];
    for (let s = 1; s < sampleSteps; s++) {
      const prev = uyHistory[s - 1] - meanUy;
      const curr = uyHistory[s] - meanUy;
      if (Math.abs(curr) > maxAmp) maxAmp = Math.abs(curr);
      if (prev <= 0 && curr > 0) {
        // Linear interpolation for sub-step crossing time
        const frac = -prev / Math.max(1e-12, curr - prev);
        crossingSteps.push(s - 1 + frac);
      }
    }

    expect(maxAmp).toBeGreaterThan(1e-4);
    expect(crossingSteps.length).toBeGreaterThanOrEqual(2);

    // Compute average shedding period T (in lattice steps) between consecutive rising zero-crossings
    const firstCross = crossingSteps[0];
    const lastCross = crossingSteps[crossingSteps.length - 1];
    const avgPeriodSteps = (lastCross - firstCross) / (crossingSteps.length - 1);
    const freqLattice = 1.0 / avgPeriodSteps;

    // Strouhal number St = (f_lat * D_lat) / U_lat
    const strouhal = (freqLattice * dLat) / uInlet;

    // Textbook Strouhal number for a circular cylinder at Re ~ 150-1000 is St ≈ 0.16 - 0.23
    expect(strouhal).toBeGreaterThan(0.14);
    expect(strouhal).toBeLessThan(0.25);
  });
});
