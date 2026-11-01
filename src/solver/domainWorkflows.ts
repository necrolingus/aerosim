/**
 * Phase 6: Domain Workflows, Rocket Stability, Building Storm Uplift & Data Export
 * 
 * Provides pure mathematical algorithms, domain-specific calculators, and telemetry
 * export formatters for:
 * 1. Atmospheric Boundary Layer (ABL) logarithmic / power-law wind profile
 * 2. Rocket aerodynamic stability margin and Center of Pressure (X_cp) analysis
 * 3. Shed & Building storm wind uplift and roof suction force rating
 * 4. A/B Specimen comparison baseline and delta calculations
 * 5. Comprehensive CSV & JSON telemetry export formatting
 */

import type { FluidPreset, MeshStats, TunnelDimensions } from '../core/types';
import { LBM_CONSTANTS } from './lbmConstants';

const { NEWTONS_TO_KGF, NEWTONS_TO_LBF } = LBM_CONSTANTS;

export interface SimulationRunMetadata {
  timestamp: string;
  specimenName: string;
  presetId?: string;
  solverMode: 'interactive' | 'high_precision';
  groundPlaneEnabled: boolean;
  windSpeedMps: number;
  fluid: FluidPreset;
  tunnel: TunnelDimensions;
  meshStats: MeshStats;
  meanCd: number;
  meanCl: number;
  meanCm: number;
  centerOfPressureX: number;
  dragForceN: number;
  liftForceN: number;
  reynolds: number;
  dynamicPressurePa: number;
  blockageRatioPercent: number;
  totalSteps: number;
  isConverged: boolean;
}

export interface TelemetryHistorySample {
  step: number;
  timeSec: number;
  cd: number;
  cl: number;
  cm?: number;
  dragForceN?: number;
  liftForceN?: number;
  xcpMeters?: number;
}

export interface BaselineSnapshot {
  id: string;
  label: string;
  timestamp: string;
  specimenName: string;
  windSpeedMps: number;
  frontalAreaM2: number;
  reynolds: number;
  cd: number;
  cl: number;
  cm: number;
  dragForceN: number;
  liftForceN: number;
  centerOfPressureX: number;
}

export interface ABComparisonDelta {
  baseline: BaselineSnapshot;
  live: BaselineSnapshot;
  deltaCd: number;
  percentDeltaCd: number;
  deltaCl: number;
  deltaDragForceN: number;
  deltaLiftForceN: number;
  dragComparisonText: string;
  liftComparisonText: string;
  isDragReduced: boolean;
}

export type RocketStabilityRating =
  | 'Unstable (Tumbles in Flight)'
  | 'Marginally Stable (< 1.0 cal)'
  | 'Optimally Stable (1.0 - 2.5 cal)'
  | 'Over-Stable (> 2.5 cal, Weathercocks)';

export interface RocketStabilityReport {
  xcpMeters: number;
  xcgMeters: number;
  referenceDiameterMeters: number;
  staticMarginMeters: number;
  staticMarginCalibers: number;
  isStable: boolean;
  rating: RocketStabilityRating;
  explanation: string;
}

export interface StormUpliftRating {
  ratingName: string;
  stormWindMps: number;
  stormWindKmh: number;
  upliftForceN: number;
  upliftForceKgf: number;
  upliftForceLbf: number;
  dynamicPressurePa: number;
}

export interface BuildingStormReport {
  baseWindMps: number;
  baseUpliftN: number;
  baseDynamicPressurePa: number;
  ratings: StormUpliftRating[];
}

// ---------------------------------------------------------------------------
// 1. Atmospheric Boundary Layer (ABL) Profile
// ---------------------------------------------------------------------------

/**
 * Computes the normalized Atmospheric Boundary Layer (ABL) velocity factor
 * based on standard architectural power-law / logarithmic wind profiles (ASCE 7 / Eurocode 1).
 *
 * @param yFrac Normalized height coordinate y / tunnelHeight in [0, 1]
 * @param alpha Power-law exponent (default 0.28 for suburban / semi-urban terrain)
 * @returns Velocity scaling factor u(y) / u_ref
 */
export function computeABLLatticeFactor(yFrac: number, alpha = 0.28): number {
  if (yFrac <= 0.0) return 0.0;
  // Blend ground roughness transition: 0 at wall, smooth power profile above sub-layer
  const clampedFrac = Math.max(0.0, Math.min(1.0, yFrac));
  // Limit peak speed to 1.15 to prevent non-physical acoustic transients
  return Math.min(1.15, 0.35 + 0.80 * Math.pow(clampedFrac, alpha));
}

/**
 * Computes the physical wind speed u(y) at height y (in meters) under ABL conditions.
 *
 * @param yMeters Height from ground floor in meters (y >= 0)
 * @param tunnelHeightMeters Wind tunnel test section height in meters
 * @param uRefMps Freestream reference wind speed in m/s
 * @returns Local wind speed in m/s
 */
export function computeABLPhysicalVelocity(
  yMeters: number,
  tunnelHeightMeters: number,
  uRefMps: number
): number {
  if (yMeters <= 0.0 || tunnelHeightMeters <= 0.0) return 0.0;
  const yFrac = yMeters / tunnelHeightMeters;
  return uRefMps * computeABLLatticeFactor(yFrac);
}

// ---------------------------------------------------------------------------
// 2. Rocket Aerodynamic Stability & Center of Pressure
// ---------------------------------------------------------------------------

/**
 * Computes the static stability margin of a rocket or projectile based on
 * Center of Pressure (X_cp), Center of Gravity (X_cg), and reference caliber diameter.
 *
 * Coordinate Convention:
 * Streamwise axis along +X (wind blowing from nose to tail).
 * For a rocket pointing into the wind, downstream is +X.
 * Aerodynamic stability requires X_cp to be downstream of X_cg (X_cp > X_cg).
 *
 * @param xcpMeters Center of Pressure X coordinate (m)
 * @param xcgMeters Center of Gravity X coordinate (m)
 * @param referenceDiameterMeters Maximum outer diameter D_ref (m)
 */
export function computeRocketStability(
  xcpMeters: number,
  xcgMeters: number,
  referenceDiameterMeters: number
): RocketStabilityReport {
  const dRef = Math.max(1e-3, referenceDiameterMeters);
  const staticMarginMeters = xcpMeters - xcgMeters;
  const staticMarginCalibers = staticMarginMeters / dRef;

  let rating: RocketStabilityRating;
  let explanation: string;
  let isStable = false;

  if (staticMarginCalibers < 0.0) {
    rating = 'Unstable (Tumbles in Flight)';
    explanation = `Center of Pressure (${xcpMeters.toFixed(2)} m) is ahead of Center of Gravity (${xcgMeters.toFixed(2)} m). Any aerodynamic perturbation will amplify, causing violent tumbling.`;
    isStable = false;
  } else if (staticMarginCalibers < 1.0) {
    rating = 'Marginally Stable (< 1.0 cal)';
    explanation = `Stability margin is ${staticMarginCalibers.toFixed(2)} calibers (< 1.0). The rocket may fly straight in calm air but is susceptible to destabilization in gusts.`;
    isStable = true;
  } else if (staticMarginCalibers <= 2.5) {
    rating = 'Optimally Stable (1.0 - 2.5 cal)';
    explanation = `Stability margin is ${staticMarginCalibers.toFixed(2)} calibers. This is the optimal rocketry standard—providing robust flight path restoration without severe weathercocking.`;
    isStable = true;
  } else {
    rating = 'Over-Stable (> 2.5 cal, Weathercocks)';
    explanation = `Stability margin is ${staticMarginCalibers.toFixed(2)} calibers (> 2.5). While aerodynamically stable, the rocket will weathercock aggressively into crosswinds, bending the trajectory away from vertical.`;
    isStable = true;
  }

  return {
    xcpMeters,
    xcgMeters,
    referenceDiameterMeters: dRef,
    staticMarginMeters,
    staticMarginCalibers,
    isStable,
    rating,
    explanation,
  };
}

// ---------------------------------------------------------------------------
// 3. Shed & Building Storm Wind Uplift Calculator
// ---------------------------------------------------------------------------

export const STANDARD_STORM_CONDITIONS: ReadonlyArray<{ name: string; speedKmh: number }> = [
  { name: 'Moderate Gale (Force 7)', speedKmh: 55.0 },
  { name: 'Fresh Gale (Force 8)', speedKmh: 68.0 },
  { name: 'Strong Gale (Force 9)', speedKmh: 82.0 },
  { name: 'Whole Gale / Storm (Force 10)', speedKmh: 98.0 },
  { name: 'Violent Storm (Force 11)', speedKmh: 110.0 },
  { name: 'Hurricane Force (Category 1)', speedKmh: 125.0 },
];

/**
 * Projects measured aerodynamic roof suction / uplift forces onto standard severe storm wind speeds.
 * Uses exact dynamic pressure scaling: F_uplift(U) = F_uplift(U_base) * (U / U_base)^2.
 *
 * @param baseUpliftN Measured net aerodynamic vertical force F_l in Newtons (positive = uplift)
 * @param baseWindMps Operating wind speed in m/s during the simulation
 * @param airDensity Air density in kg/m^3 (default 1.204)
 */
export function computeBuildingStormReport(
  baseUpliftN: number,
  baseWindMps: number,
  airDensity = 1.204
): BuildingStormReport {
  const safeBaseWind = Math.max(0.1, baseWindMps);
  const baseQ = 0.5 * airDensity * safeBaseWind * safeBaseWind;

  const ratings: StormUpliftRating[] = STANDARD_STORM_CONDITIONS.map((storm) => {
    const stormWindMps = storm.speedKmh / 3.6;
    const dynamicPressurePa = 0.5 * airDensity * stormWindMps * stormWindMps;
    const speedRatio = stormWindMps / safeBaseWind;
    const upliftForceN = baseUpliftN * speedRatio * speedRatio;
    return {
      ratingName: storm.name,
      stormWindMps,
      stormWindKmh: storm.speedKmh,
      upliftForceN,
      upliftForceKgf: upliftForceN * NEWTONS_TO_KGF,
      upliftForceLbf: upliftForceN * NEWTONS_TO_LBF,
      dynamicPressurePa,
    };
  });

  return {
    baseWindMps,
    baseUpliftN,
    baseDynamicPressurePa: baseQ,
    ratings,
  };
}

// ---------------------------------------------------------------------------
// 4. A/B Comparison Baseline & Delta Engine
// ---------------------------------------------------------------------------

/**
 * Computes aerodynamic differences between Run A (frozen baseline) and Run B (live or candidate run).
 *
 * @param baseline Run A baseline snapshot
 * @param live Run B live or candidate snapshot
 */
export function computeABComparison(
  baseline: BaselineSnapshot,
  live: BaselineSnapshot
): ABComparisonDelta {
  const deltaCd = live.cd - baseline.cd;
  const safeBaseCd = Math.max(1e-4, Math.abs(baseline.cd));
  const percentDeltaCd = (deltaCd / safeBaseCd) * 100.0;

  const deltaCl = live.cl - baseline.cl;
  const deltaDragForceN = live.dragForceN - baseline.dragForceN;
  const deltaLiftForceN = live.liftForceN - baseline.liftForceN;

  const isDragReduced = deltaCd < 0;
  const dragComparisonText =
    Math.abs(percentDeltaCd) < 0.1
      ? 'No change in drag (0.0%)'
      : isDragReduced
      ? `${Math.abs(percentDeltaCd).toFixed(1)}% Drag Reduction (ΔCd ${deltaCd.toFixed(3)})`
      : `+${percentDeltaCd.toFixed(1)}% Drag Increase (ΔCd +${deltaCd.toFixed(3)})`;

  const liftSign = deltaLiftForceN >= 0 ? '+' : '';
  const liftComparisonText =
    Math.abs(deltaLiftForceN) < 0.1
      ? 'No change in lift'
      : `${liftSign}${deltaLiftForceN.toFixed(1)} N (${liftSign}${(deltaLiftForceN * NEWTONS_TO_LBF).toFixed(1)} lbf)`;

  return {
    baseline,
    live,
    deltaCd,
    percentDeltaCd,
    deltaCl,
    deltaDragForceN,
    deltaLiftForceN,
    dragComparisonText,
    liftComparisonText,
    isDragReduced,
  };
}

// ---------------------------------------------------------------------------
// 5. CSV & JSON Telemetry Exporters
// ---------------------------------------------------------------------------

/**
 * Formats full time-series simulation history into standard RFC 4180 CSV format.
 */
export function exportTelemetryToCSV(
  history: ReadonlyArray<TelemetryHistorySample>,
  metadata: Partial<SimulationRunMetadata>
): string {
  const lines: string[] = [];

  // Header metadata block as comments
  lines.push(`# AeroSim Aerodynamic Wind Tunnel Telemetry Export`);
  lines.push(`# Generated: ${metadata.timestamp ?? new Date().toISOString()}`);
  lines.push(`# Specimen: ${metadata.specimenName ?? 'Specimen'}`);
  lines.push(`# Wind Speed: ${metadata.windSpeedMps?.toFixed(1) ?? '0.0'} m/s`);
  lines.push(`# Reynolds Number: ${metadata.reynolds?.toFixed(0) ?? '0'}`);
  lines.push(`# Frontal Area: ${metadata.meshStats?.frontalArea.toFixed(4) ?? '0'} m2`);
  lines.push(`# Mean Cd: ${metadata.meanCd?.toFixed(4) ?? '0'}`);
  lines.push(`# Mean Cl: ${metadata.meanCl?.toFixed(4) ?? '0'}`);
  lines.push(`# Pitching Moment Cm: ${metadata.meanCm?.toFixed(4) ?? '0'}`);
  lines.push(`# Center of Pressure X: ${metadata.centerOfPressureX?.toFixed(3) ?? '0'} m`);
  lines.push(``);

  // Column headers
  lines.push(
    `step,time_sec,cd,cl,cm,drag_force_n,drag_force_lbf,drag_force_kgf,lift_force_n,lift_force_lbf,xcp_meters`
  );

  for (const sample of history) {
    const step = sample.step;
    const timeSec = sample.timeSec.toFixed(4);
    const cd = sample.cd.toFixed(5);
    const cl = sample.cl.toFixed(5);
    const cm = (sample.cm ?? metadata.meanCm ?? 0.0).toFixed(5);
    const dragN = (sample.dragForceN ?? metadata.dragForceN ?? 0.0).toFixed(2);
    const dragLbf = ((sample.dragForceN ?? metadata.dragForceN ?? 0.0) * NEWTONS_TO_LBF).toFixed(2);
    const dragKgf = ((sample.dragForceN ?? metadata.dragForceN ?? 0.0) * NEWTONS_TO_KGF).toFixed(2);
    const liftN = (sample.liftForceN ?? metadata.liftForceN ?? 0.0).toFixed(2);
    const liftLbf = ((sample.liftForceN ?? metadata.liftForceN ?? 0.0) * NEWTONS_TO_LBF).toFixed(2);
    const xcp = (sample.xcpMeters ?? metadata.centerOfPressureX ?? 0.0).toFixed(3);

    lines.push(
      `${step},${timeSec},${cd},${cl},${cm},${dragN},${dragLbf},${dragKgf},${liftN},${liftLbf},${xcp}`
    );
  }

  return lines.join('\r\n');
}

/**
 * Formats full simulation state, metadata, and history into structured JSON.
 */
export function exportRunReportToJSON(
  metadata: SimulationRunMetadata,
  history: ReadonlyArray<TelemetryHistorySample>
): string {
  const payload = {
    application: 'AeroSim — 3D WebGPU Wind Tunnel Platform',
    version: '0.1.0',
    exportTimestamp: new Date().toISOString(),
    simulationRun: {
      ...metadata,
      units: {
        windSpeed: 'm/s',
        forces: 'Newtons',
        pressure: 'Pascals',
        lengths: 'meters',
        areas: 'square_meters',
      },
      telemetryHistory: history.map((s) => ({
        step: s.step,
        timeSec: Number(s.timeSec.toFixed(4)),
        cd: Number(s.cd.toFixed(5)),
        cl: Number(s.cl.toFixed(5)),
        cm: s.cm !== undefined ? Number(s.cm.toFixed(5)) : undefined,
        dragForceN: s.dragForceN !== undefined ? Number(s.dragForceN.toFixed(2)) : undefined,
        liftForceN: s.liftForceN !== undefined ? Number(s.liftForceN.toFixed(2)) : undefined,
        xcpMeters: s.xcpMeters !== undefined ? Number(s.xcpMeters.toFixed(3)) : undefined,
      })),
    },
  };

  return JSON.stringify(payload, null, 2);
}
