// Phase 3: Domain Boundaries (Inlet, Non-Reflecting Outlet, Slip/Ground Walls)
// + Bouzidi / Yu-Mei Interpolated Curved-Wall Bounce-Back on STL Boundary Cells

struct SolverParams {
  nx: u32,
  ny: u32,
  nz: u32,
  totalCells: u32,
  uInlet: f32,
  nuLattice: f32,
  smagorinskyCs: f32,
  groundNoSlip: u32,
  stepIndex: u32,
  sliceAxis: u32,
  sliceIndex: u32,
  fieldMode: u32,
};

@group(0) @binding(0) var<uniform> params: SolverParams;
@group(0) @binding(1) var<storage, read> cellFlags: array<u32>;
@group(0) @binding(2) var<storage, read> fSrc: array<f32>;
@group(0) @binding(3) var<storage, read_write> fDst: array<f32>;
@group(0) @binding(4) var<storage, read_write> macroField: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> boundaryIndexMap: array<i32>;
@group(0) @binding(6) var<storage, read> boundaryQValues: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = getGlobal1DIndex(gid);
  if (idx >= params.totalCells) {
    return;
  }

  let nx = params.nx;
  let ny = params.ny;
  let nz = params.nz;

  let ix = i32(idx % nx);
  let rem = idx / nx;
  let iy = i32(rem % ny);
  let iz = i32(rem / ny);

  let flag = cellFlags[idx];
  if (flag == 1u) {
    return;
  }

  // Note: Bouzidi Interpolated Curved-Wall Bounce-Back on STL Boundary Cells (flag == 2)
  // is applied during the pull-stream step in collideStream.wgsl so that macroscopic
  // stagnation/suction pressure and wall velocities are exact prior to collision.

  // 1. Wind Tunnel Non-Reflecting Velocity Inlet at ix == 0
  if (ix == 0) {
    var uxIn = params.uInlet;
    if (params.groundNoSlip == 1u) {
      let yFrac = (f32(iy) + 0.5) / f32(ny);
      uxIn = params.uInlet * min(1.15, 0.35 + 0.80 * pow(yFrac, 0.30));
    }
    var uyIn = 0.0;
    if (params.stepIndex < 120u) {
      uyIn = 0.015 * params.uInlet * sin(f32(params.stepIndex) * 0.15 + (f32(iy) / f32(ny)) * 6.2831853);
    }
    let nextRho = macroField[idx + 1u].w;
    let rhoIn = mix(nextRho, 1.0, 0.15);
    for (var d = 0u; d < 19u; d = d + 1u) {
      fDst[d * params.totalCells + idx] = computeFeq(d, rhoIn, uxIn, uyIn, 0.0);
    }
    macroField[idx] = vec4<f32>(uxIn, uyIn, 0.0, rhoIn);
    return;
  }

  // 3. Non-Reflecting Convective / Extrapolation Outlet at ix == nx - 1
  if (ix == i32(nx) - 1) {
    let prevIdx = idx - 1u;
    let mPrev = macroField[prevIdx];
    // Relax outlet density smoothly toward ambient rho0 = 1.0 to prevent acoustic reflections
    let rhoOut = mix(mPrev.w, 1.0, 0.15);
    for (var d = 0u; d < 19u; d = d + 1u) {
      let fPrev = fDst[d * params.totalCells + prevIdx];
      let feqOut = computeFeq(d, rhoOut, mPrev.x, mPrev.y, mPrev.z);
      fDst[d * params.totalCells + idx] = mix(fPrev, feqOut, 0.25);
    }
    macroField[idx] = vec4<f32>(mPrev.x, mPrev.y, mPrev.z, rhoOut);
    return;
  }

  // 4. Bottom Floor (iy == 0): Either No-Slip Ground Floor or Free-Slip Tunnel Wall
  if (iy == 0) {
    let m = macroField[idx];
    if (params.groundNoSlip == 1u) {
      for (var d = 0u; d < 19u; d = d + 1u) {
        fDst[d * params.totalCells + idx] = computeFeq(d, m.w, 0.0, 0.0, 0.0);
      }
      macroField[idx] = vec4<f32>(0.0, 0.0, 0.0, m.w);
    } else {
      for (var d = 0u; d < 19u; d = d + 1u) {
        fDst[d * params.totalCells + idx] = computeFeq(d, m.w, m.x, 0.0, m.z);
      }
      macroField[idx] = vec4<f32>(m.x, 0.0, m.z, m.w);
    }
  }

  // 5. Top Ceiling (iy == ny - 1) and Side Walls (iz == 0, iz == nz - 1): Free-Slip Specular Walls
  if (iy == i32(ny) - 1) {
    let m = macroField[idx];
    for (var d = 0u; d < 19u; d = d + 1u) {
      fDst[d * params.totalCells + idx] = computeFeq(d, m.w, m.x, 0.0, m.z);
    }
    macroField[idx] = vec4<f32>(m.x, 0.0, m.z, m.w);
  }

  if (params.nz > 4u && (iz == 0 || iz == i32(nz) - 1)) {
    let m = macroField[idx];
    for (var d = 0u; d < 19u; d = d + 1u) {
      fDst[d * params.totalCells + idx] = computeFeq(d, m.w, m.x, m.y, 0.0);
    }
    macroField[idx] = vec4<f32>(m.x, m.y, 0.0, m.w);
  }
}
