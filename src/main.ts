import './style.css';
import {
  FLUID_PRESETS,
  type MeshStats,
  type PresetModelId,
  type VoxelTelemetry,
  type WindTunnelState,
} from './core/types';
import { gpuContext } from './core/gpuContext';
import { eventBus } from './core/eventBus';
import { createPresetGeometry, PRESET_MODELS } from './geometry/presets';
import { computeMeshStats, normalizeAndCenterGeometry, parseSTL } from './geometry/stlLoader';
import { voxelizeMeshToLattice, type VoxelGridResult } from './geometry/voxelizer';
import { computeAerodynamicTelemetry } from './solver/fluidProperties';
import { computeTrueMeshSurfaceArea } from './solver/forceIntegrator';
import { LBM_CONSTANTS } from './solver/lbmConstants';
import { LBMEngine } from './solver/lbmEngine';
import { WindTunnelViewport } from './render/viewport';
import { PresetSelectorUI } from './ui/presetSelector';
import { ControlPanelUI } from './ui/controlPanel';
import { TelemetryHudUI } from './ui/telemetryHud';
import { ConvergenceChartUI } from './ui/convergenceChart';
import { runFullPhysicsValidationSuite } from './validation/testRunner';

async function bootstrapWindTunnelApp(): Promise<void> {
  const state: WindTunnelState = {
    windSpeed: 25.0, // 25 m/s (90 km/h)
    fluid: { ...FLUID_PRESETS.air_20c },
    solverMode: 'interactive',
    groundPlaneEnabled: false,
    tunnel: {
      length: 6.0,
      width: 2.8,
      height: 2.4,
    },
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    activePreset: 'sphere',
    gizmoMode: 'rotate',
    voxelVizMode: 'off',
    voxelSliceZ: 0.5,
    flowSliceEnabled: true,
    flowSliceField: 'vorticity',
    flowSliceAxis: 'z',
    flowSlicePos: 0.5,
    solverPaused: false,
    surfaceHeatmapMode: 'off',
    vortexTubesEnabled: false,
    vortexThreshold: 0.2,
    streamlinesEnabled: false,
    streamlineRakeY: 0,
    streamlineRakeZ: 0,
    probeEnabled: false,
  };

  // Mount DOM containers
  const presetMount = document.getElementById('preset-selector-mount')!;
  const controlMount = document.getElementById('control-panel-mount')!;
  const hudMount = document.getElementById('telemetry-hud')!;
  const viewportMount = document.getElementById('viewport-canvas-container')!;
  const convChartMount = document.getElementById('convergence-chart-mount')!;

  const hud = new TelemetryHudUI(hudMount);
  const viewport = new WindTunnelViewport(viewportMount, state);
  const convergenceChart = new ConvergenceChartUI(convChartMount, {
    onRunBenchmarks: () => {
      const results = runFullPhysicsValidationSuite();
      convergenceChart.showBenchmarkResults(results);
    },
  });

  // Initialize WebGPU capability check first so interactive grid resolution & GPUDevice are ready
  const gpuReport = await gpuContext.initialize(state.tunnel);
  hud.updateGPU(gpuReport);
  eventBus.emit('gpu:initialized', gpuReport);

  const lbmEngine = new LBMEngine(gpuContext.getDevice());

  let currentGeometry = createPresetGeometry('sphere');
  let currentModelName = PRESET_MODELS.sphere.name;
  let currentMeshStats: MeshStats = computeMeshStats(currentGeometry, currentModelName, state.transform);
  let latestVoxelResult: VoxelGridResult | null = null;

  const computeLatticeViscosity = (reynolds: number, charLenM: number, dx: number, uLat: number) => {
    const lLat = Math.max(2.0, charLenM / dx);
    const safeRe = Math.max(50, reynolds);
    // nu_lat = U_lat * L_lat / Re (with Smagorinsky LES handling sub-grid scales at high Re)
    return Math.max(1e-6, Math.min(0.05, (uLat * lLat) / safeRe));
  };

  const runVoxelizerAndRefresh = (recomputeVoxels = true, resetFlow = false) => {
    currentMeshStats = computeMeshStats(currentGeometry, currentModelName, state.transform);
    const trueSurfaceAreaM2 = computeTrueMeshSurfaceArea(
      currentGeometry,
      viewport.getActiveWorldMatrix()
    );
    const aero = computeAerodynamicTelemetry({
      windSpeed: state.windSpeed,
      characteristicLength: currentMeshStats.characteristicLength,
      frontalArea: currentMeshStats.frontalArea,
      fluid: state.fluid,
      tunnel: state.tunnel,
    });

    const uLat = Math.min(0.11, Math.max(0.04, 0.06 + (state.windSpeed / 120) * 0.045));

    if (recomputeVoxels || !latestVoxelResult) {
      const report = gpuContext.getReport();
      const activeGridRes =
        state.solverMode === 'high_precision'
          ? report?.highPrecisionGrid
          : report?.interactiveGrid;

      const targetGrid = activeGridRes
        ? { nx: activeGridRes.nx, ny: activeGridRes.ny, nz: activeGridRes.nz }
        : { nx: 72, ny: 32, nz: 32 };

      latestVoxelResult = voxelizeMeshToLattice(
        currentGeometry,
        viewport.getActiveWorldMatrix(),
        state.tunnel,
        targetGrid
      );

      const nuLat = computeLatticeViscosity(
        aero.reynoldsNumber,
        currentMeshStats.characteristicLength,
        latestVoxelResult.dx,
        uLat
      );

      lbmEngine.setVoxelGrid(
        latestVoxelResult,
        {
          uInletLattice: uLat,
          nuLattice: nuLat,
          smagorinskyCs: LBM_CONSTANTS.DEFAULT_SMAGORINSKY_CS,
          groundNoSlip: state.groundPlaneEnabled,
          sliceAxis: state.flowSliceAxis,
          sliceFraction: state.flowSlicePos,
          fieldMode: state.flowSliceField,
          windSpeedMps: state.windSpeed,
          fluid: state.fluid,
          trueSurfaceAreaM2,
          frontalAreaM2: currentMeshStats.frontalArea,
          characteristicLengthM: currentMeshStats.characteristicLength,
          boundingBoxSize: currentMeshStats.boundingBoxSize,
          tunnel: state.tunnel,
        },
        resetFlow
      );
    } else {
      const nuLat = computeLatticeViscosity(
        aero.reynoldsNumber,
        currentMeshStats.characteristicLength,
        latestVoxelResult.dx,
        uLat
      );
      lbmEngine.updateConfig({
        uInletLattice: uLat,
        nuLattice: nuLat,
        groundNoSlip: state.groundPlaneEnabled,
        sliceAxis: state.flowSliceAxis,
        sliceFraction: state.flowSlicePos,
        fieldMode: state.flowSliceField,
        windSpeedMps: state.windSpeed,
        fluid: state.fluid,
        trueSurfaceAreaM2,
        frontalAreaM2: currentMeshStats.frontalArea,
        characteristicLengthM: currentMeshStats.characteristicLength,
        boundingBoxSize: currentMeshStats.boundingBoxSize,
        tunnel: state.tunnel,
      });
    }

    viewport.updateVoxelVisualization(latestVoxelResult, state.voxelVizMode, state.voxelSliceZ);
    viewport.updateFlowSlicePose(
      state.tunnel,
      state.flowSliceAxis,
      state.flowSlicePos,
      state.flowSliceEnabled
    );

    const voxelTel: VoxelTelemetry = {
      nx: latestVoxelResult.nx,
      ny: latestVoxelResult.ny,
      nz: latestVoxelResult.nz,
      solidCellCount: latestVoxelResult.solidCellCount,
      boundaryCellCount: latestVoxelResult.boundaryCellCount,
      fluidCellCount: latestVoxelResult.fluidCellCount,
      voxelizationTimeMs: latestVoxelResult.voxelizationTimeMs,
    };

    hud.updateMeshAndTelemetry(currentMeshStats, aero, state.solverMode, voxelTel);
    eventBus.emit('telemetry:updated', aero);
  };

  const controlPanel = new ControlPanelUI(controlMount, state, {
    onStateChange: (newState) => {
      const tunnelChanged =
        newState.tunnel.length !== state.tunnel.length ||
        newState.tunnel.width !== state.tunnel.width ||
        newState.tunnel.height !== state.tunnel.height ||
        newState.groundPlaneEnabled !== state.groundPlaneEnabled;

      const transformChanged =
        JSON.stringify(newState.transform) !== JSON.stringify(state.transform) ||
        newState.solverMode !== state.solverMode;

      Object.assign(state, newState);

      if (tunnelChanged) {
        viewport.rebuildTunnelEnclosure(state.tunnel, state.groundPlaneEnabled);
        gpuContext.recalculateGrids(state.tunnel);
        const report = gpuContext.getReport();
        if (report) hud.updateGPU(report);
      }

      viewport.setWindSpeed(state.windSpeed);
      viewport.applyTransformToMesh(state.transform);
      state.transform = viewport.getCurrentTransform();
      viewport.setSurfaceHeatmapMode(state.surfaceHeatmapMode);
      viewport.setVortexTubes(state.vortexTubesEnabled, state.vortexThreshold);
      viewport.setStreamlines(state.streamlinesEnabled, state.streamlineRakeY, state.streamlineRakeZ);
      viewport.setPointProbe(state.probeEnabled);
      runVoxelizerAndRefresh(tunnelChanged || transformChanged, false);
    },
    onResetFlow: () => {
      lbmEngine.resetFlow();
    },
  });

  const presetSelector = new PresetSelectorUI(presetMount, {
    onSelectPreset: (presetId: PresetModelId) => {
      state.activePreset = presetId;
      const meta = PRESET_MODELS[presetId];
      currentModelName = meta.name;
      currentGeometry = createPresetGeometry(presetId);

      state.transform = {
        position: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      };

      if (state.groundPlaneEnabled !== meta.defaultGroundPlane) {
        state.groundPlaneEnabled = meta.defaultGroundPlane;
        controlPanel.syncGroundPlaneToggle(state.groundPlaneEnabled);
        viewport.rebuildTunnelEnclosure(state.tunnel, state.groundPlaneEnabled);
      }

      viewport.setModelGeometry(currentGeometry, state.transform);
      state.transform = viewport.getCurrentTransform();
      controlPanel.syncTransformInputs(state.transform);
      runVoxelizerAndRefresh(true, true);
    },

    onUploadSTL: async (file: File) => {
      try {
        const buffer = await file.arrayBuffer();
        const rawGeom = parseSTL(buffer);
        const { geometry, autoScaledFromMm } = normalizeAndCenterGeometry(rawGeom);

        state.activePreset = 'uploaded_stl';
        currentGeometry = geometry;
        currentModelName = autoScaledFromMm ? `${file.name} (mm→m)` : file.name;

        state.transform = {
          position: { x: 0, y: 0, z: 0 },
          rotationDeg: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        };

        viewport.setModelGeometry(currentGeometry, state.transform);
        state.transform = viewport.getCurrentTransform();
        controlPanel.syncTransformInputs(state.transform);
        runVoxelizerAndRefresh(true, true);
      } catch (err) {
        alert(`Failed to load STL file: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  // Listen to interactive 3D gizmo drags from the viewport
  viewport.setOnTransformChange((newTransform) => {
    state.transform = newTransform;
    controlPanel.syncTransformInputs(newTransform);
    runVoxelizerAndRefresh(true, false);
  });

  // Keyboard shortcuts for gizmo modes (W = translate, E = rotate, R = scale)
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key.toLowerCase() === 'w') {
      eventBus.emit('gizmo:mode', 'translate');
    } else if (e.key.toLowerCase() === 'e') {
      eventBus.emit('gizmo:mode', 'rotate');
    } else if (e.key.toLowerCase() === 'r') {
      eventBus.emit('gizmo:mode', 'scale');
    }
  });

  // Load initial Calibration Sphere specimen & voxelize
  presetSelector.setActive('sphere');
  viewport.setModelGeometry(currentGeometry, state.transform);
  runVoxelizerAndRefresh(true, true);

  // Start real-time 60 FPS WebGPU LBM simulation & slice update loop
  const substepsPerFrame = gpuContext.getDevice() ? 4 : 1;
  const tickSolverLoop = async () => {
    if (!state.solverPaused && latestVoxelResult) {
      const t0 = performance.now();
      const needMacro =
        state.surfaceHeatmapMode !== 'off' ||
        state.vortexTubesEnabled ||
        state.streamlinesEnabled ||
        state.probeEnabled;

      const sliceOut = await lbmEngine.stepAndExtractSlice(substepsPerFrame, needMacro);
      const dtSec = Math.max(1e-4, (performance.now() - t0) / 1000);
      if (sliceOut) {
        viewport.updateFlowSlicePixels(sliceOut.width, sliceOut.height, sliceOut.rgba);
        if (sliceOut.macroField) {
          const uLat = Math.min(0.11, Math.max(0.04, 0.06 + (state.windSpeed / 120) * 0.045));
          viewport.updateMacroVisualizations({
            voxel: latestVoxelResult,
            ux: sliceOut.macroField.ux,
            uy: sliceOut.macroField.uy,
            uz: sliceOut.macroField.uz,
            rho: sliceOut.macroField.rho,
            uInletLattice: uLat,
            windSpeedMps: state.windSpeed,
            fluid: state.fluid,
            rakeY: state.streamlineRakeY,
            rakeZ: state.streamlineRakeZ,
          });
        }
        const totalCells = latestVoxelResult.nx * latestVoxelResult.ny * latestVoxelResult.nz;
        const mlups = (totalCells * substepsPerFrame) / (dtSec * 1e6);
        hud.updateSolverSteps(sliceOut.stepCount, mlups, sliceOut.forceReadout);
        convergenceChart.updatePlot(sliceOut.forceReadout);
      }
    }
    requestAnimationFrame(tickSolverLoop);
  };
  requestAnimationFrame(tickSolverLoop);
}

bootstrapWindTunnelApp();
