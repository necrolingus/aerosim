import * as THREE from 'three';
import type { FluidPreset, TunnelDimensions } from '../core/types';
import type { VoxelGridResult } from '../geometry/voxelizer';
import { sampleVelocityTrilinear } from './streamlines';

export interface ProbeReadout {
  worldPos: { x: number; y: number; z: number };
  latticeCell: { ix: number; iy: number; iz: number };
  speedMps: number;
  speedMph: number;
  velocityMps: { ux: number; uy: number; uz: number };
  gaugePressurePa: number;
  pressureCoeffCp: number;
  densityRho: number;
  dynamicPressurePa: number;
  isInsideSolid: boolean;
}

/**
 * Computes exact physical aerodynamic flow properties at any point from local macroscopic variables.
 */
export function computeProbePhysics(params: {
  localRho: number;
  localUx: number;
  localUy: number;
  localUz: number;
  windSpeedMps: number;
  uInletLattice: number;
  fluid: FluidPreset;
  isSolid?: boolean;
  worldPos: { x: number; y: number; z: number };
  latticeCell: { ix: number; iy: number; iz: number };
}): ProbeReadout {
  const {
    localRho,
    localUx,
    localUy,
    localUz,
    windSpeedMps,
    uInletLattice,
    fluid,
    isSolid = false,
    worldPos,
    latticeCell,
  } = params;

  if (isSolid) {
    return {
      worldPos,
      latticeCell,
      speedMps: 0,
      speedMph: 0,
      velocityMps: { ux: 0, uy: 0, uz: 0 },
      gaugePressurePa: 0,
      pressureCoeffCp: 0,
      densityRho: 1.0,
      dynamicPressurePa: 0.5 * fluid.density * windSpeedMps * windSpeedMps,
      isInsideSolid: true,
    };
  }

  // Velocity scaling factor: U_phys / U_lat
  const velScale = windSpeedMps / Math.max(1e-4, uInletLattice);
  const uxPhys = localUx * velScale;
  const uyPhys = localUy * velScale;
  const uzPhys = localUz * velScale;
  const speedMps = Math.sqrt(uxPhys * uxPhys + uyPhys * uyPhys + uzPhys * uzPhys);
  const speedMph = speedMps * 2.23694;

  const qDynamic = 0.5 * fluid.density * windSpeedMps * windSpeedMps;

  // LBM pressure: p = cs^2 * rho, where cs^2 = 1/3
  // Cp = (cs^2 * (rho - 1.0)) / (0.5 * uInletLattice^2)
  const qLat = 0.5 * 1.0 * uInletLattice * uInletLattice;
  const pressureCoeffCp = ((1.0 / 3.0) * (localRho - 1.0)) / Math.max(1e-6, qLat);

  // Gauge pressure: Delta p = Cp * q_inf
  const gaugePressurePa = pressureCoeffCp * qDynamic;

  return {
    worldPos,
    latticeCell,
    speedMps,
    speedMph,
    velocityMps: { ux: uxPhys, uy: uyPhys, uz: uzPhys },
    gaugePressurePa,
    pressureCoeffCp,
    densityRho: localRho,
    dynamicPressurePa: qDynamic,
    isInsideSolid: false,
  };
}

/**
 * Interactive 3D Point Probe Tool.
 * Casts rays from mouse pointer into the 3D scene (model, slice plane, or volume),
 * interpolates local flow quantities, and displays an interactive 3D reticle and floating CFD telemetry tooltip.
 */
export class PointProbeTool {
  private container: HTMLElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;

  private enabled = false;
  private reticleMesh: THREE.Group;
  private tooltipEl: HTMLElement;

  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  private activeMesh: THREE.Mesh | null = null;
  private sliceMesh: THREE.Mesh | null = null;
  private tunnel: TunnelDimensions = { length: 6, width: 2.8, height: 2.4 };

  private currentVoxel: VoxelGridResult | null = null;
  private currentField: {
    ux: Float32Array;
    uy: Float32Array;
    uz: Float32Array;
    rho: Float32Array;
  } | null = null;
  private uInletLattice = 0.085;
  private windSpeedMps = 25.0;
  private fluid: FluidPreset = {
    id: 'air_20c',
    name: 'Air (20°C, 1 atm)',
    density: 1.204,
    kinematicViscosity: 1.516e-5,
    speedOfSound: 343.2,
  };

  private lastReadout: ProbeReadout | null = null;

  constructor(container: HTMLElement, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.container = container;
    this.scene = scene;
    this.camera = camera;

    // 1. Build 3D Reticle in Scene
    this.reticleMesh = new THREE.Group();
    this.reticleMesh.visible = false;
    this.scene.add(this.reticleMesh);
    this.buildReticle();

    // 2. Build DOM Floating Tooltip
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'point-probe-tooltip';
    this.tooltipEl.style.display = 'none';
    this.container.appendChild(this.tooltipEl);

    // 3. Event Listeners
    this.container.addEventListener('pointermove', this.onPointerMove);
  }

  private buildReticle(): void {
    // Glowing central bead
    const beadGeom = new THREE.SphereGeometry(0.024, 12, 12);
    const beadMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const bead = new THREE.Mesh(beadGeom, beadMat);
    this.reticleMesh.add(bead);

    // Crosshair circle ring
    const ringGeom = new THREE.RingGeometry(0.045, 0.052, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    this.reticleMesh.add(ring);

    // 3-axis mini-tick markers
    const axisMat = new THREE.LineBasicMaterial({ color: 0xfacc15 });
    const pts = [
      new THREE.Vector3(-0.08, 0, 0),
      new THREE.Vector3(0.08, 0, 0),
      new THREE.Vector3(0, -0.08, 0),
      new THREE.Vector3(0, 0.08, 0),
    ];
    const axisGeom = new THREE.BufferGeometry().setFromPoints(pts);
    const axes = new THREE.LineSegments(axisGeom, axisMat);
    this.reticleMesh.add(axes);
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.reticleMesh.visible = enabled;
    this.tooltipEl.style.display = enabled && this.lastReadout ? 'block' : 'none';
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setTargets(activeMesh: THREE.Mesh | null, sliceMesh: THREE.Mesh | null, tunnel: TunnelDimensions): void {
    this.activeMesh = activeMesh;
    this.sliceMesh = sliceMesh;
    this.tunnel = tunnel;
  }

  public updateFlowField(params: {
    voxel: VoxelGridResult;
    ux: Float32Array;
    uy: Float32Array;
    uz: Float32Array;
    rho: Float32Array;
    uInletLattice: number;
    windSpeedMps: number;
    fluid: FluidPreset;
  }): void {
    this.currentVoxel = params.voxel;
    this.currentField = {
      ux: params.ux,
      uy: params.uy,
      uz: params.uz,
      rho: params.rho,
    };
    this.uInletLattice = params.uInletLattice;
    this.windSpeedMps = params.windSpeedMps;
    this.fluid = params.fluid;
  }

  public getLatestReadout(): ProbeReadout | null {
    return this.lastReadout;
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled || !this.currentVoxel || !this.currentField) {
      this.reticleMesh.visible = false;
      this.tooltipEl.style.display = 'none';
      return;
    }

    const rect = this.container.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Targets to check: 1) Active Mesh, 2) Flow Slice Mesh, 3) Tunnel Center Plane
    const interactables: THREE.Object3D[] = [];
    if (this.activeMesh && this.activeMesh.visible) interactables.push(this.activeMesh);
    if (this.sliceMesh && this.sliceMesh.visible) interactables.push(this.sliceMesh);

    let hitPoint: THREE.Vector3 | null = null;
    let isMeshSurface = false;

    if (interactables.length > 0) {
      const hits = this.raycaster.intersectObjects(interactables, true);
      if (hits.length > 0) {
        hitPoint = hits[0].point;
        isMeshSurface = hits[0].object === this.activeMesh;
      }
    }

    // Fallback: intersect with midplane (z = 0)
    if (!hitPoint) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      hitPoint = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(plane, hitPoint)) {
        hitPoint = null;
      } else {
        // Clamp to tunnel bounding box
        const halfL = this.tunnel.length / 2;
        const halfH = this.tunnel.height / 2;
        if (Math.abs(hitPoint.x) > halfL || Math.abs(hitPoint.y) > halfH) {
          hitPoint = null;
        }
      }
    }

    if (!hitPoint) {
      this.reticleMesh.visible = false;
      this.tooltipEl.style.display = 'none';
      return;
    }

    // Position 3D Reticle
    this.reticleMesh.position.copy(hitPoint);
    this.reticleMesh.quaternion.copy(this.camera.quaternion);
    this.reticleMesh.visible = true;

    // Convert world position to lattice coordinates
    const { nx, ny, nz, dx, originX, originY, originZ, cellFlags } = this.currentVoxel;
    const fx = (hitPoint.x - originX) / dx - 0.5;
    const fy = (hitPoint.y - originY) / dx - 0.5;
    const fz = (hitPoint.z - originZ) / dx - 0.5;

    const ix = Math.max(0, Math.min(nx - 1, Math.round(fx)));
    const iy = Math.max(0, Math.min(ny - 1, Math.round(fy)));
    const iz = Math.max(0, Math.min(nz - 1, Math.round(fz)));
    const cellIdx = ix + nx * (iy + ny * iz);

    const isSolid = isMeshSurface || (cellFlags ? cellFlags[cellIdx] === 1 : false);

    const velSample = { x: 0, y: 0, z: 0 };
    sampleVelocityTrilinear(
      fx,
      fy,
      fz,
      nx,
      ny,
      nz,
      this.currentField.ux,
      this.currentField.uy,
      this.currentField.uz,
      velSample
    );

    const localRho = this.currentField.rho[cellIdx] || 1.0;

    const readout = computeProbePhysics({
      localRho,
      localUx: velSample.x,
      localUy: velSample.y,
      localUz: velSample.z,
      windSpeedMps: this.windSpeedMps,
      uInletLattice: this.uInletLattice,
      fluid: this.fluid,
      isSolid,
      worldPos: { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z },
      latticeCell: { ix, iy, iz },
    });

    this.lastReadout = readout;
    this.renderTooltip(e.clientX - rect.left, e.clientY - rect.top, readout);
  };

  private renderTooltip(mouseX: number, mouseY: number, r: ProbeReadout): void {
    const cpColor = r.pressureCoeffCp >= 0 ? '#ef4444' : '#38bdf8';
    const statusTag = r.isInsideSolid
      ? `<span class="probe-tag tag-solid">SOLID SURFACE</span>`
      : `<span class="probe-tag tag-fluid">FLUID DOMAIN</span>`;

    this.tooltipEl.innerHTML = `
      <div class="probe-header">
        <span class="probe-title">🎯 3D POINT PROBE</span>
        ${statusTag}
      </div>
      <div class="probe-grid">
        <div class="probe-cell"><span class="lbl">Coord (m):</span> <span class="val">[${r.worldPos.x >= 0 ? '+' : ''}${r.worldPos.x.toFixed(2)}, ${r.worldPos.y >= 0 ? '+' : ''}${r.worldPos.y.toFixed(2)}, ${r.worldPos.z >= 0 ? '+' : ''}${r.worldPos.z.toFixed(2)}]</span></div>
        <div class="probe-cell"><span class="lbl">Cell [X,Y,Z]:</span> <span class="val">[${r.latticeCell.ix}, ${r.latticeCell.iy}, ${r.latticeCell.iz}]</span></div>
        <div class="probe-cell"><span class="lbl">Speed:</span> <span class="val highlight">${r.speedMps.toFixed(1)} m/s <span class="sub">(${r.speedMph.toFixed(0)} mph)</span></span></div>
        <div class="probe-cell"><span class="lbl">Velocity (U):</span> <span class="val">[${r.velocityMps.ux.toFixed(1)}, ${r.velocityMps.uy.toFixed(1)}, ${r.velocityMps.uz.toFixed(1)}] m/s</span></div>
        <div class="probe-cell"><span class="lbl">Gauge Press (Δp):</span> <span class="val" style="color: ${cpColor}">${r.gaugePressurePa >= 0 ? '+' : ''}${r.gaugePressurePa.toFixed(1)} Pa</span></div>
        <div class="probe-cell"><span class="lbl">Pressure Coeff (Cp):</span> <span class="val" style="color: ${cpColor}; font-weight: 700;">${r.pressureCoeffCp >= 0 ? '+' : ''}${r.pressureCoeffCp.toFixed(2)}</span></div>
      </div>
    `;

    // Position tooltip offset from cursor, clamped inside viewport
    const containerW = this.container.clientWidth;
    const containerH = this.container.clientHeight;
    let posX = mouseX + 18;
    let posY = mouseY + 18;

    if (posX + 240 > containerW) posX = mouseX - 250;
    if (posY + 160 > containerH) posY = mouseY - 170;

    this.tooltipEl.style.left = `${Math.max(10, posX)}px`;
    this.tooltipEl.style.top = `${Math.max(10, posY)}px`;
    this.tooltipEl.style.display = 'block';
  }

  public dispose(): void {
    this.container.removeEventListener('pointermove', this.onPointerMove);
    if (this.tooltipEl.parentElement) {
      this.tooltipEl.parentElement.removeChild(this.tooltipEl);
    }
    this.scene.remove(this.reticleMesh);
  }
}
