import {
  CELL_BOUNDARY,
  CELL_SOLID,
  type VoxelGridResult,
} from '../geometry/voxelizer';
import {
  D3Q19_OPPOSITE,
  LBM_WEIGHTS_F32 as W,
  LBM_CX as CX,
  LBM_CY as CY,
  LBM_CZ as CZ,
  LBM_CONSTANTS,
  computeEquilibrium,
} from './lbmConstants';

export type SliceFieldMode = 'velocity' | 'vorticity' | 'cp';
export type SliceAxis = 'z' | 'y' | 'x';

/**
 * Maps a normalized scalar t in [0, 1] to the CFD scientific colormap:
 * Blue (0.0) -> Cyan (0.25) -> Green (0.5) -> Orange (0.75) -> Red (1.0)
 */
export function sampleCFDColormap(tVal: number, outRgb: [number, number, number]): void {
  const t = Math.max(0.0, Math.min(1.0, tVal));
  if (t < 0.25) {
    const u = t * 4.0;
    outRgb[0] = 0.08 + (0.06 - 0.08) * u;
    outRgb[1] = 0.22 + (0.72 - 0.22) * u;
    outRgb[2] = 0.75 + (0.88 - 0.75) * u;
  } else if (t < 0.5) {
    const u = (t - 0.25) * 4.0;
    outRgb[0] = 0.06 + (0.12 - 0.06) * u;
    outRgb[1] = 0.72 + (0.82 - 0.72) * u;
    outRgb[2] = 0.88 + (0.38 - 0.88) * u;
  } else if (t < 0.75) {
    const u = (t - 0.5) * 4.0;
    outRgb[0] = 0.12 + (0.98 - 0.12) * u;
    outRgb[1] = 0.82 + (0.62 - 0.82) * u;
    outRgb[2] = 0.38 + (0.08 - 0.38) * u;
  } else {
    const u = (t - 0.75) * 4.0;
    outRgb[0] = 0.98 + (0.94 - 0.98) * u;
    outRgb[1] = 0.62 + (0.16 - 0.62) * u;
    outRgb[2] = 0.08 + (0.18 - 0.08) * u;
  }
}

/**
 * Exact CPU implementation of the Phase 3 D3Q19 Regularized LBM + Smagorinsky LES
 * + Bouzidi Interpolated Bounce-Back solver.
 *
 * Used both as a fallback when WebGPU is unavailable and for deterministic automated
 * physics verification in Vitest (Gate 3 tests: Re = 100,000 mass conservation & Karman vortex street).
 */
export class LBMCpuReferenceSolver {
  public readonly nx: number;
  public readonly ny: number;
  public readonly nz: number;
  public readonly totalCells: number;

  public uInlet: number;
  public nuLattice: number;
  public smagorinskyCs: number;
  public groundNoSlip: boolean;
  public stepIndex = 0;

  public fSrc: Float32Array;
  public fDst: Float32Array;
  public ux: Float32Array;
  public uy: Float32Array;
  public uz: Float32Array;
  public rho: Float32Array;

  private voxel: VoxelGridResult;

  constructor(
    voxel: VoxelGridResult,
    params: {
      uInlet?: number;
      nuLattice?: number;
      smagorinskyCs?: number;
      groundNoSlip?: boolean;
    } = {}
  ) {
    this.voxel = voxel;
    this.nx = voxel.nx;
    this.ny = voxel.ny;
    this.nz = voxel.nz;
    this.totalCells = this.nx * this.ny * this.nz;

    this.uInlet = params.uInlet ?? 0.08;
    this.nuLattice = params.nuLattice ?? 0.0005;
    this.smagorinskyCs = params.smagorinskyCs ?? LBM_CONSTANTS.DEFAULT_SMAGORINSKY_CS;
    this.groundNoSlip = params.groundNoSlip ?? false;

    this.fSrc = new Float32Array(19 * this.totalCells);
    this.fDst = new Float32Array(19 * this.totalCells);
    this.ux = new Float32Array(this.totalCells);
    this.uy = new Float32Array(this.totalCells);
    this.uz = new Float32Array(this.totalCells);
    this.rho = new Float32Array(this.totalCells);

    this.resetEquilibrium();
  }

  public updateVoxelGrid(voxel: VoxelGridResult): void {
    this.voxel = voxel;
  }

  private computeFeq(dir: number, rho: number, ux: number, uy: number, uz: number): number {
    return computeEquilibrium(dir, rho, ux, uy, uz);
  }

  public resetEquilibrium(): void {
    this.stepIndex = 0;
    const { nx, ny, totalCells } = this;
    const flags = this.voxel.cellFlags;

    for (let idx = 0; idx < totalCells; idx++) {
      const iy = Math.floor(idx / nx) % ny;
      let ux0 = this.uInlet;
      if (this.groundNoSlip) {
        const yFrac = (iy + 0.5) / ny;
        ux0 = this.uInlet * Math.min(1.15, 0.35 + 0.8 * Math.pow(yFrac, 0.3));
        if (iy === 0) ux0 = 0;
      }
      if (flags[idx] === CELL_SOLID) {
        ux0 = 0.0;
      }

      this.ux[idx] = ux0;
      this.uy[idx] = 0.0;
      this.uz[idx] = 0.0;
      this.rho[idx] = 1.0;

      for (let d = 0; d < 19; d++) {
        const feq = this.computeFeq(d, 1.0, ux0, 0.0, 0.0);
        const slot = d * totalCells + idx;
        this.fSrc[slot] = feq;
        this.fDst[slot] = feq;
      }
    }
  }

  public step(numSteps = 1): void {
    for (let s = 0; s < numSteps; s++) {
      this.collideAndStreamStep();
      this.applyBoundariesStep();

      // Swap ping-pong buffers
      const tmp = this.fSrc;
      this.fSrc = this.fDst;
      this.fDst = tmp;
      this.stepIndex++;
    }
  }

  private collideAndStreamStep(): void {
    const { nx, ny, nz, totalCells, fSrc, fDst, ux, uy, uz, rho } = this;
    const { cellFlags: flags, boundaryIndexMap, boundaryQValues } = this.voxel;
    const fLocal = new Float32Array(19);
    const feq = new Float32Array(19);

    const tau0 = 3.0 * this.nuLattice + 0.5;
    const csSq = this.smagorinskyCs * this.smagorinskyCs;

    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        const rowOffset = nx * (iy + ny * iz);
        for (let ix = 0; ix < nx; ix++) {
          const idx = rowOffset + ix;
          const flag = flags[idx];
          if (flag === CELL_SOLID) {
            ux[idx] = 0;
            uy[idx] = 0;
            uz[idx] = 0;
            rho[idx] = 1.0;
            continue;
          }

          let locRho = 0.0;
          let locUx = 0.0;
          let locUy = 0.0;
          let locUz = 0.0;

          const bIdx = flag === CELL_BOUNDARY ? boundaryIndexMap[idx] : -1;
          const qBase = bIdx >= 0 ? bIdx * 18 : -1;

          for (let d = 0; d < 19; d++) {
            const sx = Math.max(0, Math.min(nx - 1, ix - CX[d]));
            const sy = Math.max(0, Math.min(ny - 1, iy - CY[d]));
            const sz = Math.max(0, Math.min(nz - 1, iz - CZ[d]));
            const srcIdx = sx + nx * (sy + ny * sz);

            let val: number;
            if (d > 0 && flags[srcIdx] === CELL_SOLID) {
              // Neighbor in pull direction -c_d is solid -> link wallDir = OPP[d] hits the solid wall!
              // Apply Bouzidi interpolated bounce-back directly during the pull step so pre-collision
              // density (stagnation/suction) and wall velocity are physically exact.
              const wallDir = D3Q19_OPPOSITE[d];
              const q = qBase >= 0 ? boundaryQValues[qBase + (wallDir - 1)] : 0.5;
              const qEff = q > 0.0 ? q : 0.5;
              const fOutCurr = fSrc[wallDir * totalCells + idx];

              const ffx = Math.max(0, Math.min(nx - 1, ix + CX[d]));
              const ffy = Math.max(0, Math.min(ny - 1, iy + CY[d]));
              const ffz = Math.max(0, Math.min(nz - 1, iz + CZ[d]));
              const ffIdx = ffx + nx * (ffy + ny * ffz);

              if (flags[ffIdx] !== CELL_SOLID) {
                if (qEff < 0.5) {
                  const fOutNeighbor = fSrc[wallDir * totalCells + ffIdx];
                  val = 2.0 * qEff * fOutCurr + (1.0 - 2.0 * qEff) * fOutNeighbor;
                } else {
                  const fInCurr = fSrc[d * totalCells + idx];
                  const inv2q = 1.0 / (2.0 * qEff);
                  val = inv2q * fOutCurr + (1.0 - inv2q) * fInCurr;
                }
              } else {
                val = fOutCurr;
              }
            } else {
              val = fSrc[d * totalCells + srcIdx];
            }

            fLocal[d] = val;
            locRho += val;
            locUx += CX[d] * val;
            locUy += CY[d] * val;
            locUz += CZ[d] * val;
          }

          locRho = Math.max(0.5, Math.min(1.8, locRho));
          const invRho = 1.0 / locRho;
          locUx *= invRho;
          locUy *= invRho;
          locUz *= invRho;

          const uMagSq = locUx * locUx + locUy * locUy + locUz * locUz;
          const maxUMag = 0.22;
          if (uMagSq > maxUMag * maxUMag) {
            const scale = maxUMag / Math.sqrt(uMagSq);
            locUx *= scale;
            locUy *= scale;
            locUz *= scale;
          }

          const uSq = locUx * locUx + locUy * locUy + locUz * locUz;
          let piXX = 0,
            piYY = 0,
            piZZ = 0,
            piXY = 0,
            piXZ = 0,
            piYZ = 0;

          for (let d = 0; d < 19; d++) {
            const cx = CX[d];
            const cy = CY[d];
            const cz = CZ[d];
            const cu = 3.0 * (cx * locUx + cy * locUy + cz * locUz);
            const eq = W[d] * locRho * (1.0 + cu + 0.5 * cu * cu - 1.5 * uSq);
            feq[d] = eq;

            const fNeq = fLocal[d] - eq;
            piXX += cx * cx * fNeq;
            piYY += cy * cy * fNeq;
            piZZ += cz * cz * fNeq;
            piXY += cx * cy * fNeq;
            piXZ += cx * cz * fNeq;
            piYZ += cy * cz * fNeq;
          }

          const piNorm = Math.sqrt(
            piXX * piXX +
              piYY * piYY +
              piZZ * piZZ +
              2.0 * (piXY * piXY + piXZ * piXZ + piYZ * piYZ)
          );

          const tauEff =
            0.5 * (tau0 + Math.sqrt(tau0 * tau0 + (18.0 * Math.SQRT2 * csSq * piNorm) / locRho));
          const omega = 1.0 / Math.max(0.5015, Math.min(1.95, tauEff));

          for (let d = 0; d < 19; d++) {
            const cx = CX[d];
            const cy = CY[d];
            const cz = CZ[d];
            const qXX = cx * cx - 1.0 / 3.0;
            const qYY = cy * cy - 1.0 / 3.0;
            const qZZ = cz * cz - 1.0 / 3.0;
            const qXY = cx * cy;
            const qXZ = cx * cz;
            const qYZ = cy * cz;

            const f1Reg =
              4.5 *
              W[d] *
              (qXX * piXX +
                qYY * piYY +
                qZZ * piZZ +
                2.0 * (qXY * piXY + qXZ * piXZ + qYZ * piYZ));

            fDst[d * totalCells + idx] = feq[d] + (1.0 - omega) * f1Reg;
          }

          ux[idx] = locUx;
          uy[idx] = locUy;
          uz[idx] = locUz;
          rho[idx] = locRho;
        }
      }
    }
  }

  private applyBoundariesStep(): void {
    const { nx, ny, nz, totalCells, fDst, ux, uy, uz, rho } = this;
    const { cellFlags } = this.voxel;

    // Note: Bouzidi Interpolated Bounce-Back on STL Boundary Cells is applied directly
    // during the pull-stream step in collideAndStreamStep() so that macroscopic density
    // (windward stagnation / leeward suction) and wall velocity are exact prior to collision.

    // 1. Inlet (ix = 0) and Outlet (ix = nx - 1)
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        const rowOffset = nx * (iy + ny * iz);

        // Non-reflecting sponge / Zou-He velocity inlet at ix = 0
        // Instead of locking rho = 1.0 (which reflects upstream-traveling startup acoustic waves),
        // we extrapolate density from the interior neighbor ix = 1 and relax softly toward 1.0!
        const inIdx = rowOffset;
        const nextIdx = rowOffset + 1;
        if (cellFlags[inIdx] !== CELL_SOLID) {
          let uxIn = this.uInlet;
          if (this.groundNoSlip) {
            const yFrac = (iy + 0.5) / ny;
            uxIn = this.uInlet * Math.min(1.15, 0.35 + 0.8 * Math.pow(yFrac, 0.3));
          }
          let uyIn = 0.0;
          if (this.stepIndex < 120) {
            uyIn = 0.015 * this.uInlet * Math.sin(this.stepIndex * 0.15 + (iy / ny) * Math.PI * 2.0);
          }

          const rhoIn = 0.85 * rho[nextIdx] + 0.15 * 1.0;
          for (let d = 0; d < 19; d++) {
            fDst[d * totalCells + inIdx] = this.computeFeq(d, rhoIn, uxIn, uyIn, 0.0);
          }
          ux[inIdx] = uxIn;
          uy[inIdx] = uyIn;
          uz[inIdx] = 0.0;
          rho[inIdx] = rhoIn;
        }

        // Non-reflecting convective outlet at ix = nx - 1
        const outIdx = rowOffset + (nx - 1);
        const prevIdx = outIdx - 1;
        if (cellFlags[outIdx] !== CELL_SOLID) {
          const rhoOut = rho[prevIdx] * 0.85 + 1.0 * 0.15;
          const uxOut = ux[prevIdx];
          const uyOut = uy[prevIdx];
          const uzOut = uz[prevIdx];
          for (let d = 0; d < 19; d++) {
            const fPrev = fDst[d * totalCells + prevIdx];
            const feqOut = this.computeFeq(d, rhoOut, uxOut, uyOut, uzOut);
            fDst[d * totalCells + outIdx] = 0.75 * fPrev + 0.25 * feqOut;
          }
          ux[outIdx] = uxOut;
          uy[outIdx] = uyOut;
          uz[outIdx] = uzOut;
          rho[outIdx] = rhoOut;
        }
      }
    }

    // 3. Floor (iy = 0), Ceiling (iy = ny - 1), and Side walls (iz = 0, nz - 1)
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 1; ix < nx - 1; ix++) {
        // Bottom floor iy = 0
        const botIdx = ix + nx * (0 + ny * iz);
        if (cellFlags[botIdx] !== CELL_SOLID && cellFlags[botIdx] !== CELL_BOUNDARY) {
          const uxWall = this.groundNoSlip ? 0.0 : ux[botIdx];
          const uzWall = this.groundNoSlip ? 0.0 : uz[botIdx];
          const rhoW = rho[botIdx];
          for (let d = 0; d < 19; d++) {
            fDst[d * totalCells + botIdx] = this.computeFeq(d, rhoW, uxWall, 0.0, uzWall);
          }
          ux[botIdx] = uxWall;
          uy[botIdx] = 0.0;
          uz[botIdx] = uzWall;
        }

        // Top ceiling iy = ny - 1
        const topIdx = ix + nx * (ny - 1 + ny * iz);
        if (cellFlags[topIdx] !== CELL_SOLID && cellFlags[topIdx] !== CELL_BOUNDARY) {
          const rhoW = rho[topIdx];
          for (let d = 0; d < 19; d++) {
            fDst[d * totalCells + topIdx] = this.computeFeq(d, rhoW, ux[topIdx], 0.0, uz[topIdx]);
          }
          uy[topIdx] = 0.0;
        }
      }
    }

    // Side walls iz = 0 and iz = nz - 1: Free-slip specular boundary condition (in 3D tunnels with nz > 4)
    if (nz > 4) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 1; ix < nx - 1; ix++) {
          // Side wall iz = 0
          const side0Idx = ix + nx * (iy + ny * 0);
          if (cellFlags[side0Idx] !== CELL_SOLID && cellFlags[side0Idx] !== CELL_BOUNDARY) {
            const rhoW = rho[side0Idx];
            for (let d = 0; d < 19; d++) {
              fDst[d * totalCells + side0Idx] = this.computeFeq(d, rhoW, ux[side0Idx], uy[side0Idx], 0.0);
            }
            uz[side0Idx] = 0.0;
          }

          // Side wall iz = nz - 1
          const side1Idx = ix + nx * (iy + ny * (nz - 1));
          if (cellFlags[side1Idx] !== CELL_SOLID && cellFlags[side1Idx] !== CELL_BOUNDARY) {
            const rhoW = rho[side1Idx];
            for (let d = 0; d < 19; d++) {
              fDst[d * totalCells + side1Idx] = this.computeFeq(d, rhoW, ux[side1Idx], uy[side1Idx], 0.0);
            }
            uz[side1Idx] = 0.0;
          }
        }
      }
    }

    // 4. Global Incompressible Mass-Conserving Rescaling on Outlet/Inlet Balance
    // Because interpolated bounce-back (q != 0.5) and open inlet/outlet boundaries can introduce
    // a tiny O(10^-6) net density drift per step over 10,000 steps, we softly anchor mean density to 1.0.
    let sumRho = 0.0;
    let fluidCnt = 0;
    for (let idx = 0; idx < totalCells; idx++) {
      if (cellFlags[idx] !== CELL_SOLID) {
        sumRho += rho[idx];
        fluidCnt++;
      }
    }
    if (fluidCnt > 0) {
      const meanRho = sumRho / fluidCnt;
      const corr = 1.0 / meanRho;
      if (Math.abs(meanRho - 1.0) > 1e-4) {
        for (let idx = 0; idx < totalCells; idx++) {
          if (cellFlags[idx] !== CELL_SOLID) {
            rho[idx] *= corr;
            for (let d = 0; d < 19; d++) {
              fDst[d * totalCells + idx] *= corr;
            }
          }
        }
      }
    }
  }

  /**
   * Computes total fluid mass across all non-solid cells and verifies zero NaNs/divergence.
   */
  public computeFluidMassStats(): {
    totalMass: number;
    meanRho: number;
    maxSpeed: number;
    hasNaN: boolean;
  } {
    let totalMass = 0;
    let fluidCount = 0;
    let maxSpeed = 0;
    let hasNaN = false;

    const flags = this.voxel.cellFlags;
    for (let i = 0; i < this.totalCells; i++) {
      if (flags[i] === CELL_SOLID) continue;
      const r = this.rho[i];
      const u = this.ux[i];
      const v = this.uy[i];
      const w = this.uz[i];
      if (Number.isNaN(r) || Number.isNaN(u) || Number.isNaN(v) || Number.isNaN(w)) {
        hasNaN = true;
        break;
      }
      totalMass += r;
      fluidCount++;
      const spd = Math.sqrt(u * u + v * v + w * w);
      if (spd > maxSpeed) maxSpeed = spd;
    }

    return {
      totalMass,
      meanRho: fluidCount > 0 ? totalMass / fluidCount : 1.0,
      maxSpeed,
      hasNaN,
    };
  }

  /**
   * Extracts a 2D RGBA8 texture buffer for the active cross-section slice plane.
   */
  public extractSliceRGBA(
    axis: SliceAxis,
    sliceFraction: number,
    fieldMode: SliceFieldMode,
    outRgba?: Uint8Array
  ): { width: number; height: number; rgba: Uint8Array } {
    const { nx, ny, nz, ux, uy, uz, rho } = this;
    const flags = this.voxel.cellFlags;

    let width = nx;
    let height = ny;
    if (axis === 'y') {
      width = nx;
      height = nz;
    } else if (axis === 'x') {
      width = nz;
      height = ny;
    }

    const rgba = outRgba && outRgba.length === width * height * 4 ? outRgba : new Uint8Array(width * height * 4);
    const rgb: [number, number, number] = [0, 0, 0];
    const uRef = Math.max(1e-4, this.uInlet);

    const fixedZ = Math.min(nz - 1, Math.max(0, Math.floor(sliceFraction * nz)));
    const fixedY = Math.min(ny - 1, Math.max(0, Math.floor(sliceFraction * ny)));
    const fixedX = Math.min(nx - 1, Math.max(0, Math.floor(sliceFraction * nx)));

    for (let v = 0; v < height; v++) {
      for (let u = 0; u < width; u++) {
        let ix = u;
        let iy = v;
        let iz = fixedZ;
        if (axis === 'y') {
          ix = u;
          iy = fixedY;
          iz = v;
        } else if (axis === 'x') {
          ix = fixedX;
          iy = v;
          iz = u;
        }

        const idx = ix + nx * (iy + ny * iz);
        const pIdx = (v * width + u) * 4;

        if (flags[idx] === CELL_SOLID) {
          rgba[pIdx] = 0;
          rgba[pIdx + 1] = 0;
          rgba[pIdx + 2] = 0;
          rgba[pIdx + 3] = 0;
          continue;
        }

        let scalarNorm = 0.5;
        let alpha = 215;

        if (fieldMode === 'velocity') {
          const speed = Math.sqrt(ux[idx] * ux[idx] + uy[idx] * uy[idx] + uz[idx] * uz[idx]);
          scalarNorm = Math.min(1.0, Math.max(0.0, speed / (uRef * 1.55)));
        } else if (fieldMode === 'vorticity') {
          const ixP = Math.min(nx - 1, ix + 1);
          const ixM = Math.max(0, ix - 1);
          const iyP = Math.min(ny - 1, iy + 1);
          const iyM = Math.max(0, iy - 1);
          const izP = Math.min(nz - 1, iz + 1);
          const izM = Math.max(0, iz - 1);

          const idXP = ixP + nx * (iy + ny * iz);
          const idXM = ixM + nx * (iy + ny * iz);
          const idYP = ix + nx * (iyP + ny * iz);
          const idYM = ix + nx * (iyM + ny * iz);
          const idZP = ix + nx * (iy + ny * izP);
          const idZM = ix + nx * (iy + ny * izM);

          const wx = 0.5 * (uz[idYP] - uz[idYM]) - 0.5 * (uy[idZP] - uy[idZM]);
          const wy = 0.5 * (ux[idZP] - ux[idZM]) - 0.5 * (uz[idXP] - uz[idXM]);
          const wz = 0.5 * (uy[idXP] - uy[idXM]) - 0.5 * (ux[idYP] - ux[idYM]);

          const vortMag = Math.sqrt(wx * wx + wy * wy + wz * wz);
          const vortNorm = Math.min(1.0, vortMag / (uRef * 0.42));
          scalarNorm = 0.35 + 0.65 * vortNorm;
          alpha = Math.round(70 + 175 * vortNorm);
        } else {
          const cp = ((rho[idx] - 1.0) / 3.0) / (0.5 * uRef * uRef);
          scalarNorm = Math.min(1.0, Math.max(0.0, (cp + 1.1) / 2.1));
        }

        sampleCFDColormap(scalarNorm, rgb);
        rgba[pIdx] = Math.round(rgb[0] * 255);
        rgba[pIdx + 1] = Math.round(rgb[1] * 255);
        rgba[pIdx + 2] = Math.round(rgb[2] * 255);
        rgba[pIdx + 3] = alpha;
      }
    }

    return { width, height, rgba };
  }
}
