import * as THREE from 'three';
import type { MeshStats, ModelTransform } from '../core/types';
import { computeProjectedFrontalArea } from './frontalArea';

/**
 * Parses an ArrayBuffer containing either a Binary STL or ASCII STL file
 * and returns a centered, normals-computed THREE.BufferGeometry.
 */
export function parseSTL(buffer: ArrayBuffer): THREE.BufferGeometry {
  if (buffer.byteLength < 84) {
    return parseAsciiSTL(new TextDecoder().decode(buffer));
  }

  const view = new DataView(buffer);
  const faceCount = view.getUint32(80, true);
  const expectedByteLength = 84 + faceCount * 50;

  // Check if file size matches binary STL specification
  if (expectedByteLength === buffer.byteLength) {
    return parseBinarySTL(view, faceCount);
  }

  // Otherwise check if it starts with 'solid' and is ASCII
  const headerText = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(256, buffer.byteLength)));
  if (headerText.trimStart().toLowerCase().startsWith('solid')) {
    const fullText = new TextDecoder().decode(buffer);
    if (fullText.includes('facet') && fullText.includes('vertex')) {
      return parseAsciiSTL(fullText);
    }
  }

  // Fallback to binary if faceCount fits within buffer
  if (expectedByteLength <= buffer.byteLength && faceCount > 0) {
    return parseBinarySTL(view, faceCount);
  }

  throw new Error('Invalid or corrupted STL file.');
}

function parseBinarySTL(view: DataView, faceCount: number): THREE.BufferGeometry {
  const positions = new Float32Array(faceCount * 9);
  const normals = new Float32Array(faceCount * 9);

  let offset = 84;
  for (let i = 0; i < faceCount; i++) {
    const nx = view.getFloat32(offset, true);
    const ny = view.getFloat32(offset + 4, true);
    const nz = view.getFloat32(offset + 8, true);
    offset += 12;

    const baseIdx = i * 9;
    for (let v = 0; v < 3; v++) {
      const vx = view.getFloat32(offset, true);
      const vy = view.getFloat32(offset + 4, true);
      const vz = view.getFloat32(offset + 8, true);
      offset += 12;

      const vIdx = baseIdx + v * 3;
      positions[vIdx] = vx;
      positions[vIdx + 1] = vy;
      positions[vIdx + 2] = vz;

      normals[vIdx] = nx;
      normals[vIdx + 1] = ny;
      normals[vIdx + 2] = nz;
    }

    offset += 2; // 2-byte attribute byte count
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function parseAsciiSTL(text: string): THREE.BufferGeometry {
  const positions: number[] = [];
  const vertexRegex = /vertex\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/g;

  let match: RegExpExecArray | null;
  while ((match = vertexRegex.exec(text)) !== null) {
    positions.push(parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]));
  }

  if (positions.length < 9 || positions.length % 9 !== 0) {
    throw new Error('ASCII STL file contains no valid triangles.');
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Centers a geometry around the origin (0,0,0) and optionally normalizes its scale
 * if it was exported in millimeters (e.g. > 10m bounding box) so it fits naturally inside the wind tunnel.
 */
export function normalizeAndCenterGeometry(geometry: THREE.BufferGeometry): {
  geometry: THREE.BufferGeometry;
  autoScaledFromMm: boolean;
} {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const center = new THREE.Vector3();
  box.getCenter(center);
  geometry.translate(-center.x, -center.y, -center.z);

  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);

  let autoScaledFromMm = false;
  // STL files from CAD/3D printing slicers (Fusion360, SolidWorks, OpenSCAD) are almost always in millimeters.
  // If maxDim > 10 units, convert mm -> meters (scale by 0.001), or if still tiny/huge, normalize to ~1.0m.
  if (maxDim > 10.0) {
    const scaleFactor = maxDim > 50 ? 0.001 : 1.0 / maxDim;
    geometry.scale(scaleFactor, scaleFactor, scaleFactor);
    autoScaledFromMm = true;
  }

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, autoScaledFromMm };
}

/**
 * Analyzes topological watertightness (manifold closed edges), signed volume,
 * transformed bounding box, characteristic streamwise length (L_ref), and exact frontal area (A_ref).
 */
export function computeMeshStats(
  geometry: THREE.BufferGeometry,
  name: string,
  transform: ModelTransform
): MeshStats {
  const posAttr = geometry.getAttribute('position');
  const indexAttr = geometry.getIndex();
  const triangleCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(posAttr.count / 3);

  // Build world transformation matrix from transform state
  const matrix = new THREE.Matrix4();
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(transform.rotationDeg.x),
    THREE.MathUtils.degToRad(transform.rotationDeg.y),
    THREE.MathUtils.degToRad(transform.rotationDeg.z),
    'XYZ'
  );
  const quaternion = new THREE.Quaternion().setFromEuler(euler);
  const posVec = new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z);
  const scaleVec = new THREE.Vector3(transform.scale.x, transform.scale.y, transform.scale.z);
  matrix.compose(posVec, quaternion, scaleVec);

  // Compute world-space bounding box & signed volume
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  let signedVolume6 = 0;

  // Watertightness check via quantized undirected edge map
  // Quantize vertex coordinates to 1e-5 to weld unindexed STL vertices
  const edgeCounts = new Map<string, number>();
  const quantize = (v: THREE.Vector3) =>
    `${Math.round(v.x * 1e5)},${Math.round(v.y * 1e5)},${Math.round(v.z * 1e5)}`;

  const addEdge = (a: string, b: string) => {
    if (a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  };

  for (let t = 0; t < triangleCount; t++) {
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

    v0.fromBufferAttribute(posAttr, i0);
    v1.fromBufferAttribute(posAttr, i1);
    v2.fromBufferAttribute(posAttr, i2);

    // Check watertightness on local geometry (for reasonable triangle counts <= 100k)
    if (triangleCount <= 100000) {
      const k0 = quantize(v0);
      const k1 = quantize(v1);
      const k2 = quantize(v2);
      addEdge(k0, k1);
      addEdge(k1, k2);
      addEdge(k2, k0);
    }

    // Transform to world space for physical dimensions and volume
    v0.applyMatrix4(matrix);
    v1.applyMatrix4(matrix);
    v2.applyMatrix4(matrix);

    min.min(v0).min(v1).min(v2);
    max.max(v0).max(v1).max(v2);

    // Signed volume of tetrahedron with origin: dot(v0, cross(v1, v2))
    signedVolume6 +=
      v0.x * (v1.y * v2.z - v1.z * v2.y) +
      v0.y * (v1.z * v2.x - v1.x * v2.z) +
      v0.z * (v1.x * v2.y - v1.y * v2.x);
  }

  let openEdgeCount = 0;
  for (const count of edgeCounts.values()) {
    if (count !== 2) {
      openEdgeCount++;
    }
  }

  const sizeX = Math.max(0, max.x - min.x);
  const sizeY = Math.max(0, max.y - min.y);
  const sizeZ = Math.max(0, max.z - min.z);

  const frontalArea = computeProjectedFrontalArea(geometry, matrix, 512);

  // Characteristic length L_ref: streamwise length along X (or hydraulic diameter for bluff bodies)
  const characteristicLength = Math.max(1e-4, sizeX);

  return {
    name,
    triangleCount,
    vertexCount: posAttr.count,
    isWatertight: openEdgeCount === 0 && triangleCount > 0,
    openEdgeCount,
    boundingBoxSize: { x: sizeX, y: sizeY, z: sizeZ },
    characteristicLength,
    frontalArea,
    volume: Math.abs(signedVolume6) / 6.0,
  };
}
