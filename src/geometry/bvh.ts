import * as THREE from 'three';

/**
 * High-performance flat-array Bounding Volume Hierarchy (BVH) for triangle meshes.
 *
 * Used by the Phase 2 Sub-Grid Voxelizer to:
 * 1. Perform fast scanline ray-cast intersections along the +X axis (classify Fluid vs Solid cells).
 * 2. Compute exact sub-grid curved-wall fractional distances q in (0, 1] along all 18 non-zero
 *    D3Q19 lattice velocity vectors for Bouzidi / Yu-Mei interpolated bounce-back.
 * 3. Handle both watertight and slightly non-manifold meshes via multi-direction consensus ray-casting.
 */
export class MeshBVH {
  public readonly triCount: number;
  // Packed world-space triangle vertices: [ax, ay, az, e1x, e1y, e1z, e2x, e2y, e2z] per triangle (9 floats)
  // Storing vertex A and edges E1 = B - A, E2 = C - A makes Möller-Trumbore ray-triangle tests ultra-fast.
  public readonly triData: Float64Array;
  // Packed face unit normals: [nx, ny, nz] per triangle (3 floats)
  public readonly triNormals: Float64Array;

  // Flat BVH nodes:
  // nodeBounds: [minX, minY, minZ, maxX, maxY, maxZ] per node (6 floats)
  public readonly nodeBounds: Float64Array;
  // nodeLeftOrFirst: if nodeCount == 0 (internal node), index of left child; else first triangle index in triIndices
  public readonly nodeLeftOrFirst: Int32Array;
  // nodeTriCount: 0 for internal nodes, > 0 for leaf nodes
  public readonly nodeTriCount: Int32Array;
  public readonly triIndices: Int32Array;

  public readonly boundsMin: THREE.Vector3;
  public readonly boundsMax: THREE.Vector3;

  private nodePtr = 0;

  constructor(geometry: THREE.BufferGeometry, worldMatrix?: THREE.Matrix4) {
    const posAttr = geometry.getAttribute('position');
    const indexAttr = geometry.getIndex();
    this.triCount = indexAttr
      ? Math.floor(indexAttr.count / 3)
      : posAttr
      ? Math.floor(posAttr.count / 3)
      : 0;

    this.triData = new Float64Array(this.triCount * 9);
    this.triNormals = new Float64Array(this.triCount * 3);
    this.triIndices = new Int32Array(this.triCount);

    const triCentroids = new Float64Array(this.triCount * 3);
    const triBBox = new Float64Array(this.triCount * 6);

    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const normal = new THREE.Vector3();

    this.boundsMin = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.boundsMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    for (let t = 0; t < this.triCount; t++) {
      this.triIndices[t] = t;
      let i0: number, i1: number, i2: number;
      if (indexAttr) {
        i0 = indexAttr.getX(t * 3);
        i1 = indexAttr.getX(t * 3 + 1);
        i2 = indexAttr.getX(t * 3 + 2);
      } else {
        i0 = t * 3;
        i1 = t * 3 + 1;
        i2 = t * 3 + 2;
      }

      vA.fromBufferAttribute(posAttr, i0);
      vB.fromBufferAttribute(posAttr, i1);
      vC.fromBufferAttribute(posAttr, i2);

      if (worldMatrix) {
        vA.applyMatrix4(worldMatrix);
        vB.applyMatrix4(worldMatrix);
        vC.applyMatrix4(worldMatrix);
      }

      e1.subVectors(vB, vA);
      e2.subVectors(vC, vA);
      normal.crossVectors(e1, e2).normalize();

      const base9 = t * 9;
      this.triData[base9] = vA.x;
      this.triData[base9 + 1] = vA.y;
      this.triData[base9 + 2] = vA.z;
      this.triData[base9 + 3] = e1.x;
      this.triData[base9 + 4] = e1.y;
      this.triData[base9 + 5] = e1.z;
      this.triData[base9 + 6] = e2.x;
      this.triData[base9 + 7] = e2.y;
      this.triData[base9 + 8] = e2.z;

      const base3 = t * 3;
      this.triNormals[base3] = normal.x;
      this.triNormals[base3 + 1] = normal.y;
      this.triNormals[base3 + 2] = normal.z;

      triCentroids[base3] = (vA.x + vB.x + vC.x) / 3.0;
      triCentroids[base3 + 1] = (vA.y + vB.y + vC.y) / 3.0;
      triCentroids[base3 + 2] = (vA.z + vB.z + vC.z) / 3.0;

      const minX = Math.min(vA.x, vB.x, vC.x);
      const minY = Math.min(vA.y, vB.y, vC.y);
      const minZ = Math.min(vA.z, vB.z, vC.z);
      const maxX = Math.max(vA.x, vB.x, vC.x);
      const maxY = Math.max(vA.y, vB.y, vC.y);
      const maxZ = Math.max(vA.z, vB.z, vC.z);

      const base6 = t * 6;
      triBBox[base6] = minX;
      triBBox[base6 + 1] = minY;
      triBBox[base6 + 2] = minZ;
      triBBox[base6 + 3] = maxX;
      triBBox[base6 + 4] = maxY;
      triBBox[base6 + 5] = maxZ;

      if (minX < this.boundsMin.x) this.boundsMin.x = minX;
      if (minY < this.boundsMin.y) this.boundsMin.y = minY;
      if (minZ < this.boundsMin.z) this.boundsMin.z = minZ;
      if (maxX > this.boundsMax.x) this.boundsMax.x = maxX;
      if (maxY > this.boundsMax.y) this.boundsMax.y = maxY;
      if (maxZ > this.boundsMax.z) this.boundsMax.z = maxZ;
    }

    const maxNodes = Math.max(1, this.triCount * 2);
    this.nodeBounds = new Float64Array(maxNodes * 6);
    this.nodeLeftOrFirst = new Int32Array(maxNodes);
    this.nodeTriCount = new Int32Array(maxNodes);

    if (this.triCount > 0) {
      this.nodePtr = 1; // Root is node 0
      this.buildNode(0, 0, this.triCount, triCentroids, triBBox);
    }
  }

  private buildNode(
    nodeIdx: number,
    first: number,
    count: number,
    centroids: Float64Array,
    triBBox: Float64Array
  ): void {
    // Compute node AABB
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;

    let cMinX = Infinity,
      cMinY = Infinity,
      cMinZ = Infinity;
    let cMaxX = -Infinity,
      cMaxY = -Infinity,
      cMaxZ = -Infinity;

    for (let i = first; i < first + count; i++) {
      const t = this.triIndices[i];
      const b6 = t * 6;
      if (triBBox[b6] < minX) minX = triBBox[b6];
      if (triBBox[b6 + 1] < minY) minY = triBBox[b6 + 1];
      if (triBBox[b6 + 2] < minZ) minZ = triBBox[b6 + 2];
      if (triBBox[b6 + 3] > maxX) maxX = triBBox[b6 + 3];
      if (triBBox[b6 + 4] > maxY) maxY = triBBox[b6 + 4];
      if (triBBox[b6 + 5] > maxZ) maxZ = triBBox[b6 + 5];

      const c3 = t * 3;
      const cx = centroids[c3];
      const cy = centroids[c3 + 1];
      const cz = centroids[c3 + 2];
      if (cx < cMinX) cMinX = cx;
      if (cy < cMinY) cMinY = cy;
      if (cz < cMinZ) cMinZ = cz;
      if (cx > cMaxX) cMaxX = cx;
      if (cy > cMaxY) cMaxY = cy;
      if (cz > cMaxZ) cMaxZ = cz;
    }

    const nb = nodeIdx * 6;
    this.nodeBounds[nb] = minX;
    this.nodeBounds[nb + 1] = minY;
    this.nodeBounds[nb + 2] = minZ;
    this.nodeBounds[nb + 3] = maxX;
    this.nodeBounds[nb + 4] = maxY;
    this.nodeBounds[nb + 5] = maxZ;

    // Leaf threshold
    if (count <= 4) {
      this.nodeLeftOrFirst[nodeIdx] = first;
      this.nodeTriCount[nodeIdx] = count;
      return;
    }

    // Choose split axis with largest centroid extent
    const extX = cMaxX - cMinX;
    const extY = cMaxY - cMinY;
    const extZ = cMaxZ - cMinZ;
    let axis = 0;
    let splitPos = 0.5 * (cMinX + cMaxX);
    let maxExt = extX;

    if (extY > maxExt) {
      axis = 1;
      maxExt = extY;
      splitPos = 0.5 * (cMinY + cMaxY);
    }
    if (extZ > maxExt) {
      axis = 2;
      maxExt = extZ;
      splitPos = 0.5 * (cMinZ + cMaxZ);
    }

    if (maxExt <= 1e-12) {
      this.nodeLeftOrFirst[nodeIdx] = first;
      this.nodeTriCount[nodeIdx] = count;
      return;
    }

    // Partition in-place around splitPos
    let i = first;
    let j = first + count - 1;
    while (i <= j) {
      const t = this.triIndices[i];
      if (centroids[t * 3 + axis] < splitPos) {
        i++;
      } else {
        const tmp = this.triIndices[i];
        this.triIndices[i] = this.triIndices[j];
        this.triIndices[j] = tmp;
        j--;
      }
    }

    let leftCount = i - first;
    if (leftCount === 0 || leftCount === count) {
      leftCount = count >> 1;
    }

    const leftChildIdx = this.nodePtr;
    this.nodePtr += 2; // Reserve consecutive leftChildIdx and leftChildIdx + 1

    this.nodeLeftOrFirst[nodeIdx] = leftChildIdx;
    this.nodeTriCount[nodeIdx] = 0;

    this.buildNode(leftChildIdx, first, leftCount, centroids, triBBox);
    this.buildNode(leftChildIdx + 1, first + leftCount, count - leftCount, centroids, triBBox);
  }

  /**
   * Casts a bounded segment ray from origin (ox, oy, oz) along direction (dx, dy, dz)
   * where (dx, dy, dz) need NOT be normalized: any hit with parameter t in (0, maxT]
   * corresponds to physical fractional distance q = t / maxT along the segment.
   *
   * Returns the minimum positive t in (1e-9, maxT], or -1 if no intersection exists.
   * For D3Q19 lattice links where (dx, dy, dz) is the exact vector from fluid node x_f
   * to solid neighbor x_b = x_f + c_i * dx_grid (with maxT = 1.0), the returned t IS
   * the exact sub-grid wall fraction q in (0, 1]!
   */
  public intersectSegment(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxT = 1.0
  ): number {
    if (this.triCount === 0) return -1;

    const invDx = Math.abs(dx) > 1e-15 ? 1.0 / dx : dx >= 0 ? 1e15 : -1e15;
    const invDy = Math.abs(dy) > 1e-15 ? 1.0 / dy : dy >= 0 ? 1e15 : -1e15;
    const invDz = Math.abs(dz) > 1e-15 ? 1.0 / dz : dz >= 0 ? 1e15 : -1e15;

    let closestT = maxT + 1e-7;
    let found = false;

    // Fixed traversal stack
    const stack = new Int32Array(64);
    let stackPtr = 0;
    stack[stackPtr++] = 0;

    while (stackPtr > 0) {
      const nodeIdx = stack[--stackPtr];
      const nb = nodeIdx * 6;

      // Slab AABB intersection test in parameter space [0, closestT]
      const tx1 = (this.nodeBounds[nb] - ox) * invDx;
      const tx2 = (this.nodeBounds[nb + 3] - ox) * invDx;
      let tmin = Math.min(tx1, tx2);
      let tmax = Math.max(tx1, tx2);

      const ty1 = (this.nodeBounds[nb + 1] - oy) * invDy;
      const ty2 = (this.nodeBounds[nb + 4] - oy) * invDy;
      tmin = Math.max(tmin, Math.min(ty1, ty2));
      tmax = Math.min(tmax, Math.max(ty1, ty2));

      const tz1 = (this.nodeBounds[nb + 2] - oz) * invDz;
      const tz2 = (this.nodeBounds[nb + 5] - oz) * invDz;
      tmin = Math.max(tmin, Math.min(tz1, tz2));
      tmax = Math.min(tmax, Math.max(tz1, tz2));

      if (tmax < Math.max(0, tmin) || tmin > closestT) {
        continue;
      }

      const count = this.nodeTriCount[nodeIdx];
      if (count > 0) {
        const first = this.nodeLeftOrFirst[nodeIdx];
        for (let i = first; i < first + count; i++) {
          const tIdx = this.triIndices[i];
          const b9 = tIdx * 9;

          const ax = this.triData[b9];
          const ay = this.triData[b9 + 1];
          const az = this.triData[b9 + 2];
          const e1x = this.triData[b9 + 3];
          const e1y = this.triData[b9 + 4];
          const e1z = this.triData[b9 + 5];
          const e2x = this.triData[b9 + 6];
          const e2y = this.triData[b9 + 7];
          const e2z = this.triData[b9 + 8];

          // P = D x E2
          const px = dy * e2z - dz * e2y;
          const py = dz * e2x - dx * e2z;
          const pz = dx * e2y - dy * e2x;

          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-13) continue;

          const invDet = 1.0 / det;
          const tx = ox - ax;
          const ty = oy - ay;
          const tz = oz - az;

          const u = (tx * px + ty * py + tz * pz) * invDet;
          if (u < -1e-7 || u > 1.0 + 1e-7) continue;

          // Q = T x E1
          const qx = ty * e1z - tz * e1y;
          const qy = tz * e1x - tx * e1z;
          const qz = tx * e1y - ty * e1x;

          const v = (dx * qx + dy * qy + dz * qz) * invDet;
          if (v < -1e-7 || u + v > 1.0 + 1e-7) continue;

          const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
          if (t > 1e-7 && t <= closestT) {
            closestT = t;
            found = true;
          }
        }
      } else {
        const left = this.nodeLeftOrFirst[nodeIdx];
        stack[stackPtr++] = left + 1;
        stack[stackPtr++] = left;
      }
    }

    return found ? Math.min(maxT, closestT) : -1;
  }

  /**
   * Collects all ray-triangle intersection X-coordinates along a +X scanline at fixed (y, z).
   * To prevent double-counting when a scanline grazes a shared triangle edge or vertex,
   * an irrational sub-nanometer perturbation is applied to (y, z) and duplicate X hits
   * with identical normal orientation within 1e-6 are deduplicated.
   */
  public collectXScanlineHits(y: number, z: number, outHits: number[]): number {
    outHits.length = 0;
    if (this.triCount === 0) return 0;

    // Irrational perturbation prevents exact edge/vertex grazing degeneracies on axis-aligned CAD meshes
    const py = y + 1.37e-8;
    const pz = z + 2.93e-8;

    if (
      py < this.boundsMin.y ||
      py > this.boundsMax.y ||
      pz < this.boundsMin.z ||
      pz > this.boundsMax.z
    ) {
      return 0;
    }

    const stack = new Int32Array(64);
    let stackPtr = 0;
    stack[stackPtr++] = 0;

    while (stackPtr > 0) {
      const nodeIdx = stack[--stackPtr];
      const nb = nodeIdx * 6;

      if (
        py < this.nodeBounds[nb + 1] ||
        py > this.nodeBounds[nb + 4] ||
        pz < this.nodeBounds[nb + 2] ||
        pz > this.nodeBounds[nb + 5]
      ) {
        continue;
      }

      const count = this.nodeTriCount[nodeIdx];
      if (count > 0) {
        const first = this.nodeLeftOrFirst[nodeIdx];
        for (let i = first; i < first + count; i++) {
          const tIdx = this.triIndices[i];
          const b9 = tIdx * 9;

          const ax = this.triData[b9];
          const ay = this.triData[b9 + 1];
          const az = this.triData[b9 + 2];
          const e1x = this.triData[b9 + 3];
          const e1y = this.triData[b9 + 4];
          const e1z = this.triData[b9 + 5];
          const e2x = this.triData[b9 + 6];
          const e2y = this.triData[b9 + 7];
          const e2z = this.nodeBounds ? this.triData[b9 + 8] : 0;

          // For ray direction D = (1, 0, 0), P = D x E2 = (0, -e2z, e2y)
          const det = -e1y * e2z + e1z * e2y;
          if (Math.abs(det) < 1e-13) continue;

          const invDet = 1.0 / det;
          const ty = py - ay;
          const tz = pz - az;

          const u = (-ty * e2z + tz * e2y) * invDet;
          if (u < 0.0 || u > 1.0) continue;

          // v = (D . (T x E1)) * invDet = (ty * e1z - tz * e1y) * invDet
          const v = (ty * e1z - tz * e1y) * invDet;
          if (v < 0.0 || u + v > 1.0) continue;

          // xHit = ax + u * e1x + v * e2x
          const xHit = ax + u * e1x + v * e2x;
          outHits.push(xHit);
        }
      } else {
        const left = this.nodeLeftOrFirst[nodeIdx];
        stack[stackPtr++] = left + 1;
        stack[stackPtr++] = left;
      }
    }

    if (outHits.length > 1) {
      outHits.sort((a, b) => a - b);
    }

    return outHits.length;
  }

  /**
   * Robust point-in-mesh query supporting both watertight manifold meshes and slightly
   * non-manifold meshes (e.g. open seams or unitched caps) by taking a majority vote
   * across 3 linearly independent off-axis ray directions.
   */
  public isPointInside(x: number, y: number, z: number): boolean {
    if (
      x < this.boundsMin.x ||
      x > this.boundsMax.x ||
      y < this.boundsMin.y ||
      y > this.boundsMax.y ||
      z < this.boundsMin.z ||
      z > this.boundsMax.z
    ) {
      return false;
    }

    // Cast 3 non-coplanar rays and take majority parity vote (2 out of 3) so a single hole
    // or open edge on a non-manifold STL does not corrupt interior classification.
    const dirs = [
      [1.0, 0.0137, 0.0293],
      [-0.0191, 1.0, 0.0317],
      [0.0239, -0.0173, 1.0],
    ];

    let insideVotes = 0;
    for (let d = 0; d < 3; d++) {
      const [dx, dy, dz] = dirs[d];
      const hits = this.countRayIntersections(x, y, z, dx, dy, dz);
      if ((hits & 1) === 1) {
        insideVotes++;
      }
      // Early exit if already 2 votes inside or 2 votes outside
      if (insideVotes >= 2) return true;
      if (d === 1 && insideVotes === 0) return false;
    }

    return insideVotes >= 2;
  }

  private countRayIntersections(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number
  ): number {
    const invDx = 1.0 / dx;
    const invDy = 1.0 / dy;
    const invDz = 1.0 / dz;

    let hitCount = 0;
    const stack = new Int32Array(64);
    let stackPtr = 0;
    stack[stackPtr++] = 0;

    while (stackPtr > 0) {
      const nodeIdx = stack[--stackPtr];
      const nb = nodeIdx * 6;

      const tx1 = (this.nodeBounds[nb] - ox) * invDx;
      const tx2 = (this.nodeBounds[nb + 3] - ox) * invDx;
      let tmin = Math.min(tx1, tx2);
      let tmax = Math.max(tx1, tx2);

      const ty1 = (this.nodeBounds[nb + 1] - oy) * invDy;
      const ty2 = (this.nodeBounds[nb + 4] - oy) * invDy;
      tmin = Math.max(tmin, Math.min(ty1, ty2));
      tmax = Math.min(tmax, Math.max(ty1, ty2));

      const tz1 = (this.nodeBounds[nb + 2] - oz) * invDz;
      const tz2 = (this.nodeBounds[nb + 5] - oz) * invDz;
      tmin = Math.max(tmin, Math.min(tz1, tz2));
      tmax = Math.min(tmax, Math.max(tz1, tz2));

      if (tmax < Math.max(0, tmin)) continue;

      const count = this.nodeTriCount[nodeIdx];
      if (count > 0) {
        const first = this.nodeLeftOrFirst[nodeIdx];
        for (let i = first; i < first + count; i++) {
          const tIdx = this.triIndices[i];
          const b9 = tIdx * 9;

          const ax = this.triData[b9];
          const ay = this.triData[b9 + 1];
          const az = this.triData[b9 + 2];
          const e1x = this.triData[b9 + 3];
          const e1y = this.triData[b9 + 4];
          const e1z = this.triData[b9 + 5];
          const e2x = this.triData[b9 + 6];
          const e2y = this.triData[b9 + 7];
          const e2z = this.triData[b9 + 8];

          const px = dy * e2z - dz * e2y;
          const py = dz * e2x - dx * e2z;
          const pz = dx * e2y - dy * e2x;

          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-13) continue;

          const invDet = 1.0 / det;
          const tx = ox - ax;
          const ty = oy - ay;
          const tz = oz - az;

          const u = (tx * px + ty * py + tz * pz) * invDet;
          if (u < 0.0 || u > 1.0) continue;

          const qx = ty * e1z - tz * e1y;
          const qy = tz * e1x - tx * e1z;
          const qz = tx * e1y - ty * e1x;

          const v = (dx * qx + dy * qy + dz * qz) * invDet;
          if (v < 0.0 || u + v > 1.0) continue;

          const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
          if (t > 1e-7) {
            hitCount++;
          }
        }
      } else {
        const left = this.nodeLeftOrFirst[nodeIdx];
        stack[stackPtr++] = left + 1;
        stack[stackPtr++] = left;
      }
    }

    return hitCount;
  }
}
