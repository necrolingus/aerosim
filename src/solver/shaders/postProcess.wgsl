// Phase 3: Post-Processing Compute Shader
// Computes Curl (Vorticity Magnitude |omega|), Pressure Coefficient (Cp), and Velocity Magnitude (|u| / U_inf)
// on the active 2D cross-section slice plane and packs RGBA8 scientific colormap pixels (Green/Orange/Red/Blue)
// for zero-overhead 60 FPS texture display.

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
  fieldMode: u32,   // 0 = Velocity Magnitude, 1 = Vorticity Magnitude (Curl), 2 = Pressure Coefficient (Cp)
};

@group(0) @binding(0) var<uniform> params: SolverParams;
@group(0) @binding(1) var<storage, read> cellFlags: array<u32>;
@group(0) @binding(4) var<storage, read> macroField: array<vec4<f32>>; // (ux, uy, uz, rho)
@group(0) @binding(7) var<storage, read_write> sliceRgbaOut: array<u32>;

// Maps normalized scalar t in [0, 1] to Blue -> Cyan -> Green -> Orange -> Red scientific CFD colormap
fn colormapCFD(tVal: f32) -> vec3<f32> {
  let t = clamp(tVal, 0.0, 1.0);
  if (t < 0.25) {
    let u = t * 4.0;
    return mix(vec3<f32>(0.08, 0.22, 0.75), vec3<f32>(0.06, 0.72, 0.88), u);
  } else if (t < 0.5) {
    let u = (t - 0.25) * 4.0;
    return mix(vec3<f32>(0.06, 0.72, 0.88), vec3<f32>(0.12, 0.82, 0.38), u);
  } else if (t < 0.75) {
    let u = (t - 0.5) * 4.0;
    return mix(vec3<f32>(0.12, 0.82, 0.38), vec3<f32>(0.98, 0.62, 0.08), u);
  } else {
    let u = (t - 0.75) * 4.0;
    return mix(vec3<f32>(0.98, 0.62, 0.08), vec3<f32>(0.94, 0.16, 0.18), u);
  }
}

fn packRGBA8(r: f32, g: f32, b: f32, a: f32) -> u32 {
  let ru = u32(clamp(r * 255.0, 0.0, 255.0));
  let gu = u32(clamp(g * 255.0, 0.0, 255.0));
  let bu = u32(clamp(b * 255.0, 0.0, 255.0));
  let au = u32(clamp(a * 255.0, 0.0, 255.0));
  return ru | (gu << 8u) | (bu << 16u) | (au << 24u);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let nx = params.nx;
  let ny = params.ny;
  let nz = params.nz;

  var sliceW = nx;
  var sliceH = ny;
  if (params.sliceAxis == 1u) {
    sliceW = nx;
    sliceH = nz;
  } else if (params.sliceAxis == 2u) {
    sliceW = nz;
    sliceH = ny;
  }

  let pixelIdx = getGlobal1DIndex(gid);
  if (pixelIdx >= sliceW * sliceH) {
    return;
  }

  let uCoord = pixelIdx % sliceW;
  let vCoord = pixelIdx / sliceW;

  var ix = uCoord;
  var iy = vCoord;
  var iz = clamp(params.sliceIndex, 0u, nz - 1u);

  if (params.sliceAxis == 1u) {
    ix = uCoord;
    iy = clamp(params.sliceIndex, 0u, ny - 1u);
    iz = vCoord;
  } else if (params.sliceAxis == 2u) {
    ix = clamp(params.sliceIndex, 0u, nx - 1u);
    iy = vCoord;
    iz = uCoord;
  }

  let idx = ix + nx * (iy + ny * iz);
  let flag = cellFlags[idx];

  // Solid obstacle interior
  if (flag == 1u) {
    sliceRgbaOut[pixelIdx] = packRGBA8(0.12, 0.16, 0.24, 0.92);
    return;
  }

  let m = macroField[idx];
  let uRef = max(1e-4, params.uInlet);

  var scalarNorm = 0.5;
  var alpha = 0.82;

  if (params.fieldMode == 0u) {
    // 0: Velocity Magnitude |u| / U_inlet (0 = Blue recirculation, 0.5 = Green freestream, 1.0 = Red accelerated jet)
    let speedRatio = length(m.xyz) / uRef;
    scalarNorm = clamp(speedRatio / 1.6, 0.0, 1.0);
  } else if (params.fieldMode == 1u) {
    // 1: Vorticity Magnitude |nabla x u| via central finite differences
    let ixP = min(nx - 1u, ix + 1u);
    let ixM = select(0u, ix - 1u, ix > 0u);
    let iyP = min(ny - 1u, iy + 1u);
    let iyM = select(0u, iy - 1u, iy > 0u);
    let izP = min(nz - 1u, iz + 1u);
    let izM = select(0u, iz - 1u, iz > 0u);

    let uXP = macroField[ixP + nx * (iy + ny * iz)].xyz;
    let uXM = macroField[ixM + nx * (iy + ny * iz)].xyz;
    let uYP = macroField[ix + nx * (iyP + ny * iz)].xyz;
    let uYM = macroField[ix + nx * (iyM + ny * iz)].xyz;
    let uZP = macroField[ix + nx * (iy + ny * izP)].xyz;
    let uZM = macroField[ix + nx * (iy + ny * izM)].xyz;

    let dUzDy = 0.5 * (uYP.z - uYM.z);
    let dUyDz = 0.5 * (uZP.y - uZM.y);
    let dUxDz = 0.5 * (uZP.x - uZM.x);
    let dUzDx = 0.5 * (uXP.z - uXM.z);
    let dUyDx = 0.5 * (uXP.y - uXM.y);
    let dUxDy = 0.5 * (uYP.x - uYM.x);

    let curl = vec3<f32>(dUzDy - dUyDz, dUxDz - dUzDx, dUyDx - dUxDy);
    let vortNorm = length(curl) / (uRef * 0.45);
    // Map vorticity: Green (low curl) -> Orange -> Red (intense vortex core), with low-vorticity freestream slightly more transparent
    scalarNorm = clamp(0.35 + 0.65 * vortNorm, 0.0, 1.0);
    alpha = clamp(0.25 + 0.70 * vortNorm, 0.25, 0.92);
  } else {
    // 2: Pressure Coefficient Cp = (p - p0) / (0.5 * rho0 * U^2) = ((rho - 1.0) / 3.0) / (0.5 * U_inlet^2)
    let cp = ((m.w - 1.0) / 3.0) / (0.5 * uRef * uRef);
    // Map Cp in [-1.2, +1.0] -> [0, 1]
    scalarNorm = clamp((cp + 1.1) / 2.1, 0.0, 1.0);
  }

  let rgb = colormapCFD(scalarNorm);
  sliceRgbaOut[pixelIdx] = packRGBA8(rgb.r, rgb.g, rgb.b, alpha);
}
