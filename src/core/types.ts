/**
 * Shared physical constants, unit converters, and core simulation types.
 */

export type FluidPresetId = 'air_20c' | 'air_high_alt' | 'water_20c' | 'custom';

export interface FluidPreset {
  id: FluidPresetId;
  name: string;
  density: number; // kg/m^3 (rho)
  kinematicViscosity: number; // m^2/s (nu)
  speedOfSound: number; // m/s (c)
}

export const FLUID_PRESETS: Record<FluidPresetId, FluidPreset> = {
  air_20c: {
    id: 'air_20c',
    name: 'Air (Sea Level, 20°C)',
    density: 1.204,
    kinematicViscosity: 1.516e-5,
    speedOfSound: 343.2,
  },
  air_high_alt: {
    id: 'air_high_alt',
    name: 'Air (3000m Altitude, -5°C)',
    density: 0.909,
    kinematicViscosity: 1.86e-5,
    speedOfSound: 328.6,
  },
  water_20c: {
    id: 'water_20c',
    name: 'Water (20°C)',
    density: 998.2,
    kinematicViscosity: 1.004e-6,
    speedOfSound: 1481.0,
  },
  custom: {
    id: 'custom',
    name: 'Custom Fluid',
    density: 1.204,
    kinematicViscosity: 1.516e-5,
    speedOfSound: 343.2,
  },
};

export type SolverMode = 'interactive' | 'high_precision';

export type PresetModelId = 'sphere' | 'cube' | 'cylinder' | 'rocket_nose' | 'shed';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

export type VoxelVizMode = 'off' | 'slice_2d' | 'shell_3d';

export type SliceFieldMode = 'velocity' | 'vorticity' | 'cp';
export type SliceAxis = 'z' | 'y' | 'x';

export interface VoxelTelemetry {
  nx: number;
  ny: number;
  nz: number;
  solidCellCount: number;
  boundaryCellCount: number;
  fluidCellCount: number;
  voxelizationTimeMs: number;
}

export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export interface TunnelDimensions {
  length: number; // X axis (wind direction +X) in meters
  width: number;  // Z axis (spanwise) in meters
  height: number; // Y axis (vertical) in meters
}

export interface GridResolution {
  nx: number;
  ny: number;
  nz: number;
  totalCells: number;
  estimatedVramMB: number;
}

export interface GPUCapabilitiesReport {
  supported: boolean;
  adapterName: string;
  architecture: string;
  maxBufferSize: number;
  maxStorageBufferBindingSize: number;
  maxComputeWorkgroupSizeX: number;
  interactiveGrid: GridResolution;
  highPrecisionGrid: GridResolution;
  reasonIfUnsupported?: string;
}

export interface ModelTransform {
  position: Vector3D; // meters in tunnel space
  rotationDeg: Vector3D; // Euler XYZ in degrees
  scale: Vector3D; // Uniform or non-uniform scale factor
}

export interface MeshStats {
  name: string;
  triangleCount: number;
  vertexCount: number;
  isWatertight: boolean;
  openEdgeCount: number;
  boundingBoxSize: Vector3D; // meters (after transform)
  characteristicLength: number; // L_ref (streamwise length or hydraulic diameter) in meters
  frontalArea: number; // A_ref (projected area normal to +X wind) in m^2
  volume: number; // m^3
}

export interface WindTunnelState {
  windSpeed: number; // m/s (along +X)
  fluid: FluidPreset;
  solverMode: SolverMode;
  groundPlaneEnabled: boolean; // false = Freestream (rockets/drones), true = Ground-mounted (sheds/buildings/cars)
  tunnel: TunnelDimensions;
  transform: ModelTransform;
  activePreset: PresetModelId | 'uploaded_stl';
  gizmoMode: GizmoMode;
  voxelVizMode: VoxelVizMode;
  voxelSliceZ: number; // 0..1 fraction along Z width
  flowSliceEnabled: boolean;
  flowSliceField: SliceFieldMode;
  flowSliceAxis: SliceAxis;
  flowSlicePos: number; // 0..1 fraction
  solverPaused: boolean;
  // Phase 5: Advanced 3D Aerodynamic Visualizations
  surfaceHeatmapMode: 'off' | 'cp' | 'drag';
  vortexTubesEnabled: boolean;
  vortexThreshold: number; // 0.05 .. 1.0 fraction of peak Q
  streamlinesEnabled: boolean;
  streamlineRakeY: number; // -1 .. 1 offset
  streamlineRakeZ: number; // -1 .. 1 offset
  probeEnabled: boolean;
  // Phase 6: Domain Workflows, Rocket Stability & Export
  domainWorkflowMode: 'freestream' | 'ground_atmospheric';
  rocketStabilityEnabled: boolean;
  rocketXcgOffset: number; // meters from model origin along X (-1 .. +1)
}

export interface AerodynamicTelemetry {
  reynoldsNumber: number;
  machNumber: number;
  dynamicPressurePa: number; // q = 0.5 * rho * U^2
  frontalAreaM2: number;
  characteristicLengthM: number;
  blockageRatioPercent: number; // A_ref / (Tunnel Width * Height) * 100
  flowRegime: 'Laminar' | 'Transitional' | 'Turbulent (Subcritical)' | 'Turbulent (Supercritical)';
}
