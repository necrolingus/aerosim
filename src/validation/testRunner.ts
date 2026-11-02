import { createPresetGeometry } from '../geometry/presets';
import { computeMeshStats } from '../geometry/stlLoader';
import { voxelizeMeshToLattice } from '../geometry/voxelizer';
import { LBMCpuReferenceSolver } from '../solver/lbmCpuReference';
import { LBM_CONSTANTS } from '../solver/lbmConstants';
import {
  computeTrueMeshSurfaceArea,
  ForceConvergenceTracker,
  integrateLatticeMomentumExchange,
  type AerodynamicForceReadout,
} from '../solver/forceIntegrator';
import { FLUID_PRESETS, type PresetModelId, type TunnelDimensions } from '../core/types';
import {
  EMPIRICAL_BENCHMARK_CASES,
  getBenchmarkTargetForSimulatedRe,
  type EmpiricalBenchmarkCase,
} from './analyticalCases';

export interface BenchmarkTestResult {
  presetId: PresetModelId;
  benchmark: EmpiricalBenchmarkCase;
  computedCd: number;
  computedCl: number;
  effectiveTargetCd: number;
  toleranceMinCd: number;
  toleranceMaxCd: number;
  relativeErrorPercent: number;
  passed: boolean;
  stepsRun: number;
  elapsedMs: number;
  simulatedRe: number;
  cellsAcrossD: number;
}

/**
 * Runs a single automated wind-tunnel physics benchmark on a specified preset geometry
 * using the D3Q19 LBM + Smagorinsky LES + Bouzidi Interpolated Bounce-Back + Momentum Exchange pipeline.
 */
export function runSinglePhysicsBenchmark(
  presetId: PresetModelId,
  options: {
    grid?: { nx: number; ny: number; nz: number };
    steps?: number;
    tunnel?: TunnelDimensions;
    targetU?: number;
    nuLattice?: number;
  } = {}
): BenchmarkTestResult {
  const t0 = performance.now();
  const benchmark = EMPIRICAL_BENCHMARK_CASES[presetId];
  const geom = createPresetGeometry(presetId);

  // Low-blockage wind tunnel: H = 3.6m, W = 3.6m, L = 6.0m (Cross section = 12.96 m^2)
  const tunnel: TunnelDimensions = options.tunnel ?? { length: 6.0, width: 3.6, height: 3.6 };
  // Cubic lattice grid: ny = 36, nz = 36, nx = 60 => h = 3.6 / 36 = 0.10m
  const grid = options.grid ?? { nx: 60, ny: 36, nz: 36 };
  const totalSteps = options.steps ?? 320;

  const transform = {
    position: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };

  const stats = computeMeshStats(geom, benchmark.name, transform);
  const trueSurfaceAreaM2 = computeTrueMeshSurfaceArea(geom);
  const voxel = voxelizeMeshToLattice(geom, undefined, tunnel, grid);

  const targetU = options.targetU ?? 0.08;
  const nuLattice = options.nuLattice ?? 0.002;

  const cellsAcrossD = Number((stats.characteristicLength / voxel.dx).toFixed(1));
  const simulatedRe = Math.round((targetU * (stats.characteristicLength / voxel.dx)) / nuLattice);

  const solver = new LBMCpuReferenceSolver(voxel, {
    uInlet: 0.001, // Gentle startup to avoid acoustic impulse
    nuLattice,
    smagorinskyCs: LBM_CONSTANTS.DEFAULT_SMAGORINSKY_CS,
    groundNoSlip: presetId === 'shed',
  });

  const tracker = new ForceConvergenceTracker();
  tracker.reset(40);

  const rampSteps = 80;
  let latestReadout: AerodynamicForceReadout | null = null;

  for (let s = 1; s <= totalSteps; s++) {
    // Gentle sine-squared inlet velocity ramp
    if (s <= rampSteps) {
      const frac = s / rampSteps;
      solver.uInlet = targetU * Math.sin(0.5 * Math.PI * frac) * Math.sin(0.5 * Math.PI * frac);
    } else {
      solver.uInlet = targetU;
    }

    solver.step(1);

    // Sample forces after initial transient has decayed (steps > 160)
    if (s > Math.floor(totalSteps * 0.5)) {
      const forces = integrateLatticeMomentumExchange({
        voxel,
        fPreStream: solver.fDst,
        fPostBoundary: solver.fSrc,
        ux: solver.ux,
        uy: solver.uy,
        uz: solver.uz,
        rho: solver.rho,
        uInletLattice: targetU,
        nuLattice,
        trueSurfaceAreaM2,
        frontalAreaM2: stats.frontalArea,
        characteristicLengthM: stats.characteristicLength,
        boundingBoxSize: stats.boundingBoxSize,
        tunnel,
      });

      latestReadout = tracker.pushSample({
        step: solver.stepIndex,
        cd: forces.cdCorrected,
        cl: forces.cl,
        cm: forces.cmPitch,
        xcp: forces.centerOfPressureX,
        windSpeed: 25,
        fluid: FLUID_PRESETS.air_20c,
        frontalAreaM2: stats.frontalArea,
      });
    }
  }

  const targetInfo = getBenchmarkTargetForSimulatedRe(presetId, simulatedRe);
  const computedCd = latestReadout ? Number(latestReadout.meanCd.toFixed(3)) : 0;
  const computedCl = latestReadout ? Number(latestReadout.meanCl.toFixed(3)) : 0;
  const relativeErrorPercent = Number(
    ((Math.abs(computedCd - targetInfo.targetCd) / targetInfo.targetCd) * 100).toFixed(1)
  );
  const passed =
    computedCd >= targetInfo.toleranceMinCd && computedCd <= targetInfo.toleranceMaxCd;

  return {
    presetId,
    benchmark,
    computedCd,
    computedCl,
    effectiveTargetCd: targetInfo.targetCd,
    toleranceMinCd: targetInfo.toleranceMinCd,
    toleranceMaxCd: targetInfo.toleranceMaxCd,
    relativeErrorPercent,
    passed,
    stepsRun: totalSteps,
    elapsedMs: Number((performance.now() - t0).toFixed(1)),
    simulatedRe,
    cellsAcrossD,
  };
}

export interface BenchmarkProgressUpdate {
  currentModel: string;
  currentIndex: number;
  totalModels: number;
  percent: number;
}

/**
 * Runs the complete 4-model Gate 4 Physics Validation Suite asynchronously,
 * yielding control to the browser event loop between models so the UI remains
 * responsive, displays informative notices, and animates live progress bars.
 */
export async function runFullPhysicsValidationSuiteAsync(
  onProgress?: (progress: BenchmarkProgressUpdate) => void
): Promise<BenchmarkTestResult[]> {
  const models: PresetModelId[] = ['sphere', 'cylinder', 'cube', 'rocket_nose'];
  const results: BenchmarkTestResult[] = [];

  for (let i = 0; i < models.length; i++) {
    const id = models[i];
    const benchmark = EMPIRICAL_BENCHMARK_CASES[id];
    onProgress?.({
      currentModel: benchmark.name,
      currentIndex: i + 1,
      totalModels: models.length,
      percent: Math.round((i / models.length) * 100),
    });

    // Yield to event loop to allow DOM repaints and keep the browser completely responsive
    await new Promise((resolve) => setTimeout(resolve, 80));

    const result = runSinglePhysicsBenchmark(id);
    results.push(result);
  }

  onProgress?.({
    currentModel: 'Validation Complete',
    currentIndex: models.length,
    totalModels: models.length,
    percent: 100,
  });

  return results;
}

/**
 * Runs the complete 4-model Gate 4 Physics Validation Suite synchronously (for Node / Vitest CI test runners).
 */
export function runFullPhysicsValidationSuite(): BenchmarkTestResult[] {
  const models: PresetModelId[] = ['sphere', 'cylinder', 'cube', 'rocket_nose'];
  return models.map((id) => runSinglePhysicsBenchmark(id));
}
