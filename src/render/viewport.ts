import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { FluidPreset, GizmoMode, ModelTransform, SliceAxis, TunnelDimensions, VoxelVizMode, WindTunnelState } from '../core/types';
import { eventBus } from '../core/eventBus';
import { VoxelDebugVisualizer } from './voxelDebugView';
import { FlowSlicePlaneRenderer } from './slicePlane';
import type { VoxelGridResult } from '../geometry/voxelizer';
import { SurfaceHeatmapRenderer, type SurfaceHeatmapMode } from './surfaceHeatmap';
import { VortexIsoVisualizer } from './vortexIso';
import { StreamlineRenderer } from './streamlines';
import { PointProbeTool } from './pointProbe';

export class WindTunnelViewport {
  private container: HTMLElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private orbitControls: OrbitControls;
  private transformControls: TransformControls;

  private tunnelGroup: THREE.Group;
  private groundPlaneGroup: THREE.Group;
  private windVectorsGroup: THREE.Group;
  private silhouettePreviewGroup: THREE.Group;
  private voxelVisualizer: VoxelDebugVisualizer;
  private flowSliceRenderer: FlowSlicePlaneRenderer;

  private activeMesh: THREE.Mesh | null = null;
  private activeWireframe: THREE.LineSegments | null = null;
  private boundingBoxHelper: THREE.BoxHelper | null = null;

  private windParticles: THREE.Points | null = null;
  private windParticleVelocities: Float32Array = new Float32Array(0);
  private currentWindSpeed = 25;
  private currentTunnel: TunnelDimensions = { length: 6.0, width: 2.8, height: 2.4 };
  private groundPlaneEnabled = false;

  private onTransformCallback?: (transform: ModelTransform) => void;

  // Phase 5: Advanced 3D Aerodynamic Visualizers
  private surfaceHeatmap: SurfaceHeatmapRenderer;
  private vortexIso: VortexIsoVisualizer;
  private streamlineRenderer: StreamlineRenderer;
  private pointProbe: PointProbeTool;
  private lastAnimTimeSec = performance.now() / 1000;

  // Phase 6: Rocket Stability Visualizer (Xcp and Xcg markers)
  private stabilityGroup: THREE.Group;

  constructor(container: HTMLElement, initialState: WindTunnelState) {
    this.container = container;
    this.currentWindSpeed = initialState.windSpeed;
    this.currentTunnel = { ...initialState.tunnel };
    this.groundPlaneEnabled = initialState.groundPlaneEnabled;

    // 1. Scene setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b101b);
    this.scene.fog = new THREE.FogExp2(0x0b101b, 0.045);

    // 2. Camera setup
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 100);
    this.camera.position.set(-2.6, 1.9, 4.2);

    // 3. Renderer setup
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    container.appendChild(this.renderer.domElement);

    // 4. Orbit & Transform Controls
    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.06;
    this.orbitControls.target.set(0, 0, 0);

    this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControls.setSize(0.85);
    this.transformControls.setMode(initialState.gizmoMode);
    this.transformControls.addEventListener('dragging-changed', (event) => {
      this.orbitControls.enabled = !event.value;
      // Trigger frontal area & Reynolds update when user finishes dragging or while dragging
      if (!event.value && this.activeMesh && this.onTransformCallback) {
        this.emitCurrentTransform();
      }
    });
    this.transformControls.addEventListener('objectChange', () => {
      if (this.activeMesh) {
        this.clampModelToGroundIfEnabled();
        this.boundingBoxHelper?.update();
        this.updateProjectedSilhouetteShadow();
        this.emitCurrentTransform();
      }
    });

    const gizmoHelper = this.transformControls.getHelper();
    this.scene.add(gizmoHelper);

    // 5. Studio Wind Tunnel Lighting
    this.setupLighting();

    // 6. Scene Groups
    this.tunnelGroup = new THREE.Group();
    this.groundPlaneGroup = new THREE.Group();
    this.windVectorsGroup = new THREE.Group();
    this.silhouettePreviewGroup = new THREE.Group();
    this.stabilityGroup = new THREE.Group();

    this.scene.add(this.tunnelGroup);
    this.scene.add(this.groundPlaneGroup);
    this.scene.add(this.windVectorsGroup);
    this.scene.add(this.silhouettePreviewGroup);
    this.scene.add(this.stabilityGroup);

    this.voxelVisualizer = new VoxelDebugVisualizer(this.scene);
    this.voxelVisualizer.setMode(initialState.voxelVizMode);
    this.voxelVisualizer.setSliceZFraction(initialState.voxelSliceZ);

    this.flowSliceRenderer = new FlowSlicePlaneRenderer(this.scene, initialState.tunnel);
    this.flowSliceRenderer.setVisible(initialState.flowSliceEnabled);
    this.flowSliceRenderer.updatePose(
      initialState.tunnel,
      initialState.flowSliceAxis,
      initialState.flowSlicePos
    );

    // Initialize Phase 5 3D Visualizers
    this.surfaceHeatmap = new SurfaceHeatmapRenderer();
    this.surfaceHeatmap.setMode(initialState.surfaceHeatmapMode);

    this.vortexIso = new VortexIsoVisualizer(this.scene);
    this.vortexIso.setEnabled(initialState.vortexTubesEnabled);
    this.vortexIso.setThreshold(initialState.vortexThreshold);

    this.streamlineRenderer = new StreamlineRenderer(this.scene);
    this.streamlineRenderer.setEnabled(initialState.streamlinesEnabled);
    this.streamlineRenderer.setRakePosition(initialState.streamlineRakeY, initialState.streamlineRakeZ);

    this.pointProbe = new PointProbeTool(this.container, this.scene, this.camera);
    this.pointProbe.setEnabled(initialState.probeEnabled);

    this.rebuildTunnelEnclosure(this.currentTunnel, this.groundPlaneEnabled);
    this.initAmbientWindParticles();

    // 7. Resize listener
    window.addEventListener('resize', () => this.onResize());
    eventBus.on('camera:reset', () => this.resetCamera());
    eventBus.on('gizmo:mode', (mode) => this.setGizmoMode(mode));

    this.animate();
  }

  private setupLighting(): void {
    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.9);
    this.scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
    keyLight.position.set(-3, 5, 4);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.9);
    rimLight.position.set(4, -2, -3);
    this.scene.add(rimLight);
  }

  /**
   * Rebuilds the 3D Wind Tunnel test section box, inlet honeycomb grid, outlet plane,
   * and optional atmospheric ground floor.
   */
  public rebuildTunnelEnclosure(tunnel: TunnelDimensions, groundPlaneEnabled: boolean): void {
    this.currentTunnel = { ...tunnel };
    this.groundPlaneEnabled = groundPlaneEnabled;

    this.clearGroup(this.tunnelGroup);
    this.clearGroup(this.groundPlaneGroup);
    this.clearGroup(this.windVectorsGroup);

    const { length: L, height: H, width: W } = tunnel;

    // 1. Glass Wind Tunnel Test Section Box
    const boxGeom = new THREE.BoxGeometry(L, H, W);
    const edgesGeom = new THREE.EdgesGeometry(boxGeom);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.45,
    });
    const wireframeBox = new THREE.LineSegments(edgesGeom, edgeMat);
    this.tunnelGroup.add(wireframeBox);

    // Subtle translucent acrylic walls
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0ea5e9,
      transparent: true,
      opacity: 0.04,
      roughness: 0.1,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const glassMesh = new THREE.Mesh(boxGeom, glassMat);
    this.tunnelGroup.add(glassMesh);

    // 2. Inlet Plane (-X) with Cyan Honeycomb Grid & Flow Arrows
    const inletX = -L / 2;
    const inletGrid = this.createRectGrid(W, H, 10, 8, 0x22d3ee, 0.35);
    inletGrid.rotation.y = Math.PI / 2;
    inletGrid.position.set(inletX, 0, 0);
    this.tunnelGroup.add(inletGrid);

    // 3. Outlet Plane (+X) with Amber/Red Exit Frame (also shows live Frontal Area Silhouette projection)
    const outletX = L / 2;
    const outletGrid = this.createRectGrid(W, H, 6, 6, 0xf97316, 0.22);
    outletGrid.rotation.y = Math.PI / 2;
    outletGrid.position.set(outletX, 0, 0);
    this.tunnelGroup.add(outletGrid);

    // 4. Inlet Velocity Profile Arrows (+X direction)
    const arrowRows = 3;
    const arrowCols = 3;
    for (let r = 0; r < arrowRows; r++) {
      for (let c = 0; c < arrowCols; c++) {
        const yFrac = (r + 0.5) / arrowRows; // 0..1 from bottom to top
        const y = -H / 2 + yFrac * H;
        const z = -W / 2 + ((c + 0.5) / arrowCols) * W;

        // If groundPlaneEnabled, show logarithmic atmospheric boundary layer velocity profile!
        const profileScale = groundPlaneEnabled ? Math.min(1.15, 0.45 + 0.75 * Math.pow(yFrac, 0.35)) : 1.0;
        const arrowLen = 0.45 * profileScale;

        const dir = new THREE.Vector3(1, 0, 0);
        const origin = new THREE.Vector3(inletX + 0.05, y, z);
        const arrow = new THREE.ArrowHelper(dir, origin, arrowLen, 0x22d3ee, 0.12, 0.07);
        this.windVectorsGroup.add(arrow);
      }
    }

    // 5. Floor Reference Grid or Ground-Mounted No-Slip Atmospheric Floor
    const floorY = -H / 2;
    if (groundPlaneEnabled) {
      // Solid no-slip ground plate for sheds, tiny homes, and cars
      const groundGeom = new THREE.PlaneGeometry(L, W);
      const groundMat = new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        roughness: 0.85,
        metalness: 0.1,
      });
      const groundMesh = new THREE.Mesh(groundGeom, groundMat);
      groundMesh.rotation.x = -Math.PI / 2;
      groundMesh.position.y = floorY + 0.001;
      groundMesh.receiveShadow = true;
      this.groundPlaneGroup.add(groundMesh);

      const groundGrid = this.createRectGrid(L, W, 24, 12, 0x38bdf8, 0.35);
      groundGrid.rotation.x = -Math.PI / 2;
      groundGrid.position.y = floorY + 0.003;
      this.groundPlaneGroup.add(groundGrid);
    } else {
      // Freestream slip-wall subtle reference grid
      const floorGrid = this.createRectGrid(L, W, 18, 9, 0x334155, 0.3);
      floorGrid.rotation.x = -Math.PI / 2;
      floorGrid.position.y = floorY + 0.001;
      this.groundPlaneGroup.add(floorGrid);
    }

    this.clampModelToGroundIfEnabled();
    this.updateProjectedSilhouetteShadow();
  }

  private createRectGrid(
    width: number,
    height: number,
    segW: number,
    segH: number,
    color: number,
    opacity: number
  ): THREE.LineSegments {
    const points: number[] = [];
    const hw = width / 2;
    const hh = height / 2;

    for (let i = 0; i <= segW; i++) {
      const x = -hw + (i / segW) * width;
      points.push(x, -hh, 0, x, hh, 0);
    }
    for (let j = 0; j <= segH; j++) {
      const y = -hh + (j / segH) * height;
      points.push(-hw, y, 0, hw, y, 0);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    return new THREE.LineSegments(geom, mat);
  }

  private initAmbientWindParticles(): void {
    const count = 260;
    const positions = new Float32Array(count * 3);
    this.windParticleVelocities = new Float32Array(count);

    const { length: L, height: H, width: W } = this.currentTunnel;
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * L;
      positions[i * 3 + 1] = (Math.random() - 0.5) * H * 0.92;
      positions[i * 3 + 2] = (Math.random() - 0.5) * W * 0.92;
      this.windParticleVelocities[i] = 0.8 + Math.random() * 0.4;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x38bdf8,
      size: 0.035,
      transparent: true,
      opacity: 0.55,
    });

    this.windParticles = new THREE.Points(geom, mat);
    this.scene.add(this.windParticles);
  }

  /**
   * Loads a THREE.BufferGeometry into the Wind Tunnel stage and attaches the interactive transform gizmo.
   */
  public setModelGeometry(geometry: THREE.BufferGeometry, transform: ModelTransform): void {
    if (this.activeMesh) {
      this.transformControls.detach();
      this.scene.remove(this.activeMesh);
      this.activeMesh.geometry.dispose();
      (this.activeMesh.material as THREE.Material).dispose();
      this.activeMesh = null;
    }
    if (this.boundingBoxHelper) {
      this.scene.remove(this.boundingBoxHelper);
      this.boundingBoxHelper.dispose();
      this.boundingBoxHelper = null;
    }

    const material = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      metalness: 0.28,
      roughness: 0.35,
      flatShading: false,
    });

    this.activeMesh = new THREE.Mesh(geometry, material);
    this.activeMesh.castShadow = true;
    this.activeMesh.receiveShadow = true;

    // Subtle CAD edge overlay
    const edges = new THREE.EdgesGeometry(geometry, 28);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x0f172a,
      transparent: true,
      opacity: 0.35,
    });
    this.activeWireframe = new THREE.LineSegments(edges, lineMat);
    this.activeMesh.add(this.activeWireframe);

    this.applyTransformToMesh(transform);
    this.scene.add(this.activeMesh);

    this.boundingBoxHelper = new THREE.BoxHelper(this.activeMesh, 0x22d3ee);
    this.scene.add(this.boundingBoxHelper);

    this.transformControls.attach(this.activeMesh);
    this.surfaceHeatmap.setMesh(this.activeMesh);
    this.pointProbe.setTargets(this.activeMesh, this.flowSliceRenderer.getMesh(), this.currentTunnel);
    this.updateProjectedSilhouetteShadow();
  }

  /**
   * Projects a visual silhouette shadow of the model onto the downstream (+X) outlet plane
   * so users can visually see the exact Frontal Area (A_ref) that blocks the wind.
   */
  private updateProjectedSilhouetteShadow(): void {
    this.clearGroup(this.silhouettePreviewGroup);
    if (!this.activeMesh) return;

    const silMat = new THREE.MeshBasicMaterial({
      color: 0xf97316,
      transparent: true,
      opacity: 0.26,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const silClone = new THREE.Mesh(this.activeMesh.geometry, silMat);
    this.activeMesh.updateMatrixWorld();

    // Flatten X coordinate onto outlet plane (+L/2 - 0.005) while preserving Y and Z world coordinates
    const outletX = this.currentTunnel.length / 2 - 0.005;
    const flattenMatrix = new THREE.Matrix4().set(
      0.0001, 0, 0, outletX,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    );

    silClone.matrixAutoUpdate = false;
    silClone.matrix.multiplyMatrices(flattenMatrix, this.activeMesh.matrixWorld);
    this.silhouettePreviewGroup.add(silClone);
  }

  public applyTransformToMesh(transform: ModelTransform): void {
    if (!this.activeMesh) return;
    this.activeMesh.position.set(transform.position.x, transform.position.y, transform.position.z);
    this.activeMesh.rotation.set(
      THREE.MathUtils.degToRad(transform.rotationDeg.x),
      THREE.MathUtils.degToRad(transform.rotationDeg.y),
      THREE.MathUtils.degToRad(transform.rotationDeg.z)
    );
    this.activeMesh.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
    this.clampModelToGroundIfEnabled();
    this.activeMesh.updateMatrixWorld();
    this.boundingBoxHelper?.update();
    this.updateProjectedSilhouetteShadow();
  }

  private clampModelToGroundIfEnabled(): void {
    if (!this.activeMesh || !this.groundPlaneEnabled) return;
    this.activeMesh.updateMatrixWorld();
    const box = new THREE.Box3().setFromObject(this.activeMesh);
    const floorY = -this.currentTunnel.height / 2;
    if (Math.abs(box.min.y - floorY) > 0.002) {
      this.activeMesh.position.y += floorY - box.min.y;
      this.activeMesh.updateMatrixWorld();
    }
  }

  public getCurrentTransform(): ModelTransform {
    if (!this.activeMesh) {
      return {
        position: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      };
    }
    return {
      position: {
        x: Number(this.activeMesh.position.x.toFixed(3)),
        y: Number(this.activeMesh.position.y.toFixed(3)),
        z: Number(this.activeMesh.position.z.toFixed(3)),
      },
      rotationDeg: {
        x: Number(THREE.MathUtils.radToDeg(this.activeMesh.rotation.x).toFixed(1)),
        y: Number(THREE.MathUtils.radToDeg(this.activeMesh.rotation.y).toFixed(1)),
        z: Number(THREE.MathUtils.radToDeg(this.activeMesh.rotation.z).toFixed(1)),
      },
      scale: {
        x: Number(this.activeMesh.scale.x.toFixed(3)),
        y: Number(this.activeMesh.scale.y.toFixed(3)),
        z: Number(this.activeMesh.scale.z.toFixed(3)),
      },
    };
  }

  public setOnTransformChange(cb: (transform: ModelTransform) => void): void {
    this.onTransformCallback = cb;
  }

  private emitCurrentTransform(): void {
    if (this.onTransformCallback) {
      this.onTransformCallback(this.getCurrentTransform());
    }
  }

  public setWindSpeed(speed: number): void {
    this.currentWindSpeed = speed;
  }

  public setGizmoMode(mode: GizmoMode): void {
    this.transformControls.setMode(mode);
  }

  public resetCamera(): void {
    this.camera.position.set(-2.6, 1.9, 4.2);
    this.orbitControls.target.set(0, 0, 0);
    this.orbitControls.update();
  }

  public getActiveGeometry(): THREE.BufferGeometry | null {
    return this.activeMesh ? this.activeMesh.geometry : null;
  }

  public getActiveWorldMatrix(): THREE.Matrix4 | undefined {
    if (!this.activeMesh) return undefined;
    this.activeMesh.updateMatrixWorld();
    return this.activeMesh.matrixWorld;
  }

  public updateVoxelVisualization(
    result: VoxelGridResult,
    mode: VoxelVizMode,
    sliceZFraction: number
  ): void {
    this.voxelVisualizer.setMode(mode);
    this.voxelVisualizer.setSliceZFraction(sliceZFraction);
    this.voxelVisualizer.update(result);

    // Make the STL mesh slightly translucent when inspecting the 3D q-Shell so interior/boundary voxels stand out
    if (this.activeMesh) {
      const mat = this.activeMesh.material as THREE.MeshStandardMaterial;
      if (mode === 'shell_3d') {
        mat.transparent = true;
        mat.opacity = 0.28;
      } else {
        mat.transparent = false;
        mat.opacity = 1.0;
      }
      mat.needsUpdate = true;
    }
  }

  public updateFlowSlicePose(
    tunnel: TunnelDimensions,
    axis: SliceAxis,
    slicePos: number,
    enabled: boolean
  ): void {
    this.flowSliceRenderer.setVisible(enabled);
    this.flowSliceRenderer.updatePose(tunnel, axis, slicePos);
  }

  public updateFlowSlicePixels(width: number, height: number, rgba: Uint8Array): void {
    this.flowSliceRenderer.updateSlicePixels(width, height, rgba);
  }

  // Phase 5: Advanced 3D Aerodynamic Visualizations Controls
  public setSurfaceHeatmapMode(mode: SurfaceHeatmapMode): void {
    this.surfaceHeatmap.setMode(mode);
  }

  public setVortexTubes(enabled: boolean, threshold: number): void {
    this.vortexIso.setEnabled(enabled);
    this.vortexIso.setThreshold(threshold);
  }

  public setStreamlines(enabled: boolean, rakeY: number, rakeZ: number): void {
    this.streamlineRenderer.setEnabled(enabled);
    this.streamlineRenderer.setRakePosition(rakeY, rakeZ);
  }

  public setPointProbe(enabled: boolean): void {
    this.pointProbe.setEnabled(enabled);
  }

  public updateMacroVisualizations(params: {
    voxel: VoxelGridResult;
    ux: Float32Array;
    uy: Float32Array;
    uz: Float32Array;
    rho: Float32Array;
    uInletLattice: number;
    windSpeedMps: number;
    fluid: FluidPreset;
    rakeY?: number;
    rakeZ?: number;
  }): void {
    if (this.surfaceHeatmap.getMode() !== 'off') {
      this.surfaceHeatmap.updateFromField({
        voxel: params.voxel,
        rho: params.rho,
        ux: params.ux,
        uInletLattice: params.uInletLattice,
        worldMatrix: this.getActiveWorldMatrix(),
      });
    }

    if (this.vortexIso.isEnabled()) {
      this.vortexIso.update({
        voxel: params.voxel,
        ux: params.ux,
        uy: params.uy,
        uz: params.uz,
      });
    }

    if (this.streamlineRenderer.isEnabled()) {
      this.streamlineRenderer.updateFlow({
        voxel: params.voxel,
        ux: params.ux,
        uy: params.uy,
        uz: params.uz,
        rakeY: params.rakeY ?? 0,
        rakeZ: params.rakeZ ?? 0,
        uInletLattice: params.uInletLattice,
        tunnel: this.currentTunnel,
      });
    }

    if (this.pointProbe.isEnabled()) {
      this.pointProbe.updateFlowField(params);
    }
  }

  /**
   * Phase 6: Visualizes Rocket Aerodynamic Stability by rendering:
   * 1. Center of Gravity (X_cg) as an amber sphere
   * 2. Center of Pressure (X_cp) as a cyan targeting ring along the model centerline
   * 3. A dashed connecting line displaying the static margin
   */
  public updateRocketStabilityMarker(params: {
    visible: boolean;
    xcp: number;
    xcg: number;
    diameter: number;
  }): void {
    this.clearGroup(this.stabilityGroup);
    if (!params.visible) return;

    const posY = this.activeMesh ? this.activeMesh.position.y : 0;
    const posZ = this.activeMesh ? this.activeMesh.position.z : 0;

    // Streamwise line connecting Xcg to Xcp
    const lineMat = new THREE.LineDashedMaterial({
      color: 0x38bdf8,
      dashSize: 0.04,
      gapSize: 0.02,
    });
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(params.xcg, posY, posZ),
      new THREE.Vector3(params.xcp, posY, posZ),
    ]);
    const line = new THREE.Line(lineGeo, lineMat);
    line.computeLineDistances();
    this.stabilityGroup.add(line);

    // Xcg marker: Amber sphere
    const cgGeo = new THREE.SphereGeometry(Math.max(0.025, params.diameter * 0.07), 16, 16);
    const cgMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
    const cgMesh = new THREE.Mesh(cgGeo, cgMat);
    cgMesh.position.set(params.xcg, posY, posZ);
    this.stabilityGroup.add(cgMesh);

    // Xcp marker: Cyan targeting ring perpendicular to streamwise wind
    const cpGeo = new THREE.TorusGeometry(Math.max(0.05, params.diameter * 0.22), 0.008, 12, 32);
    const cpMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4 });
    const cpMesh = new THREE.Mesh(cpGeo, cpMat);
    cpMesh.rotation.y = Math.PI / 2;
    cpMesh.position.set(params.xcp, posY, posZ);
    this.stabilityGroup.add(cpMesh);
  }

  /**
   * Forces an immediate, synchronous frame render to the WebGL canvas,
   * guaranteeing the drawing buffer is populated before snapshot capture.
   */
  public renderNow(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Returns the underlying WebGL/Three.js canvas for high-resolution report snapshots.
   */
  public getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  private clearGroup(group: THREE.Group): void {
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
    }
  }

  private onResize(): void {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);

    // Animate ambient wind particles along +X proportional to wind speed
    if (this.windParticles) {
      const posAttr = this.windParticles.geometry.getAttribute('position') as THREE.BufferAttribute;
      const halfL = this.currentTunnel.length / 2;
      const step = Math.min(0.18, Math.max(0.004, this.currentWindSpeed * 0.0018));

      for (let i = 0; i < posAttr.count; i++) {
        let x = posAttr.getX(i) + step * this.windParticleVelocities[i];
        if (x > halfL) {
          x = -halfL;
        }
        posAttr.setX(i, x);
      }
      posAttr.needsUpdate = true;
    }

    this.orbitControls.update();

    const nowSec = performance.now() / 1000;
    const dt = Math.min(0.1, Math.max(1e-4, nowSec - this.lastAnimTimeSec));
    this.lastAnimTimeSec = nowSec;

    if (this.streamlineRenderer.isEnabled()) {
      this.streamlineRenderer.animateParticles(dt);
    }

    this.renderer.render(this.scene, this.camera);
  };
}
