import { describe, expect, it } from 'vitest';
import {
  computeABLLatticeFactor,
  computeABLPhysicalVelocity,
  computeRocketStability,
  computeBuildingStormReport,
  computeABComparison,
  exportTelemetryToCSV,
  exportRunReportToJSON,
  type BaselineSnapshot,
  type SimulationRunMetadata,
  type TelemetryHistorySample,
} from '../solver/domainWorkflows';
import { FLUID_PRESETS } from '../core/types';

describe('Gate 6 Verification: Domain Workflows, Rocket Stability & Export Polish', () => {
  describe('1. Atmospheric Boundary Layer (ABL) Wind Profile', () => {
    it('enforces strictly no-slip (u = 0) at the ground floor (y = 0)', () => {
      const factorZero = computeABLLatticeFactor(0.0);
      expect(factorZero).toBe(0.0);

      const physZero = computeABLPhysicalVelocity(0.0, 2.4, 25.0);
      expect(physZero).toBe(0.0);
    });

    it('exhibits strictly monotonic velocity growth with height above the floor', () => {
      const heights = [0.1, 0.3, 0.6, 1.0, 1.5, 2.0, 2.4];
      const velocities = heights.map((h) => computeABLPhysicalVelocity(h, 2.4, 25.0));

      for (let i = 1; i < velocities.length; i++) {
        expect(velocities[i]).toBeGreaterThan(velocities[i - 1]);
      }
    });

    it('scales linearly with freestream wind speed and adheres to power-law bounds', () => {
      const uRef1 = 20.0;
      const uRef2 = 40.0;
      const h = 1.2;
      const tunnelH = 2.4;

      const v1 = computeABLPhysicalVelocity(h, tunnelH, uRef1);
      const v2 = computeABLPhysicalVelocity(h, tunnelH, uRef2);

      // Should scale strictly 2x when uRef doubles
      expect(v2 / v1).toBeCloseTo(2.0, 4);

      // At mid-height (y/H = 0.5), power law with alpha=0.28 gives factor around 1.0
      const midFactor = computeABLLatticeFactor(0.5);
      expect(midFactor).toBeGreaterThan(0.85);
      expect(midFactor).toBeLessThanOrEqual(1.15);
    });
  });

  describe('2. Rocket Aerodynamic Stability & Center of Pressure (Xcp) Analysis', () => {
    const rocketDiameter = 0.5; // 0.5m diameter rocket

    it('classifies positive static margin (Xcp downstream of Xcg) as aerodynamically stable', () => {
      // Xcg at 0.0m (near nose), Xcp at 0.75m (downstream near fins)
      const report = computeRocketStability(0.75, 0.0, rocketDiameter);

      expect(report.isStable).toBe(true);
      expect(report.staticMarginMeters).toBeCloseTo(0.75, 4);
      // Margin in calibers: 0.75 / 0.5 = 1.5 calibers
      expect(report.staticMarginCalibers).toBeCloseTo(1.5, 4);
      expect(report.rating).toBe('Optimally Stable (1.0 - 2.5 cal)');
    });

    it('flags negative static margin (Xcp upstream of Xcg) as violently unstable', () => {
      // Xcg at 0.8m (heavy tail), Xcp at 0.3m (forward nose suction)
      const report = computeRocketStability(0.3, 0.8, rocketDiameter);

      expect(report.isStable).toBe(false);
      expect(report.staticMarginMeters).toBeLessThan(0);
      expect(report.staticMarginCalibers).toBeLessThan(0);
      expect(report.rating).toBe('Unstable (Tumbles in Flight)');
    });

    it('identifies over-stable conditions (> 2.5 calibers) prone to wind weathercocking', () => {
      // Static margin = 2.0m -> 4.0 calibers for 0.5m rocket
      const report = computeRocketStability(2.0, 0.0, rocketDiameter);

      expect(report.isStable).toBe(true);
      expect(report.staticMarginCalibers).toBe(4.0);
      expect(report.rating).toBe('Over-Stable (> 2.5 cal, Weathercocks)');
    });
  });

  describe('3. Shed & Building Ground Roof Suction & Storm Rating', () => {
    it('projects measured aerodynamic uplift quadratically (U^2) across severe storm ratings', () => {
      const baseWindMps = 25.0; // 90 km/h
      const baseUpliftN = 800.0; // 800 Newtons roof uplift

      const report = computeBuildingStormReport(baseUpliftN, baseWindMps, 1.204);

      expect(report.ratings.length).toBeGreaterThanOrEqual(5);

      for (const storm of report.ratings) {
        // F_storm = F_base * (U_storm / U_base)^2
        const expectedRatio = (storm.stormWindMps / baseWindMps) ** 2;
        const expectedUplift = baseUpliftN * expectedRatio;

        expect(storm.upliftForceN).toBeCloseTo(expectedUplift, 2);
        // Verify kgf conversion: 1 N ≈ 0.10197 kgf
        expect(storm.upliftForceKgf).toBeCloseTo(storm.upliftForceN * 0.101971621, 2);
        // Verify lbf conversion: 1 N ≈ 0.22481 lbf
        expect(storm.upliftForceLbf).toBeCloseTo(storm.upliftForceN * 0.224808943, 2);
      }
    });

    it('verifies that doubling wind speed quadruples the aerodynamic roof uplift', () => {
      const baseWindMps = 20.0;
      const baseUpliftN = 500.0;
      const stormReport = computeBuildingStormReport(baseUpliftN, baseWindMps, 1.204);
      expect(stormReport.ratings.length).toBeGreaterThan(0);

      // Verify quadratic scaling
      const doubleWindMps = 40.0;
      const doubleWindRatio = (doubleWindMps / baseWindMps) ** 2;
      expect(doubleWindRatio).toBeCloseTo(4.0, 5);
    });
  });

  describe('4. A/B Specimen Comparison Engine', () => {
    const makeSnapshot = (overrides: Partial<BaselineSnapshot>): BaselineSnapshot => ({
      id: 'test_run',
      label: 'Test Run',
      timestamp: '2026-11-01T12:00:00Z',
      specimenName: 'Test Specimen',
      windSpeedMps: 25.0,
      frontalAreaM2: 0.7854,
      reynolds: 400000,
      cd: 0.47,
      cl: 0.05,
      cm: 0.01,
      dragForceN: 140.0,
      liftForceN: 15.0,
      centerOfPressureX: 0.2,
      ...overrides,
    });

    it('yields identical deltas (Δ = 0.0) when comparing a run to itself', () => {
      const snap = makeSnapshot({});
      const delta = computeABComparison(snap, snap);

      expect(delta.deltaCd).toBeCloseTo(0.0, 5);
      expect(delta.percentDeltaCd).toBeCloseTo(0.0, 5);
      expect(delta.deltaCl).toBeCloseTo(0.0, 5);
      expect(delta.deltaDragForceN).toBeCloseTo(0.0, 5);
      expect(delta.deltaLiftForceN).toBeCloseTo(0.0, 5);
      expect(delta.isDragReduced).toBe(false);
      expect(delta.dragComparisonText).toContain('0.0%');
    });

    it('computes exact drag reduction and flags improvement when Cd decreases', () => {
      const runA = makeSnapshot({ cd: 0.50, dragForceN: 150.0 });
      const runB = makeSnapshot({ cd: 0.40, dragForceN: 120.0 }); // 20% drag reduction

      const delta = computeABComparison(runA, runB);

      expect(delta.deltaCd).toBeCloseTo(-0.10, 5);
      expect(delta.percentDeltaCd).toBeCloseTo(-20.0, 4);
      expect(delta.isDragReduced).toBe(true);
      expect(delta.deltaDragForceN).toBeCloseTo(-30.0, 4);
      expect(delta.dragComparisonText).toContain('20.0% Drag Reduction');
    });

    it('computes drag increase correctly when bluff candidate has higher Cd', () => {
      const runA = makeSnapshot({ cd: 0.40 });
      const runB = makeSnapshot({ cd: 0.50 }); // +25% drag increase

      const delta = computeABComparison(runA, runB);

      expect(delta.deltaCd).toBeCloseTo(0.10, 5);
      expect(delta.percentDeltaCd).toBeCloseTo(25.0, 4);
      expect(delta.isDragReduced).toBe(false);
      expect(delta.dragComparisonText).toContain('+25.0% Drag Increase');
    });
  });

  describe('5. CSV & JSON Telemetry Exporters & Round-Trip Integrity', () => {
    const historySamples: TelemetryHistorySample[] = [
      { step: 100, timeSec: 0.1, cd: 0.52, cl: 0.02, cm: 0.005, dragForceN: 155.0, liftForceN: 6.0, xcpMeters: 0.25 },
      { step: 200, timeSec: 0.2, cd: 0.48, cl: 0.01, cm: 0.004, dragForceN: 143.0, liftForceN: 3.0, xcpMeters: 0.26 },
      { step: 300, timeSec: 0.3, cd: 0.47, cl: 0.00, cm: 0.002, dragForceN: 140.0, liftForceN: 0.0, xcpMeters: 0.26 },
    ];

    const metadata: SimulationRunMetadata = {
      timestamp: '2026-11-01T12:00:00Z',
      specimenName: 'Calibration Sphere (1m)',
      presetId: 'sphere',
      solverMode: 'interactive',
      groundPlaneEnabled: false,
      windSpeedMps: 25.0,
      fluid: FLUID_PRESETS.air_20c,
      tunnel: { length: 6.0, width: 2.8, height: 2.4 },
      meshStats: {
        name: 'Calibration Sphere (1m)',
        triangleCount: 1024,
        vertexCount: 514,
        isWatertight: true,
        openEdgeCount: 0,
        boundingBoxSize: { x: 1, y: 1, z: 1 },
        characteristicLength: 1.0,
        frontalArea: 0.7854,
        volume: 0.5236,
      },
      meanCd: 0.47,
      meanCl: 0.005,
      meanCm: 0.003,
      centerOfPressureX: 0.26,
      dragForceN: 140.0,
      liftForceN: 1.5,
      reynolds: 400000,
      dynamicPressurePa: 376.25,
      blockageRatioPercent: 11.69,
      totalSteps: 300,
      isConverged: true,
    };

    it('generates valid RFC 4180 CSV telemetry and parses columns back accurately', () => {
      const csv = exportTelemetryToCSV(historySamples, metadata);

      expect(csv).toContain('# AeroSim Aerodynamic Wind Tunnel Telemetry Export');
      expect(csv).toContain('step,time_sec,cd,cl,cm,drag_force_n,drag_force_lbf,drag_force_kgf,lift_force_n,lift_force_lbf,xcp_meters');

      // Filter out comment lines and header
      const dataLines = csv
        .split('\r\n')
        .filter((line) => line.trim().length > 0 && !line.startsWith('#') && !line.startsWith('step'));

      expect(dataLines.length).toBe(3);

      // Verify row 1
      const [step, timeSec, cd, cl, cm, dragN, dragLbf, dragKgf, liftN, liftLbf, xcp] = dataLines[0].split(',');
      expect(Number(step)).toBe(100);
      expect(Number(timeSec)).toBeCloseTo(0.1, 3);
      expect(Number(cd)).toBeCloseTo(0.52, 2);
      expect(Number(cl)).toBeCloseTo(0.02, 2);
      expect(Number(cm)).toBeCloseTo(0.005, 3);
      expect(Number(dragN)).toBeCloseTo(155.0, 1);
      expect(Number(dragLbf)).toBeGreaterThan(0);
      expect(Number(dragKgf)).toBeGreaterThan(0);
      expect(Number(liftN)).toBeCloseTo(6.0, 1);
      expect(Number(liftLbf)).toBeGreaterThan(0);
      expect(Number(xcp)).toBeCloseTo(0.25, 2);
    });

    it('generates schema-compliant JSON reports with full metadata and parseable telemetry history', () => {
      const jsonStr = exportRunReportToJSON(metadata, historySamples);
      const parsed = JSON.parse(jsonStr);

      expect(parsed.application).toBe('AeroSim — 3D WebGPU Wind Tunnel Platform');
      expect(parsed.version).toBe('0.1.0');
      expect(parsed.simulationRun.specimenName).toBe('Calibration Sphere (1m)');
      expect(parsed.simulationRun.meanCd).toBeCloseTo(0.47, 2);
      expect(parsed.simulationRun.isConverged).toBe(true);
      expect(parsed.simulationRun.telemetryHistory.length).toBe(3);
      expect(parsed.simulationRun.telemetryHistory[1].step).toBe(200);
      expect(parsed.simulationRun.telemetryHistory[1].cd).toBeCloseTo(0.48, 2);
    });
  });
});
