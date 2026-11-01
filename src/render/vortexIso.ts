import * as THREE from 'three';
import type { VoxelGridResult } from '../geometry/voxelizer';
import { sampleCFDColormap } from '../solver/lbmCpuReference';

export interface QCriterionResult {
  qValues: Float32Array;
  omegaMag: Float32Array;
  omegaVec: Float32Array; // 3 floats per cell: [ox, oy, oz]
  maxQ: number;
  maxOmega: number;
}

/**
 * Computes the Hunt et al. (1988) Q-Criterion and 3D vorticity vector field on the Cartesian grid:
 * Q = 0.5 * (||Omega||^2 - ||S||^2)
 *
 * where S = 0.5 * (grad(u) + grad(u)^T) is the symmetric strain rate tensor,
 * and Omega = 0.5 * (grad(u) - grad(u)^T) is the anti-symmetric spin tensor.
 *
 * Regions with Q > 0 indicate rotation-dominated coherent vortex cores.
 */
export function computeQCriterion(params: {
  nx: number;
  ny: number;
  nz: number;
  dx: number;
  ux: Float32Array;
  uy: Float32Array;
  uz: Float32Array;
  cellFlags?: Uint8Array;
}): QCriterionResult {
  const { nx, ny, nz, dx, ux, uy, uz, cellFlags } = params;
  const totalCells = nx * ny * nz;

  const qValues = new Float32Array(totalCells);
  const omegaMag = new Float32Array(totalCells);
  const omegaVec = new Float32Array(totalCells * 3);

  let maxQ = 1e-6;
  let maxOmega = 1e-6;

  const inv2dx = 1.0 / (2.0 * dx);

  const getIdx = (x: number, y: number, z: number) => x + nx * (y + ny * z);

  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const idx = getIdx(ix, iy, iz);

        // Skip solid cells
        if (cellFlags && cellFlags[idx] === 1) {
          continue;
        }

        const xPrev = Math.max(0, ix - 1);
        const xNext = Math.min(nx - 1, ix + 1);
        const yPrev = Math.max(0, iy - 1);
        const yNext = Math.min(ny - 1, iy + 1);
        const zPrev = Math.max(0, iz - 1);
        const zNext = Math.min(nz - 1, iz + 1);

        const dxScale = xNext > xPrev ? 1.0 / ((xNext - xPrev) * dx) : inv2dx;
        const dyScale = yNext > yPrev ? 1.0 / ((yNext - yPrev) * dx) : inv2dx;
        const dzScale = zNext > zPrev ? 1.0 / ((zNext - zPrev) * dx) : inv2dx;

        // Velocity gradient tensor: J_ij = d(u_i) / d(x_j)
        const dux_dx = (ux[getIdx(xNext, iy, iz)] - ux[getIdx(xPrev, iy, iz)]) * dxScale;
        const dux_dy = (ux[getIdx(ix, yNext, iz)] - ux[getIdx(ix, yPrev, iz)]) * dyScale;
        const dux_dz = (ux[getIdx(ix, iy, zNext)] - ux[getIdx(ix, iy, zPrev)]) * dzScale;

        const duy_dx = (uy[getIdx(xNext, iy, iz)] - uy[getIdx(xPrev, iy, iz)]) * dxScale;
        const duy_dy = (uy[getIdx(ix, yNext, iz)] - uy[getIdx(ix, yPrev, iz)]) * dyScale;
        const duy_dz = (uy[getIdx(ix, iy, zNext)] - uy[getIdx(ix, iy, zPrev)]) * dzScale;

        const duz_dx = (uz[getIdx(xNext, iy, iz)] - uz[getIdx(xPrev, iy, iz)]) * dxScale;
        const duz_dy = (uz[getIdx(ix, yNext, iz)] - uz[getIdx(ix, yPrev, iz)]) * dyScale;
        const duz_dz = (uz[getIdx(ix, iy, zNext)] - uz[getIdx(ix, iy, zPrev)]) * dzScale;

        // Strain rate tensor S_ij = 0.5 * (du_i/dx_j + du_j/dx_i)
        const S11 = dux_dx;
        const S22 = duy_dy;
        const S33 = duz_dz;
        const S12 = 0.5 * (dux_dy + duy_dx);
        const S13 = 0.5 * (dux_dz + duz_dx);
        const S23 = 0.5 * (duy_dz + duz_dy);

        const normS_sq =
          S11 * S11 + S22 * S22 + S33 * S33 + 2.0 * (S12 * S12 + S13 * S13 + S23 * S23);

        // Spin tensor Omega_ij = 0.5 * (du_i/dx_j - du_j/dx_i)
        const Om12 = 0.5 * (dux_dy - duy_dx);
        const Om13 = 0.5 * (dux_dz - duz_dx);
        const Om23 = 0.5 * (duy_dz - duz_dy);

        const normOm_sq = 2.0 * (Om12 * Om12 + Om13 * Om13 + Om23 * Om23);

        // Q-Criterion = 0.5 * (||Omega||^2 - ||S||^2)
        const qVal = 0.5 * (normOm_sq - normS_sq);
        qValues[idx] = qVal;
        if (qVal > maxQ) maxQ = qVal;

        // Vorticity vector: omega = curl(u) = [duz/dy - duy/dz, dux/dz - duz/dx, duy/dx - dux/dy]
        const ox = duz_dy - duy_dz;
        const oy = dux_dz - duz_dx;
        const oz = duy_dx - dux_dy;
        const omMag = Math.sqrt(ox * ox + oy * oy + oz * oz);

        omegaVec[idx * 3 + 0] = ox;
        omegaVec[idx * 3 + 1] = oy;
        omegaVec[idx * 3 + 2] = oz;
        omegaMag[idx] = omMag;
        if (omMag > maxOmega) maxOmega = omMag;
      }
    }
  }

  return { qValues, omegaMag, omegaVec, maxQ, maxOmega };
}

/**
 * 3D Coherent Vortex Core Visualizer using Q-Criterion isosurfaces and instanced vortex tubes.
 * Tubes align dynamically with the local 3D vorticity vector and are colored by vorticity intensity.
 */
export class VortexIsoVisualizer {
  private scene: THREE.Scene;
  private instancedMesh: THREE.InstancedMesh | null = null;
  private enabled = false;
  private threshold = 0.2; // 0.05 .. 1.0 fraction of maxQ
  private opacity = 0.85;
  private maxInstances = 8192;

  private dummyObject = new THREE.Object3D();
  private defaultOrientation = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.initInstancedMesh();
  }

  private initInstancedMesh(): void {
    if (this.instancedMesh) {
      this.scene.remove(this.instancedMesh);
      this.instancedMesh.geometry.dispose();
      (this.instancedMesh.material as THREE.Material).dispose();
      this.instancedMesh = null;
    }

    // Base geometry: smooth capsule aligned along Y axis
    const geom = new THREE.CylinderGeometry(0.5, 0.5, 1.0, 8, 1);
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.3,
      metalness: 0.1,
      transparent: true,
      opacity: this.opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.instancedMesh = new THREE.InstancedMesh(geom, mat, this.maxInstances);
    this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (this.instancedMesh.instanceColor) {
      this.instancedMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    this.instancedMesh.visible = this.enabled;
    this.instancedMesh.count = 0;
    this.scene.add(this.instancedMesh);
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.instancedMesh) {
      this.instancedMesh.visible = enabled;
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setThreshold(threshold: number): void {
    this.threshold = Math.max(0.01, Math.min(0.99, threshold));
  }

  public setOpacity(opacity: number): void {
    this.opacity = Math.max(0.1, Math.min(1.0, opacity));
    if (this.instancedMesh) {
      (this.instancedMesh.material as THREE.MeshStandardMaterial).opacity = this.opacity;
    }
  }

  /**
   * Updates 3D vortex cores from latest macroscopic velocity field.
   */
  public update(params: {
    voxel: VoxelGridResult;
    ux: Float32Array;
    uy: Float32Array;
    uz: Float32Array;
  }): void {
    if (!this.enabled || !this.instancedMesh) return;

    const { voxel, ux, uy, uz } = params;
    const { nx, ny, nz, dx, originX, originY, originZ, cellFlags } = voxel;

    const qResult = computeQCriterion({
      nx,
      ny,
      nz,
      dx,
      ux,
      uy,
      uz,
      cellFlags,
    });

    const cutoffQ = this.threshold * qResult.maxQ;
    const color = new THREE.Color();
    const rgb: [number, number, number] = [0, 0, 0];
    const rotQuat = new THREE.Quaternion();
    const targetDir = new THREE.Vector3();

    let instanceIdx = 0;

    for (let iz = 1; iz < nz - 1; iz++) {
      for (let iy = 1; iy < ny - 1; iy++) {
        for (let ix = 1; ix < nx - 1; ix++) {
          const idx = ix + nx * (iy + ny * iz);

          if (cellFlags && cellFlags[idx] === 1) continue;

          const qVal = qResult.qValues[idx];
          if (qVal < cutoffQ) continue;

          const ox = qResult.omegaVec[idx * 3 + 0];
          const oy = qResult.omegaVec[idx * 3 + 1];
          const oz = qResult.omegaVec[idx * 3 + 2];
          const omMag = qResult.omegaMag[idx];

          if (omMag < 1e-5) continue;

          // World position
          const px = originX + (ix + 0.5) * dx;
          const py = originY + (iy + 0.5) * dx;
          const pz = originZ + (iz + 0.5) * dx;

          this.dummyObject.position.set(px, py, pz);

          // Align cylinder with vorticity vector
          targetDir.set(ox / omMag, oy / omMag, oz / omMag);
          rotQuat.setFromUnitVectors(this.defaultOrientation, targetDir);
          this.dummyObject.quaternion.copy(rotQuat);

          // Tube radius scales with excess Q-value, length scales with dx
          const radiusNorm = Math.sqrt(Math.max(0, (qVal - cutoffQ) / Math.max(1e-6, qResult.maxQ)));
          const tubeRadius = (0.2 + 0.6 * radiusNorm) * dx;
          const tubeLength = dx * 1.15;
          this.dummyObject.scale.set(tubeRadius, tubeLength, tubeRadius);

          this.dummyObject.updateMatrix();
          this.instancedMesh.setMatrixAt(instanceIdx, this.dummyObject.matrix);

          // Color mapped by vorticity magnitude
          const normOmega = Math.min(1.0, omMag / Math.max(1e-4, qResult.maxOmega));
          sampleCFDColormap(normOmega, rgb);
          color.setRGB(rgb[0], rgb[1], rgb[2]);
          this.instancedMesh.setColorAt(instanceIdx, color);

          instanceIdx++;
          if (instanceIdx >= this.maxInstances) break;
        }
        if (instanceIdx >= this.maxInstances) break;
      }
      if (instanceIdx >= this.maxInstances) break;
    }

    this.instancedMesh.count = instanceIdx;
    this.instancedMesh.instanceMatrix.needsUpdate = true;
    if (this.instancedMesh.instanceColor) {
      this.instancedMesh.instanceColor.needsUpdate = true;
    }
  }

  public dispose(): void {
    if (this.instancedMesh) {
      this.scene.remove(this.instancedMesh);
      this.instancedMesh.geometry.dispose();
      (this.instancedMesh.material as THREE.Material).dispose();
      this.instancedMesh = null;
    }
  }
}
