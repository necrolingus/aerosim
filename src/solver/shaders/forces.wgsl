// Phase 4: Galilean-Invariant Momentum-Exchange Force & Moment Integrator Shader (D3Q19)
//
// For every boundary fluid cell bIdx in [0 .. boundaryCellCount - 1], sums the hydrodynamic
// momentum transferred across all cut lattice links d in 1..18 that intersect the STL surface:
//   df_d = c_d * (f_out(x_f, d) + f_in(x_f, opp(d))) * phi(q)
// where phi(q) weights the sub-grid link fraction to eliminate staircase over-counting on oblique/curved surfaces,
// and computes the local pitching/yawing torque r x df about the model centroid.

struct ForceParams {
  nx: u32,
  ny: u32,
  nz: u32,
  totalCells: u32,
  boundaryCellCount: u32,
  dx: f32,
  dy: f32,
  dz: f32,
  originX: f32,
  originY: f32,
  originZ: f32,
  surfaceAreaRatio: f32, // Ratio of true triangle mesh surface area to voxel stairstep link area
};

@group(0) @binding(0) var<uniform> fParams: ForceParams;
@group(0) @binding(1) var<storage, read> fPostBoundary: array<f32>;
@group(0) @binding(2) var<storage, read> boundaryCellIndices: array<i32>;
@group(0) @binding(3) var<storage, read> boundaryQValues: array<f32>;
// Output per-boundary-cell force & moment:
// forceMomentsOut[bIdx * 2 + 0] = vec4<f32>(fx, fy, fz, localCp)
// forceMomentsOut[bIdx * 2 + 1] = vec4<f32>(mx, my, mz, linkCount)
@group(0) @binding(4) var<storage, read_write> forceMomentsOut: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let bIdx = getGlobal1DIndex(gid);
  if (bIdx >= fParams.boundaryCellCount) {
    return;
  }

  let cellIdx = u32(boundaryCellIndices[bIdx]);
  let nx = fParams.nx;
  let ny = fParams.ny;
  let nz = fParams.nz;

  let ix = i32(cellIdx % nx);
  let rem = cellIdx / nx;
  let iy = i32(rem % ny);
  let iz = i32(rem / ny);

  let posX = fParams.originX + (f32(ix) + 0.5) * fParams.dx;
  let posY = fParams.originY + (f32(iy) + 0.5) * fParams.dy;
  let posZ = fParams.originZ + (f32(iz) + 0.5) * fParams.dz;

  var fx = 0.0;
  var fy = 0.0;
  var fz = 0.0;
  var cutLinks = 0.0;

  let qBase = bIdx * 18u;
  for (var d = 1u; d <= 18u; d = d + 1u) {
    let q = boundaryQValues[qBase + (d - 1u)];
    if (q > 0.0) {
      let fOut = fPostBoundary[d * fParams.totalCells + cellIdx];
      let oppDir = OPP[d];
      let oppVec = vec3<i32>(CX[oppDir], CY[oppDir], CZ[oppDir]);
      let ffx = clamp(ix + oppVec.x, 0, i32(nx) - 1);
      let ffy = clamp(iy + oppVec.y, 0, i32(ny) - 1);
      let ffz = clamp(iz + oppVec.z, 0, i32(nz) - 1);
      let ffIdx = u32(ffx + i32(nx) * (ffy + i32(ny) * ffz));

      var fIn = fOut;
      if (q < 0.5) {
        let fOutNeighbor = fPostBoundary[d * fParams.totalCells + ffIdx];
        fIn = 2.0 * q * fOut + (1.0 - 2.0 * q) * fOutNeighbor;
      } else {
        let fInCurr = fPostBoundary[oppDir * fParams.totalCells + cellIdx];
        let inv2q = 1.0 / (2.0 * q);
        fIn = inv2q * fOut + (1.0 - inv2q) * fInCurr;
      }

      // Galilean-invariant momentum exchange (subtracting background hydrostatic pressure 2 * w_d * rho_0)
      let momTransfer = fOut + fIn - 2.0 * W[d];

      let cx = f32(CX[d]);
      let cy = f32(CY[d]);
      let cz = f32(CZ[d]);

      fx = fx + cx * momTransfer;
      fy = fy + cy * momTransfer;
      fz = fz + cz * momTransfer;
      cutLinks = cutLinks + 1.0;
    }
  }

  // Torque M = r x F in lattice units about model centroid
  let rx = (f32(ix) + 0.5) - 0.5 * f32(nx);
  let ry = (f32(iy) + 0.5) - 0.5 * f32(ny);
  let rz = (f32(iz) + 0.5) - 0.5 * f32(nz);

  let mx = ry * fz - rz * fy;
  let my = rz * fx - rx * fz;
  let mz = rx * fy - ry * fx;

  forceMomentsOut[bIdx * 2u] = vec4<f32>(fx, fy, fz, 0.0);
  forceMomentsOut[bIdx * 2u + 1u] = vec4<f32>(mx, my, mz, cutLinks);
}
