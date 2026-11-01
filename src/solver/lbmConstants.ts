/**
 * Unified Canonical Constants for D3Q19 Lattice Boltzmann Method & Aerodynamics Solver.
 * Single source of truth for both TypeScript reference solvers and WGSL shaders.
 */

/**
 * Canonical 19 discrete lattice velocity directions c_i in D3Q19.
 * Velocity vectors [cx, cy, cz].
 */
export const D3Q19_DIRECTIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],   // 0: Rest particle
  // 6 Face neighbors (distance 1)
  [1, 0, 0],   // 1: +X (East)
  [-1, 0, 0],  // 2: -X (West)
  [0, 1, 0],   // 3: +Y (Top)
  [0, -1, 0],  // 4: -Y (Bottom)
  [0, 0, 1],   // 5: +Z (North)
  [0, 0, -1],  // 6: -Z (South)
  // 12 Edge neighbors (distance sqrt(2))
  [1, 1, 0],   // 7: +X+Y
  [-1, -1, 0], // 8: -X-Y
  [1, -1, 0],  // 9: +X-Y
  [-1, 1, 0],  // 10: -X+Y
  [1, 0, 1],   // 11: +X+Z
  [-1, 0, -1], // 12: -X-Z
  [1, 0, -1],  // 13: +X-Z
  [-1, 0, 1],  // 14: -X+Z
  [0, 1, 1],   // 15: +Y+Z
  [0, -1, -1], // 16: -Y-Z
  [0, 1, -1],  // 17: +Y-Z
  [0, -1, 1],  // 18: -Y+Z
];

/**
 * Opposite direction lookup table: OPP[d] satisfies c_{OPP[d]} = -c_d
 */
export const D3Q19_OPPOSITE: ReadonlyArray<number> = [
  0,
  2, 1,
  4, 3,
  6, 5,
  8, 7,
  10, 9,
  12, 11,
  14, 13,
  16, 15,
  18, 17,
];

/**
 * Equilibrium weights w_i for D3Q19 model:
 * w_0 = 1/3
 * w_{1..6} = 1/18
 * w_{7..18} = 1/36
 */
export const LBM_WEIGHTS: ReadonlyArray<number> = [
  1.0 / 3.0,
  1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0,
  1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0,
  1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0,
];

export const LBM_WEIGHTS_F32 = new Float32Array(LBM_WEIGHTS);
export const LBM_CX = new Int32Array(D3Q19_DIRECTIONS.map((d) => d[0]));
export const LBM_CY = new Int32Array(D3Q19_DIRECTIONS.map((d) => d[1]));
export const LBM_CZ = new Int32Array(D3Q19_DIRECTIONS.map((d) => d[2]));

/**
 * Physical & Numerical Simulation Parameters
 */
export const LBM_CONSTANTS = {
  /** Speed of sound squared: c_s^2 = 1/3 */
  CS_SQ: 1.0 / 3.0,
  INV_CS_SQ: 3.0,
  INV_TWO_CS_POW4: 4.5,
  /** Mach limiter for incompressible stability in transients: |u| <= 0.22 */
  MAX_U_MAG: 0.22,
  MAX_U_MAG_SQ: 0.22 * 0.22,
  /** Default Smagorinsky sub-grid turbulence constant */
  DEFAULT_SMAGORINSKY_CS: 0.12,
  /** Relaxation time bounds [tau_min, tau_max] */
  TAU_MIN: 0.5015,
  TAU_MAX: 1.95,
  /** Density limiter bounds [rho_min, rho_max] */
  RHO_MIN: 0.5,
  RHO_MAX: 1.8,
  /** Sponge inlet/outlet blend factors */
  SPONGE_WEIGHT_INTERIOR: 0.85,
  SPONGE_WEIGHT_EXTERIOR: 0.15,
  OUTLET_CONVECTIVE_WEIGHT: 0.75,
  /** Maskell (1963) wind tunnel blockage correction factor */
  MASKELL_EPSILON: 2.5,
  /** Inflow velocity parameterization bounds in lattice units */
  U_INLET_LAT_DEFAULT: 0.085,
  U_INLET_LAT_MIN: 0.04,
  U_INLET_LAT_MAX: 0.11,
  DEFAULT_WIND_SPEED_MPS: 25.0,
  /** Unit conversion factors */
  SPEED_MPS_TO_MPH: 2.23693629,
  SPEED_MPS_TO_KMH: 3.6,
  NEWTONS_TO_LBF: 0.224808943,
  NEWTONS_TO_KGF: 0.101971621,
  /** WebGPU Compute limits & workgroup layout */
  MAX_COMPUTE_WORKGROUPS_PER_DIM: 65535,
  WORKGROUP_SIZE_X: 64,
} as const;

/**
 * Calculates optimal incompressible lattice inflow speed (Mach < 0.2) based on physical wind speed.
 */
export function computeOptimalLatticeSpeed(windSpeedMps: number): number {
  return Math.min(
    LBM_CONSTANTS.U_INLET_LAT_MAX,
    Math.max(
      LBM_CONSTANTS.U_INLET_LAT_MIN,
      0.06 + (windSpeedMps / 120.0) * 0.045
    )
  );
}

/**
 * Maps any number of elements to a 2D/3D WebGPU workgroup dispatch [wx, wy, wz]
 * strictly enforcing that no dimension exceeds the WebGPU hardware limit (65535).
 */
export function calculateDispatchWorkgroups(
  totalElements: number,
  workgroupSizeX = LBM_CONSTANTS.WORKGROUP_SIZE_X
): [number, number, number] {
  const totalWorkgroups = Math.max(1, Math.ceil(totalElements / workgroupSizeX));
  const maxDim = LBM_CONSTANTS.MAX_COMPUTE_WORKGROUPS_PER_DIM;
  if (totalWorkgroups <= maxDim) {
    return [totalWorkgroups, 1, 1];
  }
  const x = maxDim;
  const y = Math.ceil(totalWorkgroups / maxDim);
  return [x, y, 1];
}

/**
 * Computes standard second-order equilibrium distribution feq_i(rho, u).
 */
export function computeEquilibrium(
  dir: number,
  rho: number,
  ux: number,
  uy: number,
  uz: number
): number {
  const cu = 3.0 * (LBM_CX[dir] * ux + LBM_CY[dir] * uy + LBM_CZ[dir] * uz);
  const uSq = ux * ux + uy * uy + uz * uz;
  return LBM_WEIGHTS[dir] * rho * (1.0 + cu + 0.5 * cu * cu - 1.5 * uSq);
}

/**
 * Canonical WGSL common definitions snippet to be injected into WebGPU shaders.
 */
export const D3Q19_COMMON_WGSL = /* wgsl */ `
// --- Canonical D3Q19 Shared Lattice Definitions ---
const W = array<f32, 19>(
  1.0 / 3.0,
  1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0,
  1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0,
  1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0
);

const CX = array<i32, 19>(0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0);
const CY = array<i32, 19>(0, 0, 0, 1, -1, 0, 0, 1, -1, -1, 1, 0, 0, 0, 0, 1, -1, 1, -1);
const CZ = array<i32, 19>(0, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, 1, -1, -1, 1, 1, -1, -1, 1);

const OPP = array<u32, 19>(
  0u,
  2u, 1u,
  4u, 3u,
  6u, 5u,
  8u, 7u,
  10u, 9u,
  12u, 11u,
  14u, 13u,
  16u, 15u,
  18u, 17u
);

const CS_SQ: f32 = 0.3333333333333333;
const MAX_U_MAG: f32 = 0.22;
const MAX_U_MAG_SQ: f32 = 0.0484;

// WebGPU safe multi-dimensional workgroup 1D thread index calculator
fn getGlobal1DIndex(gid: vec3<u32>) -> u32 {
  return gid.x + gid.y * (65535u * 64u);
}

fn computeFeq(dir: u32, rho: f32, ux: f32, uy: f32, uz: f32) -> f32 {
  let cu = 3.0 * (f32(CX[dir]) * ux + f32(CY[dir]) * uy + f32(CZ[dir]) * uz);
  let uSq = ux * ux + uy * uy + uz * uz;
  return W[dir] * rho * (1.0 + cu + 0.5 * cu * cu - 1.5 * uSq);
}
`;
