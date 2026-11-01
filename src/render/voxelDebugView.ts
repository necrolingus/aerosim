import * as THREE from 'three';
import { CELL_BOUNDARY, CELL_SOLID, type VoxelGridResult } from '../geometry/voxelizer';

export type VoxelVizMode = 'off' | 'slice_2d' | 'shell_3d';

/**
 * Maps a sub-grid wall distance fraction q in [0, 1] to a vivid scientific colormap
 * (Red for q -> 0 near-wall grazing, Amber/Orange for q = 0.5 halfway bounce-back,
 * Cyan/Green for q -> 1.0 full link).
 */
function sampleQColor(q: number, target: THREE.Color): void {
  const t = Math.max(0, Math.min(1, q));
  if (t < 0.5) {
    // Red (0.98, 0.25, 0.25) -> Amber (0.98, 0.65, 0.12)
    const u = t * 2.0;
    target.setRGB(0.98, 0.25 + 0.4 * u, 0.25 - 0.13 * u);
  } else {
    // Amber (0.98, 0.65, 0.12) -> Emerald/Cyan (0.13, 0.85, 0.68)
    const u = (t - 0.5) * 2.0;
    target.setRGB(0.98 - 0.85 * u, 0.65 + 0.2 * u, 0.12 + 0.56 * u);
  }
}

export class VoxelDebugVisualizer {
  private group: THREE.Group;
  private mode: VoxelVizMode = 'slice_2d';
  private sliceZFraction = 0.5; // 0..1 across Z span (0.5 = center mid-plane z = 0)
  private lastResult: VoxelGridResult | null = null;

  constructor(parentScene: THREE.Scene) {
    this.group = new THREE.Group();
    parentScene.add(this.group);
  }

  public setMode(mode: VoxelVizMode): void {
    this.mode = mode;
    if (this.lastResult) {
      this.rebuildVisuals(this.lastResult);
    } else {
      this.clear();
    }
  }

  public getMode(): VoxelVizMode {
    return this.mode;
  }

  public setSliceZFraction(fraction: number): void {
    this.sliceZFraction = Math.max(0, Math.min(1, fraction));
    if (this.lastResult && this.mode === 'slice_2d') {
      this.rebuildVisuals(this.lastResult);
    }
  }

  public update(result: VoxelGridResult): void {
    this.lastResult = result;
    this.rebuildVisuals(result);
  }

  public clear(): void {
    while (this.group.children.length > 0) {
      const child = this.group.children[0] as THREE.Mesh;
      this.group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          const mat = child.material as THREE.MeshBasicMaterial;
          if (mat.map) mat.map.dispose();
          mat.dispose();
        }
      }
    }
  }

  private rebuildVisuals(res: VoxelGridResult): void {
    this.clear();
    if (this.mode === 'off') return;

    if (this.mode === 'slice_2d') {
      this.build2DSlicePlane(res);
    } else if (this.mode === 'shell_3d') {
      this.build3DBoundaryShell(res);
    }
  }

  /**
   * Builds a crisp 2D X-Y cross-section slice plane at the selected Z index showing:
   * - Dark Slate/Blue-tinted transparent Fluid cells
   * - Deep Indigo Solid interior cells (`CELL_SOLID = 1`)
   * - Vivid Red/Orange/Green Boundary Interface cells (`CELL_BOUNDARY = 2`) colored by exact sub-grid wall distance q
   */
  private build2DSlicePlane(res: VoxelGridResult): void {
    const { nx, ny, nz, dx, dy, dz, originX, originY, originZ, cellFlags, boundaryIndexMap, boundaryMinQ } = res;
    const iz = Math.min(nz - 1, Math.max(0, Math.floor(this.sliceZFraction * nz)));
    const sliceZ = originZ + (iz + 0.5) * dz;

    const rgba = new Uint8Array(nx * ny * 4);
    const tmpColor = new THREE.Color();

    for (let iy = 0; iy < ny; iy++) {
      const rowOffset = nx * (iy + ny * iz);
      for (let ix = 0; ix < nx; ix++) {
        const cellIdx = rowOffset + ix;
        const flag = cellFlags[cellIdx];
        const pixelIdx = (iy * nx + ix) * 4;

        if (flag === CELL_SOLID) {
          // Interior Solid cell: cool slate-blue fill
          rgba[pixelIdx] = 56;
          rgba[pixelIdx + 1] = 189;
          rgba[pixelIdx + 2] = 248;
          rgba[pixelIdx + 3] = 175;
        } else if (flag === CELL_BOUNDARY) {
          // Curved-Wall Boundary Interface cell: colored by sub-grid wall distance q in (0, 1]
          const bIdx = boundaryIndexMap[cellIdx];
          const q = bIdx >= 0 ? boundaryMinQ[bIdx] : 0.5;
          sampleQColor(q, tmpColor);
          rgba[pixelIdx] = Math.round(tmpColor.r * 255);
          rgba[pixelIdx + 1] = Math.round(tmpColor.g * 255);
          rgba[pixelIdx + 2] = Math.round(tmpColor.b * 255);
          rgba[pixelIdx + 3] = 245;
        } else {
          // Bulk Fluid cell: subtle grid check pattern
          const checker = (ix + iy) % 2 === 0 ? 22 : 30;
          rgba[pixelIdx] = 15;
          rgba[pixelIdx + 1] = 23;
          rgba[pixelIdx + 2] = 42;
          rgba[pixelIdx + 3] = checker;
        }
      }
    }

    const texture = new THREE.DataTexture(rgba, nx, ny, THREE.RGBAFormat);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.needsUpdate = true;

    const widthX = nx * dx;
    const heightY = ny * dy;
    const planeGeom = new THREE.PlaneGeometry(widthX, heightY);
    const planeMat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const sliceMesh = new THREE.Mesh(planeGeom, planeMat);
    sliceMesh.position.set(originX + widthX * 0.5, originY + heightY * 0.5, sliceZ);
    this.group.add(sliceMesh);

    // Subtle cyan frame around active slice plane
    const frameEdges = new THREE.EdgesGeometry(planeGeom);
    const frameMat = new THREE.LineBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.7,
    });
    const frameLines = new THREE.LineSegments(frameEdges, frameMat);
    sliceMesh.add(frameLines);
  }

  /**
   * Renders all 3D CELL_BOUNDARY interface voxels as an InstancedMesh colored by their
   * sub-grid curved-wall distance q in (0, 1].
   */
  private build3DBoundaryShell(res: VoxelGridResult): void {
    const count = res.boundaryCellCount;
    if (count === 0) return;

    const maxInstances = Math.min(count, 40000);
    const stride = Math.max(1, Math.floor(count / maxInstances));
    const actualInstances = Math.floor(count / stride);

    const boxGeom = new THREE.BoxGeometry(res.dx * 0.88, res.dy * 0.88, res.dz * 0.88);
    const boxMat = new THREE.MeshStandardMaterial({
      roughness: 0.35,
      metalness: 0.15,
      transparent: true,
      opacity: 0.82,
    });

    const instanced = new THREE.InstancedMesh(boxGeom, boxMat, actualInstances);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    let instIdx = 0;
    for (let bIdx = 0; bIdx < count && instIdx < actualInstances; bIdx += stride) {
      const cellIdx = res.boundaryCellIndices[bIdx];
      const ix = cellIdx % res.nx;
      const rem = (cellIdx - ix) / res.nx;
      const iy = rem % res.ny;
      const iz = (rem - iy) / res.ny;

      dummy.position.set(
        res.originX + (ix + 0.5) * res.dx,
        res.originY + (iy + 0.5) * res.dy,
        res.originZ + (iz + 0.5) * res.dz
      );
      dummy.updateMatrix();
      instanced.setMatrixAt(instIdx, dummy.matrix);

      sampleQColor(res.boundaryMinQ[bIdx], color);
      instanced.setColorAt(instIdx, color);
      instIdx++;
    }

    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
    this.group.add(instanced);
  }
}
