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
import { computeTrueMeshSurfaceArea, type AerodynamicForceReadout } from './solver/forceIntegrator';
import { computeOptimalLatticeSpeed, LBM_CONSTANTS } from './solver/lbmConstants';
import { LBMEngine } from './solver/lbmEngine';
import { WindTunnelViewport } from './render/viewport';
import { PresetSelectorUI } from './ui/presetSelector';
import { ControlPanelUI } from './ui/controlPanel';
import { TelemetryHudUI } from './ui/telemetryHud';
import { ConvergenceChartUI } from './ui/convergenceChart';
import { runFullPhysicsValidationSuite } from './validation/testRunner';
import {
  computeABComparison,
  computeBuildingStormReport,
  computeRocketStability,
  exportRunReportToJSON,
  exportTelemetryToCSV,
  type BaselineSnapshot,
  type SimulationRunMetadata,
} from './solver/domainWorkflows';
import { captureViewportWithStamp, downloadFile } from './utils/exportUtils';

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
    domainWorkflowMode: 'freestream',
    rocketStabilityEnabled: false,
    rocketXcgOffset: 0.0,
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
  let latestForceReadout: AerodynamicForceReadout | null = null;
  let baselineSnapshot: BaselineSnapshot | null = null;

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

    const uLat = computeOptimalLatticeSpeed(state.windSpeed);

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

    hud.updateMeshAndTelemetry(
      currentMeshStats,
      aero,
      state.solverMode,
      voxelTel,
      state.groundPlaneEnabled
    );
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
    onSaveBaseline: () => {
      if (!latestForceReadout) return;
      const aero = computeAerodynamicTelemetry({
        windSpeed: state.windSpeed,
        characteristicLength: currentMeshStats.characteristicLength,
        frontalArea: currentMeshStats.frontalArea,
        fluid: state.fluid,
        tunnel: state.tunnel,
      });
      baselineSnapshot = {
        id: `run_a_${Date.now()}`,
        label: `Run A (${currentModelName})`,
        timestamp: new Date().toISOString(),
        specimenName: currentModelName,
        windSpeedMps: state.windSpeed,
        frontalAreaM2: currentMeshStats.frontalArea,
        reynolds: aero.reynoldsNumber,
        cd: latestForceReadout.meanCd,
        cl: latestForceReadout.meanCl,
        cm: latestForceReadout.pitchingMomentCm,
        dragForceN: latestForceReadout.dragForceNewtons,
        liftForceN: latestForceReadout.liftForceNewtons,
        centerOfPressureX: latestForceReadout.centerOfPressureX,
      };
      const delta = computeABComparison(baselineSnapshot, baselineSnapshot);
      controlPanel.setABComparison(delta);
    },
    onClearBaseline: () => {
      baselineSnapshot = null;
      controlPanel.setABComparison(null);
    },
    onExportCSV: () => {
      if (!latestForceReadout) return;
      const aero = computeAerodynamicTelemetry({
        windSpeed: state.windSpeed,
        characteristicLength: currentMeshStats.characteristicLength,
        frontalArea: currentMeshStats.frontalArea,
        fluid: state.fluid,
        tunnel: state.tunnel,
      });
      const csvContent = exportTelemetryToCSV(
        latestForceReadout.history.map((h) => ({
          step: h.step,
          timeSec: h.step * 0.001,
          cd: h.cd,
          cl: h.cl,
          cm: latestForceReadout!.pitchingMomentCm,
          dragForceN: latestForceReadout!.dragForceNewtons,
          liftForceN: latestForceReadout!.liftForceNewtons,
          xcpMeters: latestForceReadout!.centerOfPressureX,
        })),
        {
          specimenName: currentModelName,
          windSpeedMps: state.windSpeed,
          reynolds: aero.reynoldsNumber,
          meshStats: currentMeshStats,
          meanCd: latestForceReadout.meanCd,
          meanCl: latestForceReadout.meanCl,
          meanCm: latestForceReadout.pitchingMomentCm,
          centerOfPressureX: latestForceReadout.centerOfPressureX,
          dragForceN: latestForceReadout.dragForceNewtons,
          liftForceN: latestForceReadout.liftForceNewtons,
        }
      );
      const cleanName = currentModelName.toLowerCase().replace(/[^a-z0-9]/g, '_');
      downloadFile(`aerosim_${cleanName}_telemetry.csv`, csvContent, 'text/csv');
    },
    onExportJSON: () => {
      if (!latestForceReadout) return;
      const aero = computeAerodynamicTelemetry({
        windSpeed: state.windSpeed,
        characteristicLength: currentMeshStats.characteristicLength,
        frontalArea: currentMeshStats.frontalArea,
        fluid: state.fluid,
        tunnel: state.tunnel,
      });
      const metadata: SimulationRunMetadata = {
        timestamp: new Date().toISOString(),
        specimenName: currentModelName,
        presetId: state.activePreset,
        solverMode: state.solverMode,
        groundPlaneEnabled: state.groundPlaneEnabled,
        windSpeedMps: state.windSpeed,
        fluid: state.fluid,
        tunnel: state.tunnel,
        meshStats: currentMeshStats,
        meanCd: latestForceReadout.meanCd,
        meanCl: latestForceReadout.meanCl,
        meanCm: latestForceReadout.pitchingMomentCm,
        centerOfPressureX: latestForceReadout.centerOfPressureX,
        dragForceN: latestForceReadout.dragForceNewtons,
        liftForceN: latestForceReadout.liftForceNewtons,
        reynolds: aero.reynoldsNumber,
        dynamicPressurePa: aero.dynamicPressurePa,
        blockageRatioPercent: aero.blockageRatioPercent,
        totalSteps:
          latestForceReadout.history.length > 0
            ? latestForceReadout.history[latestForceReadout.history.length - 1].step
            : 0,
        isConverged: latestForceReadout.isConverged,
      };
      const jsonContent = exportRunReportToJSON(
        metadata,
        latestForceReadout.history.map((h) => ({
          step: h.step,
          timeSec: h.step * 0.001,
          cd: h.cd,
          cl: h.cl,
          cm: latestForceReadout!.pitchingMomentCm,
          dragForceN: latestForceReadout!.dragForceNewtons,
          liftForceN: latestForceReadout!.liftForceNewtons,
          xcpMeters: latestForceReadout!.centerOfPressureX,
        }))
      );
      const cleanName = currentModelName.toLowerCase().replace(/[^a-z0-9]/g, '_');
      downloadFile(`aerosim_${cleanName}_report.json`, jsonContent, 'application/json');
    },
    onSnapshotViewport: () => {
      if (!latestForceReadout) return;
      const aero = computeAerodynamicTelemetry({
        windSpeed: state.windSpeed,
        characteristicLength: currentMeshStats.characteristicLength,
        frontalArea: currentMeshStats.frontalArea,
        fluid: state.fluid,
        tunnel: state.tunnel,
      });
      captureViewportWithStamp(viewport.getCanvas(), {
        specimenName: currentModelName,
        windSpeedMps: state.windSpeed,
        reynoldsNumber: aero.reynoldsNumber,
        meanCd: latestForceReadout.meanCd,
        meanCl: latestForceReadout.meanCl,
        dragForceN: latestForceReadout.dragForceNewtons,
        liftForceN: latestForceReadout.liftForceNewtons,
        mode: state.solverMode === 'high_precision' ? 'High-Precision Mode' : 'Interactive Mode',
      })
        .then((blob) => {
          const cleanName = currentModelName.toLowerCase().replace(/[^a-z0-9]/g, '_');
          downloadFile(`aerosim_${cleanName}_snapshot.png`, blob, 'image/png');
        })
        .catch((err) => {
          console.error('Failed to create viewport snapshot:', err);
        });
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
          const uLat = computeOptimalLatticeSpeed(state.windSpeed);
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

        if (sliceOut.forceReadout) {
          latestForceReadout = sliceOut.forceReadout;
          const frc = sliceOut.forceReadout;
          const aero = computeAerodynamicTelemetry({
            windSpeed: state.windSpeed,
            characteristicLength: currentMeshStats.characteristicLength,
            frontalArea: currentMeshStats.frontalArea,
            fluid: state.fluid,
            tunnel: state.tunnel,
          });

          // 1. Rocket Aerodynamic Stability Analysis
          const xcgWorld = state.transform.position.x + state.rocketXcgOffset;
          const stabReport = computeRocketStability(
            frc.centerOfPressureX,
            xcgWorld,
            currentMeshStats.characteristicLength
          );
          controlPanel.setRocketStability(stabReport);
          viewport.updateRocketStabilityMarker({
            visible: state.rocketStabilityEnabled,
            xcp: stabReport.xcpMeters,
            xcg: stabReport.xcgMeters,
            diameter: currentMeshStats.characteristicLength,
          });

          // 2. Building Roof Suction & Storm Ratings
          const stormReport = computeBuildingStormReport(
            frc.liftForceNewtons,
            state.windSpeed,
            state.fluid.density
          );
          controlPanel.setBuildingStormReport(stormReport);

          // 3. A/B Comparison Live Update
          if (baselineSnapshot) {
            const liveSnapshot: BaselineSnapshot = {
              id: 'run_b_live',
              label: `Run B (${currentModelName})`,
              timestamp: new Date().toISOString(),
              specimenName: currentModelName,
              windSpeedMps: state.windSpeed,
              frontalAreaM2: currentMeshStats.frontalArea,
              reynolds: aero.reynoldsNumber,
              cd: frc.meanCd,
              cl: frc.meanCl,
              cm: frc.pitchingMomentCm,
              dragForceN: frc.dragForceNewtons,
              liftForceN: frc.liftForceNewtons,
              centerOfPressureX: frc.centerOfPressureX,
            };
            const delta = computeABComparison(baselineSnapshot, liveSnapshot);
            controlPanel.setABComparison(delta);
          }
        }
      }
    }
    requestAnimationFrame(tickSolverLoop);
  };
  requestAnimationFrame(tickSolverLoop);
}

bootstrapWindTunnelApp();
