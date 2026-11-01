import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createPresetGeometry } from '../geometry/presets';
import { computeProjectedFrontalArea } from '../geometry/frontalArea';
import { computeMeshStats, parseSTL } from '../geometry/stlLoader';
import { computeAerodynamicTelemetry, forceToCoefficient } from '../solver/fluidProperties';
import { FLUID_PRESETS } from '../core/types';
import { calculateSafeGridResolution } from '../core/gpuContext';

describe('Gate 1 Verification: Geometry, Frontal Area (A_ref), STL Parser & Fluid Physics', () => {
  it('computes projected frontal area (A_ref) of a 1m diameter sphere within < 0.5% of π * r^2 (0.7854 m^2)', () => {
    const sphereGeom = createPresetGeometry('sphere'); // 1.0m diameter (r = 0.5m)
    const analyticalArea = Math.PI * 0.5 * 0.5; // ~0.7853981633974483 m^2

    const computedArea = computeProjectedFrontalArea(sphereGeom);
    const relativeErrorPercent = (Math.abs(computedArea - analyticalArea) / analyticalArea) * 100;

    expect(computedArea).toBeCloseTo(0.7854, 2);
    expect(relativeErrorPercent).toBeLessThan(0.5);
  });

  it('computes projected frontal area (A_ref) of a 1m^3 cube at 0° as 1.000 m^2', () => {
    const cubeGeom = createPresetGeometry('cube'); // 1m x 1m x 1m
    const computedArea = computeProjectedFrontalArea(cubeGeom);

    expect(computedArea).toBeCloseTo(1.0, 3);
  });

  it('correctly updates projected frontal area when a 1m^3 cube is rotated 45° around Y axis (√2 m^2)', () => {
    const cubeGeom = createPresetGeometry('cube');
    const rotMatrix = new THREE.Matrix4().makeRotationY(Math.PI / 4);
    const computedArea = computeProjectedFrontalArea(cubeGeom, rotMatrix);
    const expectedArea = Math.SQRT2; // ~1.4142 m^2

    const relativeErrorPercent = (Math.abs(computedArea - expectedArea) / expectedArea) * 100;
    expect(relativeErrorPercent).toBeLessThan(0.5);
  });

  it('computes watertightness and mesh stats accurately for built-in presets', () => {
    const cubeGeom = createPresetGeometry('cube');
    const stats = computeMeshStats(cubeGeom, 'Calibration Cube', {
      position: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });

    expect(stats.isWatertight).toBe(true);
    expect(stats.openEdgeCount).toBe(0);
    expect(stats.volume).toBeCloseTo(1.0, 3);
    expect(stats.frontalArea).toBeCloseTo(1.0, 3);
  });

  it('parses ASCII STL files and computes accurate geometry stats', () => {
    const asciiStl = `solid test_tetrahedron
      facet normal 0 0 -1
        outer loop
          vertex 0 0 0
          vertex 0 1 0
          vertex 1 0 0
        endloop
      endfacet
      facet normal 0 -1 0
        outer loop
          vertex 0 0 0
          vertex 1 0 0
          vertex 0 0 1
        endloop
      endfacet
      facet normal -1 0 0
        outer loop
          vertex 0 0 0
          vertex 0 0 1
          vertex 0 1 0
        endloop
      endfacet
      facet normal 0.577 0.577 0.577
        outer loop
          vertex 1 0 0
          vertex 0 1 0
          vertex 0 0 1
        endloop
      endfacet
    endsolid test_tetrahedron`;

    const buffer = new TextEncoder().encode(asciiStl).buffer;
    const geom = parseSTL(buffer);
    const stats = computeMeshStats(geom, 'Tetrahedron', {
      position: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });

    expect(stats.triangleCount).toBe(4);
    expect(stats.isWatertight).toBe(true);
    // Right tetrahedron with legs 1, 1, 1 has volume 1/6 and projected area 0.5 in Y-Z plane
    expect(stats.volume).toBeCloseTo(1 / 6, 4);
    expect(stats.frontalArea).toBeCloseTo(0.5, 2);
  });

  it('computes Reynolds number, dynamic pressure, and drag coefficient accurately', () => {
    const air = FLUID_PRESETS.air_20c;
    const telemetry = computeAerodynamicTelemetry({
      windSpeed: 30, // 30 m/s
      characteristicLength: 1.0, // 1.0 m
      frontalArea: 0.7854,
      fluid: air,
      tunnel: { length: 6, width: 2.5, height: 2.5 },
    });

    // Re = 30 * 1.0 / 1.516e-5 = 1,978,891.82
    expect(telemetry.reynoldsNumber).toBeCloseTo(30 / 1.516e-5, 0);
    // q = 0.5 * 1.204 * 900 = 541.8 Pa
    expect(telemetry.dynamicPressurePa).toBeCloseTo(541.8, 2);
    expect(telemetry.flowRegime).toBe('Turbulent (Supercritical)');

    // Check Cd <-> Force conversion
    const expectedCd = 0.47;
    const dragForceN = expectedCd * telemetry.dynamicPressurePa * 0.7854;
    const recoveredCd = forceToCoefficient(dragForceN, air.density, 30, 0.7854);
    expect(recoveredCd).toBeCloseTo(expectedCd, 5);
  });

  it('calculates safe 8-aligned WebGPU voxel grid resolutions within VRAM limits', () => {
    const grid = calculateSafeGridResolution(
      128 * 1024 * 1024,
      256 * 1024 * 1024,
      { length: 6, width: 3, height: 3 },
      160 * 80 * 80
    );

    expect(grid.nx % 8).toBe(0);
    expect(grid.ny % 8).toBe(0);
    expect(grid.nz % 8).toBe(0);
    expect(grid.nx).toBeGreaterThan(grid.ny);
    expect(grid.totalCells).toBe(grid.nx * grid.ny * grid.nz);
  });
});
