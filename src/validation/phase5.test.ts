import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeQCriterion } from '../render/vortexIso';
import { sampleVelocityTrilinear } from '../render/streamlines';
import { computeProbePhysics } from '../render/pointProbe';
import { FLUID_PRESETS } from '../core/types';
import { LBMCpuReferenceSolver } from '../solver/lbmCpuReference';
import { voxelizeMeshToLattice } from '../geometry/voxelizer';
import { createPresetGeometry } from '../geometry/presets';

describe('Gate 5 Verification: Advanced 3D Visualizations & Diagnostics', () => {
  describe('1. Q-Criterion Mathematical Formulation & Coherent Vortex Detection', () => {
    it('correctly evaluates Q > 0 for pure solid-body rotation', () => {
      const nx = 16;
      const ny = 16;
      const nz = 16;
      const dx = 0.1;
      const totalCells = nx * ny * nz;

      const ux = new Float32Array(totalCells);
      const uy = new Float32Array(totalCells);
      const uz = new Float32Array(totalCells);

      const omega0 = 5.0; // rad/s
      const cx = (nx - 1) / 2;
      const cy = (ny - 1) / 2;

      // Solid body rotation: u = -omega * (y - cy) * dx, v = +omega * (x - cx) * dx, w = 0
      for (let iz = 0; iz < nz; iz++) {
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            const idx = ix + nx * (iy + ny * iz);
            const x = (ix - cx) * dx;
            const y = (iy - cy) * dx;
            ux[idx] = -omega0 * y;
            uy[idx] = omega0 * x;
            uz[idx] = 0.0;
          }
        }
      }

      const res = computeQCriterion({ nx, ny, nz, dx, ux, uy, uz });

      // In pure solid body rotation: S = 0, Omega_12 = -omega0
      // Q = 0.5 * (||Omega||^2 - ||S||^2) = 0.5 * (2 * omega0^2 - 0) = omega0^2 = 25.0
      const midIdx = Math.floor(nx / 2) + nx * (Math.floor(ny / 2) + ny * Math.floor(nz / 2));
      const midQ = res.qValues[midIdx];
      expect(midQ).toBeGreaterThan(20.0);
      expect(midQ).toBeLessThanOrEqual(25.5);
      expect(res.omegaMag[midIdx]).toBeCloseTo(2 * omega0, 0.5); // curl(u)_z = 2 * omega0 = 10
    });

    it('correctly evaluates Q = 0 for pure simple shear flow (shear layer without coherent rotation)', () => {
      const nx = 16;
      const ny = 16;
      const nz = 16;
      const dx = 0.1;
      const totalCells = nx * ny * nz;

      const ux = new Float32Array(totalCells);
      const uy = new Float32Array(totalCells);
      const uz = new Float32Array(totalCells);

      const gammaDot = 4.0; // 1/s shear rate

      // Simple shear flow: u = gammaDot * y, v = 0, w = 0
      for (let iz = 0; iz < nz; iz++) {
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            const idx = ix + nx * (iy + ny * iz);
            ux[idx] = gammaDot * (iy * dx);
            uy[idx] = 0.0;
            uz[idx] = 0.0;
          }
        }
      }

      const res = computeQCriterion({ nx, ny, nz, dx, ux, uy, uz });

      // In simple shear: ||S||^2 = 0.5 * gammaDot^2, ||Omega||^2 = 0.5 * gammaDot^2
      // Q = 0.5 * (||Omega||^2 - ||S||^2) === 0.0 !
      const midIdx = Math.floor(nx / 2) + nx * (Math.floor(ny / 2) + ny * Math.floor(nz / 2));
      expect(Math.abs(res.qValues[midIdx])).toBeLessThan(1e-4);
    });

    it('detects strong coherent vortex cores (Q > 0) in the wake of an obstacle', () => {
      const tunnel = { length: 3.0, width: 1.5, height: 1.5 };
      const targetGrid = { nx: 36, ny: 18, nz: 18 };
      const geom = createPresetGeometry('cube');
      const worldMatrix = new THREE.Matrix4().makeScale(0.4, 0.4, 0.4);

      const voxel = voxelizeMeshToLattice(geom, worldMatrix, tunnel, targetGrid);
      const uInlet = 0.085;
      const solver = new LBMCpuReferenceSolver(voxel, {
        uInlet,
        nuLattice: 0.005,
        smagorinskyCs: 0.12,
      });

      // Advance flow until wake separates and forms vortex shear layers
      solver.step(80);

      const qRes = computeQCriterion({
        nx: voxel.nx,
        ny: voxel.ny,
        nz: voxel.nz,
        dx: voxel.dx,
        ux: solver.ux,
        uy: solver.uy,
        uz: solver.uz,
        cellFlags: voxel.cellFlags,
      });

      expect(qRes.maxQ).toBeGreaterThan(0.0001);
      expect(qRes.maxOmega).toBeGreaterThan(0.01);
    });
  });

  describe('2. Surface Pressure & Aerodynamic Stagnation Point Verification', () => {
    it('measures positive stagnation pressure Cp ≈ +1.0 at obstacle windward face and negative Cp in the wake', () => {
      const tunnel = { length: 3.0, width: 1.5, height: 1.5 };
      const targetGrid = { nx: 40, ny: 20, nz: 20 };
      const geom = createPresetGeometry('cube');
      const worldMatrix = new THREE.Matrix4().makeScale(0.45, 0.45, 0.45);

      const voxel = voxelizeMeshToLattice(geom, worldMatrix, tunnel, targetGrid);
      const uInlet = 0.08;
      const solver = new LBMCpuReferenceSolver(voxel, {
        uInlet,
        nuLattice: 0.004,
        smagorinskyCs: 0.12,
      });

      // Develop flow
      solver.step(90);

      const { nx, ny, nz, cellFlags } = voxel;
      const qLat = 0.5 * 1.0 * uInlet * uInlet;

      // Find windward (+X facing) and leeward (-X facing) boundary cells near center
      const midY = Math.floor(ny / 2);
      const midZ = Math.floor(nz / 2);

      let windwardX = -1;
      let leewardX = -1;

      for (let ix = 0; ix < nx; ix++) {
        const idx = ix + nx * (midY + ny * midZ);
        if (cellFlags[idx] === 1 && windwardX === -1) {
          windwardX = ix - 1; // Fluid cell directly in front of cube
        }
        if (cellFlags[idx] === 1) {
          leewardX = ix + 1; // Fluid cell directly behind cube
        }
      }

      expect(windwardX).toBeGreaterThan(0);
      expect(leewardX).toBeGreaterThan(windwardX);

      const stagIdx = windwardX + nx * (midY + ny * midZ);
      const wakeIdx = leewardX + nx * (midY + ny * midZ);

      const stagRho = solver.rho[stagIdx];
      const wakeRho = solver.rho[wakeIdx];

      // Physical Cp = (1/3 * (rho - 1)) / (0.5 * u^2)
      const stagCp = ((1.0 / 3.0) * (stagRho - 1.0)) / qLat;
      const wakeCp = ((1.0 / 3.0) * (wakeRho - 1.0)) / qLat;

      // Front stagnation point has high pressure: Cp near +1.0
      expect(stagCp).toBeGreaterThan(0.65);
      expect(stagCp).toBeLessThan(1.35);

      // Separated wake has negative suction pressure: Cp < 0.0
      expect(wakeCp).toBeLessThan(0.0);
    });
  });

  describe('3. Streamline Tracing & Trilinear Advection', () => {
    it('trilinearly interpolates velocity correctly within bounds and clamps outside', () => {
      const nx = 4;
      const ny = 4;
      const nz = 4;
      const total = nx * ny * nz;

      const ux = new Float32Array(total).fill(10.0);
      const uy = new Float32Array(total).fill(2.0);
      const uz = new Float32Array(total).fill(-1.0);

      const out = { x: 0, y: 0, z: 0 };

      // In center of domain
      const ok = sampleVelocityTrilinear(1.5, 1.5, 1.5, nx, ny, nz, ux, uy, uz, out);
      expect(ok).toBe(true);
      expect(out.x).toBeCloseTo(10.0, 4);
      expect(out.y).toBeCloseTo(2.0, 4);
      expect(out.z).toBeCloseTo(-1.0, 4);

      // Outside domain
      const outside = sampleVelocityTrilinear(-0.5, 2.0, 2.0, nx, ny, nz, ux, uy, uz, out);
      expect(outside).toBe(false);
      expect(out.x).toBe(0);
    });

    it('advects streamlines forward through uniform flow along +X without divergence', () => {
      const nx = 12;
      const ny = 8;
      const nz = 8;
      const total = nx * ny * nz;
      const dx = 0.2;

      const ux = new Float32Array(total).fill(0.08);
      const uy = new Float32Array(total).fill(0.0);
      const uz = new Float32Array(total).fill(0.0);

      let curX = 0.5 * dx;
      let curY = 4.0 * dx;
      let curZ = 4.0 * dx;

      const ds = dx * 0.5;
      const v = { x: 0, y: 0, z: 0 };

      for (let step = 0; step < 15; step++) {
        const fx = curX / dx - 0.5;
        const fy = curY / dx - 0.5;
        const fz = curZ / dx - 0.5;

        const valid = sampleVelocityTrilinear(fx, fy, fz, nx, ny, nz, ux, uy, uz, v);
        expect(valid).toBe(true);

        const spd = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        curX += (ds * v.x) / spd;
        curY += (ds * v.y) / spd;
        curZ += (ds * v.z) / spd;
      }

      expect(curX).toBeGreaterThan(1.0);
      expect(curY).toBeCloseTo(4.0 * dx, 4);
      expect(curZ).toBeCloseTo(4.0 * dx, 4);
    });
  });

  describe('4. Interactive Point Probe Physical Readouts', () => {
    it('computes exact fluid mechanics telemetry from macroscopic state', () => {
      const air = FLUID_PRESETS.air_20c;
      const windSpeedMps = 30.0;
      const uInletLattice = 0.085;

      // At a stagnation point: u = 0, rho = 1 + 0.5 * uInlet^2 / cs^2 => Cp = 1.0
      const csSq = 1.0 / 3.0;
      const qLat = 0.5 * uInletLattice * uInletLattice;
      const stagRho = 1.0 + qLat / csSq;

      const readout = computeProbePhysics({
        localRho: stagRho,
        localUx: 0.0,
        localUy: 0.0,
        localUz: 0.0,
        windSpeedMps,
        uInletLattice,
        fluid: air,
        worldPos: { x: 0, y: 0, z: 0 },
        latticeCell: { ix: 10, iy: 10, iz: 10 },
      });

      expect(readout.speedMps).toBe(0);
      expect(readout.speedMph).toBe(0);
      expect(readout.pressureCoeffCp).toBeCloseTo(1.0, 3);

      const qDyn = 0.5 * air.density * windSpeedMps * windSpeedMps; // 0.5 * 1.204 * 900 = 541.8 Pa
      expect(readout.gaugePressurePa).toBeCloseTo(qDyn, 1);
    });

    it('returns zero flow and marks solid flag for interior mesh probe locations', () => {
      const readout = computeProbePhysics({
        localRho: 1.0,
        localUx: 0.08,
        localUy: 0.0,
        localUz: 0.0,
        windSpeedMps: 25.0,
        uInletLattice: 0.085,
        fluid: FLUID_PRESETS.air_20c,
        isSolid: true,
        worldPos: { x: 0, y: 0, z: 0 },
        latticeCell: { ix: 5, iy: 5, iz: 5 },
      });

      expect(readout.isInsideSolid).toBe(true);
      expect(readout.speedMps).toBe(0);
      expect(readout.gaugePressurePa).toBe(0);
    });
  });
});
