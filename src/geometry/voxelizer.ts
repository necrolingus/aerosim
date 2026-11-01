import * as THREE from 'three';
import { MeshBVH } from './bvh';
import type { GridResolution, TunnelDimensions } from '../core/types';

/**
 * Cell classification flags for the 3D Lattice Boltzmann grid:
 * - CELL_FLUID (0): Bulk fluid cell with no solid neighbors.
 * - CELL_SOLID (1): Interior solid obstacle cell inside the STL mesh.
 * - CELL_BOUNDARY (2): Fluid interface cell immediately adjacent to at least one CELL_SOLID neighbor
 *                      along the 18 non-zero D3Q19 lattice links.
 */
export const CELL_FLUID = 0;
export const CELL_SOLID = 1;
export const CELL_BOUNDARY = 2;

import { D3Q19_DIRECTIONS, D3Q19_OPPOSITE } from '../solver/lbmConstants';
export { D3Q19_DIRECTIONS, D3Q19_OPPOSITE };

export interface VoxelGridResult {
  nx: number;
  ny: number;
  nz: number;
  dx: number;
  dy: number;
  dz: number;
  originX: number; // Minimum corner (-L/2, -H/2, -W/2)
  originY: number;
  originZ: number;
  /**
   * 3D flat array of size nx * ny * nz indexed by idx = ix + nx * (iy + ny * iz).
   * Values: CELL_FLUID (0), CELL_SOLID (1), CELL_BOUNDARY (2).
   */
  cellFlags: Uint8Array;
  /**
   * Maps flat 3D cell index -> compact boundary index [0 .. boundaryCellCount - 1], or -1 if not a boundary cell.
   */
  boundaryIndexMap: Int32Array;
  /**
   * Flat list of 3D cell indices (idx = ix + nx * (iy + ny * iz)) for all CELL_BOUNDARY cells.
   */
  boundaryCellIndices: Int32Array;
  /**
   * Sub-grid fractional wall distances q in (0, 1] for each boundary cell along the 18 non-zero
   * D3Q19 directions (i = 1..18).
   * Indexed as: boundaryQValues[bIdx * 18 + (dirIdx - 1)].
   * If direction `dirIdx` points to a fluid neighbor (no wall cut), value is -1.0.
   * If direction `dirIdx` points to a CELL_SOLID neighbor, value is q = |x_wall - x_f| / |x_solid - x_f| in (0, 1].
   */
  boundaryQValues: Float32Array;
  /**
   * Minimum sub-grid wall distance q_min in (0, 1] across all cut links for each boundary cell
   * (used for the 3D Sub-Grid Curved-Wall Distance Visualizer).
   */
  boundaryMinQ: Float32Array;
  solidCellCount: number;
  boundaryCellCount: number;
  fluidCellCount: number;
  voxelizationTimeMs: number;
}

/**
 * Computes the exact sub-grid fractional distance q in (0, 1] from a fluid node (fx, fy, fz)
 * along a discrete lattice link vector (vx, vy, vz) = (cx * dx, cy * dy, cz * dz) to the triangle mesh surface.
 */
export function computeSubGridLinkFraction(
  bvh: MeshBVH,
  fx: number,
  fy: number,
  fz: number,
  vx: number,
  vy: number,
  vz: number
): number {
  const q = bvh.intersectSegment(fx, fy, fz, vx, vy, vz, 1.0);
  if (q > 0 && q <= 1.0) {
    return Math.max(1e-4, Math.min(1.0, q));
  }
  // Fallback if numerical grazing slightly missed the segment endpoint: defaults to standard halfway bounce-back q = 0.5
  return 0.5;
}

/**
 * Voxelizes a THREE.BufferGeometry into the 3D wind tunnel lattice and computes exact
 * sub-grid curved-wall distances q in (0, 1] along all 18 non-zero D3Q19 lattice links.
 */
export function voxelizeMeshToLattice(
  geometry: THREE.BufferGeometry,
  worldMatrix: THREE.Matrix4 | undefined,
  tunnel: TunnelDimensions,
  grid: Pick<GridResolution, 'nx' | 'ny' | 'nz'>
): VoxelGridResult {
  const t0 = performance.now();

  const { nx, ny, nz } = grid;
  const totalCells = nx * ny * nz;

  // Enforce cubic cells: dx === dy === dz === h
  // In D3Q19 Lattice Boltzmann, discrete velocity vectors c_i assume unit displacement in (x,y,z),
  // which strictly requires cubic lattice cells (dx === dy === dz) to preserve isotropy and avoid
  // artificial directional viscosity distortions.
  const h = tunnel.height / ny;
  const dx = h;
  const dy = h;
  const dz = h;

  // Origin is centered at the lattice center so physical model at (0,0,0) is exactly centered
  const originX = -nx * h * 0.5;
  const originY = -ny * h * 0.5;
  const originZ = -nz * h * 0.5;

  const bvh = new MeshBVH(geometry, worldMatrix);

  const cellFlags = new Uint8Array(totalCells); // Initialized to CELL_FLUID (0)

  // Determine active grid index bounds overlapping the mesh AABB
  const minIx = Math.max(0, Math.floor((bvh.boundsMin.x - originX) / dx) - 1);
  const maxIx = Math.min(nx - 1, Math.ceil((bvh.boundsMax.x - originX) / dx) + 1);
  const minIy = Math.max(0, Math.floor((bvh.boundsMin.y - originY) / dy) - 1);
  const maxIy = Math.min(ny - 1, Math.ceil((bvh.boundsMax.y - originY) / dy) + 1);
  const minIz = Math.max(0, Math.floor((bvh.boundsMin.z - originZ) / dz) - 1);
  const maxIz = Math.min(nz - 1, Math.ceil((bvh.boundsMax.z - originZ) / dz) + 1);

  let solidCellCount = 0;
  const xHits: number[] = [];

  // Step 1: Fast Y-Z scanline classification along +X columns
  for (let iz = minIz; iz <= maxIz; iz++) {
    const z = originZ + (iz + 0.5) * dz;
    for (let iy = minIy; iy <= maxIy; iy++) {
      const y = originY + (iy + 0.5) * dy;

      const hitCount = bvh.collectXScanlineHits(y, z, xHits);
      if (hitCount === 0) continue;

      const rowOffset = nx * (iy + ny * iz);

      // If hitCount is even (standard closed cross-section), pair entry/exit intervals [xHits[2k], xHits[2k+1]]
      if ((hitCount & 1) === 0) {
        for (let k = 0; k < hitCount; k += 2) {
          const xEnter = xHits[k];
          const xExit = xHits[k + 1];
          if (xExit - xEnter < 1e-7) continue;

          // Cell center x = originX + (ix + 0.5) * dx lies inside [xEnter, xExit]
          const startIx = Math.max(minIx, Math.ceil((xEnter - originX) / dx - 0.5));
          const endIx = Math.min(maxIx, Math.floor((xExit - originX) / dx - 0.5));

          for (let ix = startIx; ix <= endIx; ix++) {
            const idx = rowOffset + ix;
            if (cellFlags[idx] === CELL_FLUID) {
              cellFlags[idx] = CELL_SOLID;
              solidCellCount++;
            }
          }
        }
      } else {
        // Non-manifold / odd hit count fallback along this specific scanline:
        // Use the multi-ray majority-vote point-in-mesh query for cells along this column
        for (let ix = minIx; ix <= maxIx; ix++) {
          const x = originX + (ix + 0.5) * dx;
          if (x >= xHits[0] && x <= xHits[hitCount - 1]) {
            if (bvh.isPointInside(x, y, z)) {
              const idx = rowOffset + ix;
              if (cellFlags[idx] === CELL_FLUID) {
                cellFlags[idx] = CELL_SOLID;
                solidCellCount++;
              }
            }
          }
        }
      }
    }
  }

  // Step 2: Identify CELL_BOUNDARY (fluid cells with >= 1 solid neighbor in D3Q19)
  const boundaryList: number[] = [];
  const searchMinIx = Math.max(0, minIx - 1);
  const searchMaxIx = Math.min(nx - 1, maxIx + 1);
  const searchMinIy = Math.max(0, minIy - 1);
  const searchMaxIy = Math.min(ny - 1, maxIy + 1);
  const searchMinIz = Math.max(0, minIz - 1);
  const searchMaxIz = Math.min(nz - 1, maxIz + 1);

  for (let iz = searchMinIz; iz <= searchMaxIz; iz++) {
    for (let iy = searchMinIy; iy <= searchMaxIy; iy++) {
      const rowOffset = nx * (iy + ny * iz);
      for (let ix = searchMinIx; ix <= searchMaxIx; ix++) {
        const idx = rowOffset + ix;
        if (cellFlags[idx] !== CELL_FLUID) continue;

        let hasSolidNeighbor = false;
        for (let d = 1; d <= 18; d++) {
          const dir = D3Q19_DIRECTIONS[d];
          const nix = ix + dir[0];
          const niy = iy + dir[1];
          const niz = iz + dir[2];
          if (nix < 0 || nix >= nx || niy < 0 || niy >= ny || niz < 0 || niz >= nz) continue;

          const nIdx = nix + nx * (niy + ny * niz);
          if (cellFlags[nIdx] === CELL_SOLID) {
            hasSolidNeighbor = true;
            break;
          }
        }

        if (hasSolidNeighbor) {
          cellFlags[idx] = CELL_BOUNDARY;
          boundaryList.push(idx);
        }
      }
    }
  }

  const boundaryCellCount = boundaryList.length;
  const boundaryCellIndices = new Int32Array(boundaryList);
  const boundaryIndexMap = new Int32Array(totalCells).fill(-1);
  const boundaryQValues = new Float32Array(boundaryCellCount * 18).fill(-1.0);
  const boundaryMinQ = new Float32Array(boundaryCellCount).fill(1.0);

  // Step 3: Compute exact sub-grid wall distance q in (0, 1] along each cut D3Q19 link
  for (let bIdx = 0; bIdx < boundaryCellCount; bIdx++) {
    const cellIdx = boundaryCellIndices[bIdx];
    boundaryIndexMap[cellIdx] = bIdx;

    const ix = cellIdx % nx;
    const rem = (cellIdx - ix) / nx;
    const iy = rem % ny;
    const iz = (rem - iy) / ny;

    const fx = originX + (ix + 0.5) * dx;
    const fy = originY + (iy + 0.5) * dy;
    const fz = originZ + (iz + 0.5) * dz;

    let minQ = 1.0;
    const qBase = bIdx * 18;

    for (let d = 1; d <= 18; d++) {
      const dir = D3Q19_DIRECTIONS[d];
      const nix = ix + dir[0];
      const niy = iy + dir[1];
      const niz = iz + dir[2];
      if (nix < 0 || nix >= nx || niy < 0 || niy >= ny || niz < 0 || niz >= nz) continue;

      const nIdx = nix + nx * (niy + ny * niz);
      if (cellFlags[nIdx] === CELL_SOLID) {
        const vx = dir[0] * dx;
        const vy = dir[1] * dy;
        const vz = dir[2] * dz;
        const q = computeSubGridLinkFraction(bvh, fx, fy, fz, vx, vy, vz);
        boundaryQValues[qBase + (d - 1)] = q;
        if (q < minQ) minQ = q;
      }
    }

    boundaryMinQ[bIdx] = minQ;
  }

  const fluidCellCount = totalCells - solidCellCount - boundaryCellCount;
  const voxelizationTimeMs = Number((performance.now() - t0).toFixed(2));

  return {
    nx,
    ny,
    nz,
    dx,
    dy,
    dz,
    originX,
    originY,
    originZ,
    cellFlags,
    boundaryIndexMap,
    boundaryCellIndices,
    boundaryQValues,
    boundaryMinQ,
    solidCellCount,
    boundaryCellCount,
    fluidCellCount,
    voxelizationTimeMs,
  };
}
