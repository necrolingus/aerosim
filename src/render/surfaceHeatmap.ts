import * as THREE from 'three';
import type { VoxelGridResult } from '../geometry/voxelizer';
import { sampleCFDColormap } from '../solver/lbmCpuReference';

export type SurfaceHeatmapMode = 'off' | 'cp' | 'drag';

/**
 * Projects local 3D surface pressure coefficient (Cp) or local aerodynamic drag
 * onto the STL mesh vertices in real time, rendering a high-contrast Green / Orange / Red
 * scientific aerodynamic surface heatmap.
 */
export class SurfaceHeatmapRenderer {
  private activeMesh: THREE.Mesh | null = null;
  private currentMode: SurfaceHeatmapMode = 'off';
  private originalMaterial: THREE.Material | THREE.Material[] | null = null;
  private heatmapMaterial: THREE.MeshStandardMaterial;

  constructor() {
    this.heatmapMaterial = new THREE.MeshStandardMaterial({
      roughness: 0.35,
      metalness: 0.1,
      vertexColors: true,
      side: THREE.DoubleSide,
    });
  }

  public setMesh(mesh: THREE.Mesh | null): void {
    if (this.activeMesh && this.originalMaterial) {
      this.activeMesh.material = this.originalMaterial;
    }
    this.activeMesh = mesh;
    if (mesh) {
      this.originalMaterial = mesh.material;
      if (this.currentMode !== 'off') {
        mesh.material = this.heatmapMaterial;
      }
    } else {
      this.originalMaterial = null;
    }
  }

  public setMode(mode: SurfaceHeatmapMode): void {
    this.currentMode = mode;
    if (!this.activeMesh) return;

    if (mode === 'off') {
      if (this.originalMaterial) {
        this.activeMesh.material = this.originalMaterial;
      }
    } else {
      this.activeMesh.material = this.heatmapMaterial;
    }
  }

  public getMode(): SurfaceHeatmapMode {
    return this.currentMode;
  }

  /**
   * Updates surface vertex colors from the latest macroscopic density rho and velocity field.
   */
  public updateFromField(params: {
    voxel: VoxelGridResult;
    rho: Float32Array;
    ux: Float32Array;
    uInletLattice: number;
    worldMatrix?: THREE.Matrix4;
  }): void {
    if (!this.activeMesh || this.currentMode === 'off') return;

    const { voxel, rho, ux, uInletLattice, worldMatrix } = params;
    const geom = this.activeMesh.geometry;
    const posAttr = geom.getAttribute('position');
    if (!posAttr) return;

    const vertexCount = posAttr.count;
    let colorAttr = geom.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!colorAttr || colorAttr.count !== vertexCount) {
      colorAttr = new THREE.Float32BufferAttribute(new Float32Array(vertexCount * 3), 3);
      geom.setAttribute('color', colorAttr);
    }

    const colors = colorAttr.array as Float32Array;
    const { nx, ny, nz, dx, originX, originY, originZ } = voxel;
    const qLat = Math.max(1e-6, 0.5 * 1.0 * uInletLattice * uInletLattice);

    const vLocal = new THREE.Vector3();
    const rgb: [number, number, number] = [0, 0, 0];

    for (let i = 0; i < vertexCount; i++) {
      vLocal.fromBufferAttribute(posAttr, i);
      if (worldMatrix) {
        vLocal.applyMatrix4(worldMatrix);
      }

      // Convert world position (x, y, z) to lattice continuous cell coordinates
      const fx = (vLocal.x - originX) / dx - 0.5;
      const fy = (vLocal.y - originY) / dx - 0.5;
      const fz = (vLocal.z - originZ) / dx - 0.5;

      const ix = Math.max(0, Math.min(nx - 1, Math.round(fx)));
      const iy = Math.max(0, Math.min(ny - 1, Math.round(fy)));
      const iz = Math.max(0, Math.min(nz - 1, Math.round(fz)));
      const cellIdx = ix + nx * (iy + ny * iz);

      const localRho = rho[cellIdx] || 1.0;
      const localUx = ux[cellIdx] || 0.0;

      if (this.currentMode === 'cp') {
        // Physical pressure coefficient: Cp = (p - p0) / q_inf = (cs^2 * (rho - 1.0)) / (0.5 * rho0 * u^2)
        // Stagnation point: Cp = +1.0 (Red / Orange)
        // Freestream ambient: Cp = 0.0 (Green)
        // Separation suction wake: Cp < 0.0 (Cyan / Blue, down to -1.5)
        const cp = ((1.0 / 3.0) * (localRho - 1.0)) / qLat;

        // Map Cp in [-1.5, +1.0] to normalized color t in [0, 1]
        // t = 0.0 -> Blue (Cp = -1.5)
        // t = 0.6 -> Green (Cp = 0.0)
        // t = 1.0 -> Red (Cp = +1.0)
        let tVal: number;
        if (cp >= 0.0) {
          tVal = 0.6 + 0.4 * Math.min(1.0, cp / 1.0);
        } else {
          tVal = Math.max(0.0, 0.6 + (cp / 1.5) * 0.6);
        }
        sampleCFDColormap(tVal, rgb);
      } else {
        // Local drag contribution mode: relative forward deceleration / momentum deficit
        // Deficit = max(0, 1.0 - u_x / u_inf)
        const deficit = Math.max(0.0, Math.min(1.5, 1.0 - localUx / Math.max(1e-4, uInletLattice)));
        const tVal = Math.max(0.0, Math.min(1.0, deficit / 1.2));
        sampleCFDColormap(tVal, rgb);
      }

      colors[i * 3 + 0] = rgb[0];
      colors[i * 3 + 1] = rgb[1];
      colors[i * 3 + 2] = rgb[2];
    }

    colorAttr.needsUpdate = true;
  }
}
