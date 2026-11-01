import * as THREE from 'three';
import type { TunnelDimensions } from '../core/types';
import type { SliceAxis } from '../solver/lbmCpuReference';

/**
 * Renders the real-time 2D movable cross-section plane in the 3D Wind Tunnel viewport,
 * displaying live WebGPU-computed Velocity, Vorticity (Curl), or Pressure Coefficient (Cp)
 * in the scientific Blue / Cyan / Green / Orange / Red colormap at 60 FPS.
 */
export class FlowSlicePlaneRenderer {
  private group: THREE.Group;
  private sliceMesh: THREE.Mesh | null = null;
  private texture: THREE.DataTexture | null = null;
  private texWidth = 0;
  private texHeight = 0;

  private axis: SliceAxis = 'z';
  private sliceFraction = 0.5;
  private visible = true;
  private tunnel: TunnelDimensions;

  constructor(parentScene: THREE.Scene, tunnel: TunnelDimensions) {
    this.group = new THREE.Group();
    this.tunnel = { ...tunnel };
    parentScene.add(this.group);
  }

  public setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
  }

  public getMesh(): THREE.Mesh | null {
    return this.sliceMesh;
  }

  public updatePose(tunnel: TunnelDimensions, axis: SliceAxis, sliceFraction: number): void {
    const axisChanged = axis !== this.axis;
    const tunnelChanged =
      tunnel.length !== this.tunnel.length ||
      tunnel.width !== this.tunnel.width ||
      tunnel.height !== this.tunnel.height;

    this.tunnel = { ...tunnel };
    this.axis = axis;
    this.sliceFraction = Math.max(0.02, Math.min(0.98, sliceFraction));

    if (axisChanged || tunnelChanged || !this.sliceMesh) {
      this.rebuildPlaneGeometry();
    } else {
      this.applyPositionOnly();
    }
  }

  public updateSlicePixels(width: number, height: number, rgba: Uint8Array): void {
    if (!this.visible) return;

    if (!this.texture || this.texWidth !== width || this.texHeight !== height) {
      this.texture?.dispose();
      const copyBuf = new Uint8Array(rgba.length);
      copyBuf.set(rgba);
      this.texture = new THREE.DataTexture(copyBuf, width, height, THREE.RGBAFormat);
      this.texture.magFilter = THREE.LinearFilter;
      this.texture.minFilter = THREE.LinearFilter;
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.needsUpdate = true;
      this.texWidth = width;
      this.texHeight = height;
      this.rebuildPlaneGeometry();
    } else {
      const dst = this.texture.image.data as Uint8Array;
      dst.set(rgba);
      this.texture.needsUpdate = true;
    }
  }

  private rebuildPlaneGeometry(): void {
    while (this.group.children.length > 0) {
      const child = this.group.children[0] as THREE.Mesh;
      this.group.remove(child);
      child.geometry?.dispose();
    }

    const { length: L, height: H, width: W } = this.tunnel;
    let planeW = L;
    let planeH = H;

    if (this.axis === 'y') {
      planeW = L;
      planeH = W;
    } else if (this.axis === 'x') {
      planeW = W;
      planeH = H;
    }

    const geom = new THREE.PlaneGeometry(planeW, planeH);
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture ?? null,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.sliceMesh = new THREE.Mesh(geom, mat);
    this.group.add(this.sliceMesh);

    // Bright cyan border around active CFD cross-section plane
    const edges = new THREE.EdgesGeometry(geom);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.75,
    });
    const border = new THREE.LineSegments(edges, lineMat);
    this.sliceMesh.add(border);

    this.applyPositionOnly();
  }

  private applyPositionOnly(): void {
    if (!this.sliceMesh) return;
    const { length: L, height: H, width: W } = this.tunnel;

    this.sliceMesh.rotation.set(0, 0, 0);
    if (this.axis === 'z') {
      const z = -W * 0.5 + this.sliceFraction * W;
      this.sliceMesh.position.set(0, 0, z);
    } else if (this.axis === 'y') {
      const y = -H * 0.5 + this.sliceFraction * H;
      this.sliceMesh.rotation.x = Math.PI / 2;
      this.sliceMesh.position.set(0, y, 0);
    } else {
      const x = -L * 0.5 + this.sliceFraction * L;
      this.sliceMesh.rotation.y = Math.PI / 2;
      this.sliceMesh.position.set(x, 0, 0);
    }
  }
}
