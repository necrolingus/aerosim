// Phase 3: Equilibrium Distribution Initialization Shader (D3Q19)

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
  sliceAxis: u32,   // 0 = Z-slice (XY plane), 1 = Y-slice (XZ plane), 2 = X-slice (YZ plane)
  sliceIndex: u32,
  fieldMode: u32,   // 0 = Velocity Magnitude, 1 = Vorticity Magnitude, 2 = Pressure Coefficient (Cp)
};

@group(0) @binding(0) var<uniform> params: SolverParams;
@group(0) @binding(1) var<storage, read> cellFlags: array<u32>;
@group(0) @binding(2) var<storage, read_write> fSrc: array<f32>;
@group(0) @binding(3) var<storage, read_write> fDst: array<f32>;
@group(0) @binding(4) var<storage, read_write> macroField: array<vec4<f32>>; // (ux, uy, uz, rho)

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.totalCells) {
    return;
  }

  let nx = params.nx;
  let ny = params.ny;
  let iy = (idx / nx) % ny;

  let flag = cellFlags[idx];
  var ux = params.uInlet;
  let uy = 0.0;
  let uz = 0.0;
  let rho = 1.0;

  if (params.groundNoSlip == 1u) {
    let yFrac = (f32(iy) + 0.5) / f32(ny);
    ux = params.uInlet * min(1.15, 0.35 + 0.80 * pow(yFrac, 0.30));
    if (iy == 0u) {
      ux = 0.0;
    }
  }

  if (flag == 1u) {
    ux = 0.0;
  }

  macroField[idx] = vec4<f32>(ux, uy, uz, rho);

  for (var d = 0u; d < 19u; d = d + 1u) {
    let feq = computeFeq(d, rho, ux, uy, uz);
    let slot = d * params.totalCells + idx;
    fSrc[slot] = feq;
    fDst[slot] = feq;
  }
}
