import * as THREE from 'three';
import type { TunnelDimensions } from '../core/types';
import type { VoxelGridResult } from '../geometry/voxelizer';
import { sampleCFDColormap } from '../solver/lbmCpuReference';

export interface StreamlineTraceParams {
  voxel: VoxelGridResult;
  ux: Float32Array;
  uy: Float32Array;
  uz: Float32Array;
  rakeY: number; // -1 .. +1 relative to tunnel center
  rakeZ: number; // -1 .. +1 relative to tunnel center
  uInletLattice: number;
  tunnel: TunnelDimensions;
}

/**
 * Trilinearly interpolates 3D velocity vector (ux, uy, uz) at continuous lattice coordinates (fx, fy, fz).
 */
export function sampleVelocityTrilinear(
  fx: number,
  fy: number,
  fz: number,
  nx: number,
  ny: number,
  nz: number,
  ux: Float32Array,
  uy: Float32Array,
  uz: Float32Array,
  out: { x: number; y: number; z: number }
): boolean {
  if (fx < 0 || fx >= nx - 1 || fy < 0 || fy >= ny - 1 || fz < 0 || fz >= nz - 1) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return false;
  }

  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const iz = Math.floor(fz);

  const tx = fx - ix;
  const ty = fy - iy;
  const tz = fz - iz;

  const idx000 = ix + nx * (iy + ny * iz);
  const idx100 = ix + 1 + nx * (iy + ny * iz);
  const idx010 = ix + nx * (iy + 1 + ny * iz);
  const idx110 = ix + 1 + nx * (iy + 1 + ny * iz);
  const idx001 = ix + nx * (iy + ny * (iz + 1));
  const idx101 = ix + 1 + nx * (iy + ny * (iz + 1));
  const idx011 = ix + nx * (iy + 1 + ny * (iz + 1));
  const idx111 = ix + 1 + nx * (iy + 1 + ny * (iz + 1));

  const c00_x = ux[idx000] * (1 - tx) + ux[idx100] * tx;
  const c10_x = ux[idx010] * (1 - tx) + ux[idx110] * tx;
  const c01_x = ux[idx001] * (1 - tx) + ux[idx101] * tx;
  const c11_x = ux[idx011] * (1 - tx) + ux[idx111] * tx;
  const c0_x = c00_x * (1 - ty) + c10_x * ty;
  const c1_x = c01_x * (1 - ty) + c11_x * ty;
  out.x = c0_x * (1 - tz) + c1_x * tz;

  const c00_y = uy[idx000] * (1 - tx) + uy[idx100] * tx;
  const c10_y = uy[idx010] * (1 - tx) + uy[idx110] * tx;
  const c01_y = uy[idx001] * (1 - tx) + uy[idx101] * tx;
  const c11_y = uy[idx011] * (1 - tx) + uy[idx111] * tx;
  const c0_y = c00_y * (1 - ty) + c10_y * ty;
  const c1_y = c01_y * (1 - ty) + c11_y * ty;
  out.y = c0_y * (1 - tz) + c1_y * tz;

  const c00_z = uz[idx000] * (1 - tx) + uz[idx100] * tx;
  const c10_z = uz[idx010] * (1 - tx) + uz[idx110] * tx;
  const c01_z = uz[idx001] * (1 - tx) + uz[idx101] * tx;
  const c11_z = uz[idx011] * (1 - tx) + uz[idx111] * tx;
  const c0_z = c00_z * (1 - ty) + c10_z * ty;
  const c1_z = c01_z * (1 - ty) + c11_z * ty;
  out.z = c0_z * (1 - tz) + c1_z * tz;

  return true;
}

/**
 * Interactive 3D Streamlines & Smoke Rake Renderer.
 * Advects streamline trajectories using 2nd-order Runge-Kutta (RK2) and renders
 * both continuous CFD-colored streaklines and animated smoke streak particles.
 */
export class StreamlineRenderer {
  private scene: THREE.Scene;
  private group: THREE.Group;
  private rakeMesh: THREE.Group;
  private linesMesh: THREE.LineSegments | null = null;
  private particlesMesh: THREE.Points | null = null;

  private enabled = false;
  private rakeY = 0.0; // -1 .. 1
  private rakeZ = 0.0; // -1 .. 1

  private maxStreamlines = 32;
  private maxPointsPerLine = 120;
  private linePositions: Float32Array;
  private lineColors: Float32Array;

  // Smoke particles traveling along streamlines
  private particlePositions: Float32Array;
  private particleColors: Float32Array;
  private particleProgress: Float32Array; // 0..1 along each line
  private particleSpeeds: Float32Array;

  // Cached streamline polyline vertices for particle interpolation
  private cachedLines: Float32Array[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.scene.add(this.group);

    this.rakeMesh = new THREE.Group();
    this.group.add(this.rakeMesh);

    const totalSegs = this.maxStreamlines * (this.maxPointsPerLine - 1) * 2;
    this.linePositions = new Float32Array(totalSegs * 3);
    this.lineColors = new Float32Array(totalSegs * 3);

    const numParticles = this.maxStreamlines * 6;
    this.particlePositions = new Float32Array(numParticles * 3);
    this.particleColors = new Float32Array(numParticles * 3);
    this.particleProgress = new Float32Array(numParticles);
    this.particleSpeeds = new Float32Array(numParticles);

    for (let i = 0; i < numParticles; i++) {
      this.particleProgress[i] = Math.random();
      this.particleSpeeds[i] = 0.15 + Math.random() * 0.1;
    }

    this.initMeshes();
  }

  private initMeshes(): void {
    // 1. Line segments for streamlines
    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    lineGeom.setAttribute('color', new THREE.BufferAttribute(this.lineColors, 3));
    lineGeom.setDrawRange(0, 0);

    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.linesMesh = new THREE.LineSegments(lineGeom, lineMat);
    this.group.add(this.linesMesh);

    // 2. Animated glowing smoke particles
    const partGeom = new THREE.BufferGeometry();
    partGeom.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3));
    partGeom.setAttribute('color', new THREE.BufferAttribute(this.particleColors, 3));

    const partMat = new THREE.PointsMaterial({
      size: 0.045,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.particlesMesh = new THREE.Points(partGeom, partMat);
    this.group.add(this.particlesMesh);
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.group.visible = enabled;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setRakePosition(rakeY: number, rakeZ: number): void {
    this.rakeY = Math.max(-1, Math.min(1, rakeY));
    this.rakeZ = Math.max(-1, Math.min(1, rakeZ));
  }

  public getRakePosition(): { y: number; z: number } {
    return { y: this.rakeY, z: this.rakeZ };
  }

  /**
   * Rebuilds the visual 3D smoke rake wand in the tunnel.
   */
  private updateRakeWand(xPos: number, centerY: number, centerZ: number, spanZ: number): void {
    while (this.rakeMesh.children.length > 0) {
      this.rakeMesh.remove(this.rakeMesh.children[0]);
    }

    const barGeom = new THREE.CylinderGeometry(0.012, 0.012, spanZ, 8);
    const barMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      metalness: 0.85,
      roughness: 0.2,
    });
    const bar = new THREE.Mesh(barGeom, barMat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(xPos, centerY, centerZ);
    this.rakeMesh.add(bar);

    // Emitter nozzle dots
    const nozzleGeom = new THREE.SphereGeometry(0.018, 6, 6);
    const nozzleMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const count = 12;
    for (let i = 0; i < count; i++) {
      const frac = (i / (count - 1) - 0.5) * spanZ;
      const nozzle = new THREE.Mesh(nozzleGeom, nozzleMat);
      nozzle.position.set(xPos + 0.01, centerY, centerZ + frac);
      this.rakeMesh.add(nozzle);
    }
  }

  /**
   * Recomputes streamline paths through the 3D flow field using 2nd-order Runge-Kutta.
   */
  public updateFlow(params: StreamlineTraceParams): void {
    if (!this.enabled || !this.linesMesh) return;

    const { voxel, ux, uy, uz, rakeY, rakeZ, uInletLattice, tunnel } = params;
    const { nx, ny, nz, dx, originX, originY, originZ, cellFlags } = voxel;

    this.rakeY = rakeY;
    this.rakeZ = rakeZ;

    // Upstream emitter plane (x = originX + 2*dx)
    const rakeX = originX + 2.0 * dx;
    const rakeCenterY = originY + (0.5 + 0.35 * rakeY) * ny * dx;
    const rakeCenterZ = originZ + (0.5 + 0.35 * rakeZ) * nz * dx;
    const rakeSpanZ = Math.min(tunnel.width * 0.7, nz * dx * 0.65);
    const rakeSpanY = Math.min(tunnel.height * 0.5, ny * dx * 0.5);

    this.updateRakeWand(rakeX, rakeCenterY, rakeCenterZ, rakeSpanZ);

    // Seed emitter locations (a 2D grid of nozzles: 4 rows x 8 cols = 32 seeds)
    const nRows = 4;
    const nCols = 8;
    let lineCount = 0;
    let segVertexIdx = 0;
    this.cachedLines = [];

    const vLocal = { x: 0, y: 0, z: 0 };
    const rgb: [number, number, number] = [0, 0, 0];
    const ds = dx * 0.65; // Streamline step size

    for (let r = 0; r < nRows; r++) {
      const yOffset = (nRows > 1 ? (r / (nRows - 1) - 0.5) : 0) * rakeSpanY;
      const seedY = rakeCenterY + yOffset;

      for (let c = 0; c < nCols; c++) {
        const zOffset = (nCols > 1 ? (c / (nCols - 1) - 0.5) : 0) * rakeSpanZ;
        const seedZ = rakeCenterZ + zOffset;

        let curX = rakeX;
        let curY = seedY;
        let curZ = seedZ;

        const linePoints: number[] = [curX, curY, curZ];

        for (let step = 0; step < this.maxPointsPerLine; step++) {
          // Convert world position to continuous cell coordinates
          const fx = (curX - originX) / dx - 0.5;
          const fy = (curY - originY) / dx - 0.5;
          const fz = (curZ - originZ) / dx - 0.5;

          if (fx < 0 || fx >= nx - 1 || fy < 0 || fy >= ny - 1 || fz < 0 || fz >= nz - 1) {
            break;
          }

          const ix = Math.round(fx);
          const iy = Math.round(fy);
          const iz = Math.round(fz);
          const cellIdx = ix + nx * (iy + ny * iz);
          if (cellFlags && cellFlags[cellIdx] === 1) {
            // Hit obstacle boundary
            break;
          }

          // Sample k1 = u(x)
          const validK1 = sampleVelocityTrilinear(fx, fy, fz, nx, ny, nz, ux, uy, uz, vLocal);
          if (!validK1) break;

          const k1x = vLocal.x;
          const k1y = vLocal.y;
          const k1z = vLocal.z;
          const speed1 = Math.sqrt(k1x * k1x + k1y * k1y + k1z * k1z);
          if (speed1 < 1e-5) break;

          // Midpoint RK2
          const midX = curX + (0.5 * ds * k1x) / speed1;
          const midY = curY + (0.5 * ds * k1y) / speed1;
          const midZ = curZ + (0.5 * ds * k1z) / speed1;

          const midFx = (midX - originX) / dx - 0.5;
          const midFy = (midY - originY) / dx - 0.5;
          const midFz = (midZ - originZ) / dx - 0.5;

          const validK2 = sampleVelocityTrilinear(midFx, midFy, midFz, nx, ny, nz, ux, uy, uz, vLocal);
          if (!validK2) break;

          const k2x = vLocal.x;
          const k2y = vLocal.y;
          const k2z = vLocal.z;
          const speed2 = Math.sqrt(k2x * k2x + k2y * k2y + k2z * k2z);
          if (speed2 < 1e-5) break;

          // Next position
          const nextX = curX + (ds * k2x) / speed2;
          const nextY = curY + (ds * k2y) / speed2;
          const nextZ = curZ + (ds * k2z) / speed2;

          // Record line segment
          const baseIdx = segVertexIdx * 3;

          // Vertex 1
          this.linePositions[baseIdx + 0] = curX;
          this.linePositions[baseIdx + 1] = curY;
          this.linePositions[baseIdx + 2] = curZ;

          const normSpeed1 = Math.min(1.4, speed1 / Math.max(1e-4, uInletLattice));
          sampleCFDColormap(Math.min(1.0, normSpeed1 / 1.3), rgb);
          this.lineColors[baseIdx + 0] = rgb[0];
          this.lineColors[baseIdx + 1] = rgb[1];
          this.lineColors[baseIdx + 2] = rgb[2];

          // Vertex 2
          this.linePositions[baseIdx + 3] = nextX;
          this.linePositions[baseIdx + 4] = nextY;
          this.linePositions[baseIdx + 5] = nextZ;

          const normSpeed2 = Math.min(1.4, speed2 / Math.max(1e-4, uInletLattice));
          sampleCFDColormap(Math.min(1.0, normSpeed2 / 1.3), rgb);
          this.lineColors[baseIdx + 3] = rgb[0];
          this.lineColors[baseIdx + 4] = rgb[1];
          this.lineColors[baseIdx + 5] = rgb[2];

          segVertexIdx += 2;
          curX = nextX;
          curY = nextY;
          curZ = nextZ;

          linePoints.push(curX, curY, curZ);
        }

        if (linePoints.length >= 6) {
          this.cachedLines.push(new Float32Array(linePoints));
        }

        lineCount++;
        if (lineCount >= this.maxStreamlines) break;
      }
      if (lineCount >= this.maxStreamlines) break;
    }

    const posAttr = this.linesMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = this.linesMesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    this.linesMesh.geometry.setDrawRange(0, segVertexIdx);
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }

  /**
   * Advances animated smoke particles along the streamline paths.
   */
  public animateParticles(dtSec: number): void {
    if (!this.enabled || !this.particlesMesh || this.cachedLines.length === 0) return;

    const numParticles = this.particleProgress.length;
    const numLines = this.cachedLines.length;
    const particlesPerLine = Math.floor(numParticles / numLines);

    const rgb: [number, number, number] = [0, 0, 0];

    for (let i = 0; i < numParticles; i++) {
      const lineIdx = Math.floor(i / Math.max(1, particlesPerLine)) % numLines;
      const line = this.cachedLines[lineIdx];
      const ptCount = line.length / 3;

      if (ptCount < 2) continue;

      // Advance progress
      this.particleProgress[i] = (this.particleProgress[i] + this.particleSpeeds[i] * dtSec) % 1.0;
      const progress = this.particleProgress[i];

      // Interpolate along polyline
      const totalSegs = ptCount - 1;
      const exactSeg = progress * totalSegs;
      const sIdx = Math.min(totalSegs - 1, Math.floor(exactSeg));
      const t = exactSeg - sIdx;

      const p0x = line[sIdx * 3];
      const p0y = line[sIdx * 3 + 1];
      const p0z = line[sIdx * 3 + 2];

      const p1x = line[(sIdx + 1) * 3];
      const p1y = line[(sIdx + 1) * 3 + 1];
      const p1z = line[(sIdx + 1) * 3 + 2];

      const px = p0x + (p1x - p0x) * t;
      const py = p0y + (p1y - p0y) * t;
      const pz = p0z + (p1z - p0z) * t;

      this.particlePositions[i * 3 + 0] = px;
      this.particlePositions[i * 3 + 1] = py;
      this.particlePositions[i * 3 + 2] = pz;

      // Color smoke particles with warm glow
      sampleCFDColormap(0.4 + 0.5 * progress, rgb);
      this.particleColors[i * 3 + 0] = Math.min(1.0, rgb[0] * 1.3);
      this.particleColors[i * 3 + 1] = Math.min(1.0, rgb[1] * 1.3);
      this.particleColors[i * 3 + 2] = Math.min(1.0, rgb[2] * 1.3);
    }

    const posAttr = this.particlesMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = this.particlesMesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }

  public dispose(): void {
    if (this.linesMesh) {
      this.group.remove(this.linesMesh);
      this.linesMesh.geometry.dispose();
      (this.linesMesh.material as THREE.Material).dispose();
      this.linesMesh = null;
    }
    if (this.particlesMesh) {
      this.group.remove(this.particlesMesh);
      this.particlesMesh.geometry.dispose();
      (this.particlesMesh.material as THREE.Material).dispose();
      this.particlesMesh = null;
    }
    this.scene.remove(this.group);
  }
}
