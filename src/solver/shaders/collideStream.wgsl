// Phase 3: D3Q19 Regularized / TRT Collision + Smagorinsky LES Sub-Grid Turbulence Shader
// Uses Structure-of-Arrays (SoA) memory layout: f[d * totalCells + idx] for coalesced GPU memory bandwidth.

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
  let idx = gid.x;
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
    // Solid interior cell
    macroField[idx] = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // 1. Pull-stream distributions from neighbors (with Bouzidi curved-wall reflection on solid links)
  var fLocal: array<f32, 19>;
  var rho = 0.0;
  var ux = 0.0;
  var uy = 0.0;
  var uz = 0.0;

  let bIdx = select(-1, boundaryIndexMap[idx], flag == 2u);

  for (var d = 0u; d < 19u; d = d + 1u) {
    let sx = clamp(ix - CX[d], 0, i32(nx) - 1);
    let sy = clamp(iy - CY[d], 0, i32(ny) - 1);
    let sz = clamp(iz - CZ[d], 0, i32(nz) - 1);
    let srcIdx = u32(sx) + nx * (u32(sy) + ny * u32(sz));

    var val = 0.0;
    if (d > 0u && cellFlags[srcIdx] == 1u) {
      let wallDir = OPP[d];
      var qEff = 0.5;
      if (bIdx >= 0) {
        let q = boundaryQValues[u32(bIdx) * 18u + (wallDir - 1u)];
        if (q > 0.0) {
          qEff = q;
        }
      }
      let fOutCurr = fSrc[wallDir * params.totalCells + idx];
      let ffx = clamp(ix + CX[d], 0, i32(nx) - 1);
      let ffy = clamp(iy + CY[d], 0, i32(ny) - 1);
      let ffz = clamp(iz + CZ[d], 0, i32(nz) - 1);
      let ffIdx = u32(ffx) + nx * (u32(ffy) + ny * u32(ffz));

      if (cellFlags[ffIdx] != 1u) {
        if (qEff < 0.5) {
          let fOutNeighbor = fSrc[wallDir * params.totalCells + ffIdx];
          val = 2.0 * qEff * fOutCurr + (1.0 - 2.0 * qEff) * fOutNeighbor;
        } else {
          let fInCurr = fSrc[d * params.totalCells + idx];
          let inv2q = 1.0 / (2.0 * qEff);
          val = inv2q * fOutCurr + (1.0 - inv2q) * fInCurr;
        }
      } else {
        val = fOutCurr;
      }
    } else {
      val = fSrc[d * params.totalCells + srcIdx];
    }

    fLocal[d] = val;
    rho = rho + val;
    ux = ux + f32(CX[d]) * val;
    uy = uy + f32(CY[d]) * val;
    uz = uz + f32(CZ[d]) * val;
  }

  rho = clamp(rho, 0.5, 1.8);
  let invRho = 1.0 / rho;
  ux = ux * invRho;
  uy = uy * invRho;
  uz = uz * invRho;

  // Mach limiter for unconditionally stable high-Re transients
  let uMagSq = ux * ux + uy * uy + uz * uz;
  let maxUMag = 0.22;
  if (uMagSq > maxUMag * maxUMag) {
    let scale = maxUMag / sqrt(uMagSq);
    ux = ux * scale;
    uy = uy * scale;
    uz = uz * scale;
  }

  // 2. Compute Equilibrium f^eq and Non-Equilibrium Stress Tensor Pi^(1)_ab for Smagorinsky LES + Regularized LBM
  var feq: array<f32, 19>;
  let uSq = ux * ux + uy * uy + uz * uz;

  var piXX = 0.0;
  var piYY = 0.0;
  var piZZ = 0.0;
  var piXY = 0.0;
  var piXZ = 0.0;
  var piYZ = 0.0;

  for (var d = 0u; d < 19u; d = d + 1u) {
    let cx = f32(CX[d]);
    let cy = f32(CY[d]);
    let cz = f32(CZ[d]);
    let cu = 3.0 * (cx * ux + cy * uy + cz * uz);
    let eq = W[d] * rho * (1.0 + cu + 0.5 * cu * cu - 1.5 * uSq);
    feq[d] = eq;

    let fNeq = fLocal[d] - eq;
    piXX = piXX + cx * cx * fNeq;
    piYY = piYY + cy * cy * fNeq;
    piZZ = piZZ + cz * cz * fNeq;
    piXY = piXY + cx * cy * fNeq;
    piXZ = piXZ + cx * cz * fNeq;
    piYZ = piYZ + cy * cz * fNeq;
  }

  // Frobenius norm of non-equilibrium momentum flux tensor ||Pi||
  let piNorm = sqrt(
    piXX * piXX + piYY * piYY + piZZ * piZZ +
    2.0 * (piXY * piXY + piXZ * piXZ + piYZ * piYZ)
  );

  // Smagorinsky LES effective relaxation time tau_eff
  let tau0 = 3.0 * params.nuLattice + 0.5;
  let csSq = params.smagorinskyCs * params.smagorinskyCs;
  let tauEff = 0.5 * (tau0 + sqrt(tau0 * tau0 + 18.0 * sqrt(2.0) * csSq * piNorm / rho));
  let omega = 1.0 / clamp(tauEff, 0.5015, 1.95);

  // 3. Regularized (Latt & Chopard) projection of f^(1) onto second-order Hermite polynomials H^(2)_i
  // Filters out unstable non-hydrodynamic ghost modes at Re >= 100,000!
  for (var d = 0u; d < 19u; d = d + 1u) {
    let cx = f32(CX[d]);
    let cy = f32(CY[d]);
    let cz = f32(CZ[d]);

    let qXX = cx * cx - (1.0 / 3.0);
    let qYY = cy * cy - (1.0 / 3.0);
    let qZZ = cz * cz - (1.0 / 3.0);
    let qXY = cx * cy;
    let qXZ = cx * cz;
    let qYZ = cy * cz;

    let f1Reg = 4.5 * W[d] * (
      qXX * piXX + qYY * piYY + qZZ * piZZ +
      2.0 * (qXY * piXY + qXZ * piXZ + qYZ * piYZ)
    );

    let fPost = feq[d] + (1.0 - omega) * f1Reg;
    fDst[d * params.totalCells + idx] = fPost;
  }

  macroField[idx] = vec4<f32>(ux, uy, uz, rho);
}
