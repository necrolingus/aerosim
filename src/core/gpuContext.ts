import type { GPUCapabilitiesReport, GridResolution, TunnelDimensions } from './types';

/**
 * Bytes required per lattice cell in a D3Q19 Lattice Boltzmann + sub-grid wall + macroscopic solver:
 * - Ping-pong distribution functions f_A and f_B: 19 * 2 * 4 bytes = 152 bytes
 * - Macroscopic fields (rho, ux, uy, uz, vorticity/Q, Cp): 6 * 4 bytes = 24 bytes
 * - Cell flags + sub-grid wall distances (q-values for 18 non-zero links packed in f16/u8 or boundary sparse buffer): ~40 bytes
 * Total safe allocation budget per cell: ~216 bytes
 */
export const BYTES_PER_LBM_CELL = 216;

/**
 * Calculates the maximum safe 3D grid resolution (nx, ny, nz) that fits within
 * both the GPU's `maxStorageBufferBindingSize` (for a single 19-component f32 buffer)
 * and a target VRAM budget, preserving the wind tunnel's aspect ratio.
 */
export function calculateSafeGridResolution(
  maxStorageBufferBindingSize: number,
  maxBufferSize: number,
  tunnel: TunnelDimensions,
  targetMaxCells: number
): GridResolution {
  // A single D3Q19 ping or pong buffer is 19 * 4 = 76 bytes per cell.
  const singlePingBufferBytesPerCell = 19 * 4;
  const hardwareMaxCells = Math.floor(
    Math.min(maxStorageBufferBindingSize, maxBufferSize) / singlePingBufferBytesPerCell
  );

  const safeCells = Math.max(32 * 16 * 16, Math.min(hardwareMaxCells * 0.85, targetMaxCells));

  const lx = Math.max(0.1, tunnel.length);
  const ly = Math.max(0.1, tunnel.height);
  const lz = Math.max(0.1, tunnel.width);

  // nx * ny * nz = safeCells, with nx/lx = ny/ly = nz/lz = 1 / dx
  const cellPitch = Math.cbrt((lx * ly * lz) / safeCells);

  // Align dimensions to multiples of 8 for optimal WebGPU compute workgroup dispatch (8x4x4 or 8x8x1)
  const align8 = (n: number, minVal: number) => Math.max(minVal, Math.floor(n / 8) * 8);

  let ny = align8(Math.round(ly / cellPitch), 32);
  const h = ly / ny;
  let nx = align8(Math.round(lx / h), 64);
  let nz = align8(Math.round(lz / h), 32);

  // Ensure single buffer doesn't exceed binding limit
  while (nx * ny * nz * singlePingBufferBytesPerCell > Math.min(maxStorageBufferBindingSize, maxBufferSize) * 0.9) {
    ny = Math.max(32, ny - 8);
    const newH = ly / ny;
    nx = Math.max(64, Math.floor((lx / newH) / 8) * 8);
    nz = Math.max(32, Math.floor((lz / newH) / 8) * 8);
  }

  const totalCells = nx * ny * nz;
  const estimatedVramMB = Number(((totalCells * BYTES_PER_LBM_CELL) / (1024 * 1024)).toFixed(1));

  return { nx, ny, nz, totalCells, estimatedVramMB };
}

export class WebGPUContextManager {
  private device: GPUDevice | null = null;
  private adapter: GPUAdapter | null = null;
  private report: GPUCapabilitiesReport | null = null;

  public async initialize(tunnel: TunnelDimensions): Promise<GPUCapabilitiesReport> {
    const defaultInteractive = calculateSafeGridResolution(
      128 * 1024 * 1024,
      256 * 1024 * 1024,
      tunnel,
      192 * 96 * 96 // ~1.76M cells for 60 FPS interactive mode
    );
    const defaultHighPrecision = calculateSafeGridResolution(
      512 * 1024 * 1024,
      1024 * 1024 * 1024,
      tunnel,
      384 * 192 * 192 // ~14.1M cells for high-precision convergence mode
    );

    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      this.report = {
        supported: false,
        adapterName: 'WebGPU Unavailable (Fallback Preview Mode)',
        architecture: 'CPU / WebGL2 Stage',
        maxBufferSize: 256 * 1024 * 1024,
        maxStorageBufferBindingSize: 128 * 1024 * 1024,
        maxComputeWorkgroupSizeX: 256,
        interactiveGrid: defaultInteractive,
        highPrecisionGrid: defaultHighPrecision,
        reasonIfUnsupported:
          'navigator.gpu is not available in this browser or context. Use Chrome/Edge 113+ or Firefox Nightly with WebGPU enabled.',
      };
      return this.report;
    }

    try {
      this.adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance',
      });

      if (!this.adapter) {
        this.report = {
          supported: false,
          adapterName: 'No Compatible GPU Adapter',
          architecture: 'Unknown',
          maxBufferSize: 256 * 1024 * 1024,
          maxStorageBufferBindingSize: 128 * 1024 * 1024,
          maxComputeWorkgroupSizeX: 256,
          interactiveGrid: defaultInteractive,
          highPrecisionGrid: defaultHighPrecision,
          reasonIfUnsupported: 'WebGPU adapter request returned null.',
        };
        return this.report;
      }

      const limits = this.adapter.limits;
      const requestedMaxBufferSize = Math.min(limits.maxBufferSize, 1024 * 1024 * 1024);
      const requestedMaxStorageBinding = Math.min(limits.maxStorageBufferBindingSize, 1024 * 1024 * 1024);

      this.device = await this.adapter.requestDevice({
        requiredLimits: {
          maxBufferSize: requestedMaxBufferSize,
          maxStorageBufferBindingSize: requestedMaxStorageBinding,
          maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX,
        },
      });

      const info = this.adapter.info;
      const adapterName = info?.description || info?.device || info?.vendor || 'WebGPU Hardware Adapter';
      const architecture = info?.architecture || info?.vendor || 'Discrete/Integrated GPU';

      const interactiveGrid = calculateSafeGridResolution(
        this.device.limits.maxStorageBufferBindingSize,
        this.device.limits.maxBufferSize,
        tunnel,
        160 * 80 * 80 // ~1.02M cells @ 60 FPS
      );

      const highPrecisionGrid = calculateSafeGridResolution(
        this.device.limits.maxStorageBufferBindingSize,
        this.device.limits.maxBufferSize,
        tunnel,
        352 * 176 * 176 // ~10.9M cells for high-precision convergence
      );

      this.report = {
        supported: true,
        adapterName,
        architecture,
        maxBufferSize: this.device.limits.maxBufferSize,
        maxStorageBufferBindingSize: this.device.limits.maxStorageBufferBindingSize,
        maxComputeWorkgroupSizeX: this.device.limits.maxComputeWorkgroupSizeX,
        interactiveGrid,
        highPrecisionGrid,
      };

      return this.report;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.report = {
        supported: false,
        adapterName: 'WebGPU Initialization Error',
        architecture: 'Unknown',
        maxBufferSize: 256 * 1024 * 1024,
        maxStorageBufferBindingSize: 128 * 1024 * 1024,
        maxComputeWorkgroupSizeX: 256,
        interactiveGrid: defaultInteractive,
        highPrecisionGrid: defaultHighPrecision,
        reasonIfUnsupported: message,
      };
      return this.report;
    }
  }

  public recalculateGrids(tunnel: TunnelDimensions): {
    interactiveGrid: GridResolution;
    highPrecisionGrid: GridResolution;
  } {
    const maxStorage = this.report?.maxStorageBufferBindingSize ?? 128 * 1024 * 1024;
    const maxBuffer = this.report?.maxBufferSize ?? 256 * 1024 * 1024;

    const interactiveGrid = calculateSafeGridResolution(maxStorage, maxBuffer, tunnel, 160 * 80 * 80);
    const highPrecisionGrid = calculateSafeGridResolution(maxStorage, maxBuffer, tunnel, 352 * 176 * 176);

    if (this.report) {
      this.report.interactiveGrid = interactiveGrid;
      this.report.highPrecisionGrid = highPrecisionGrid;
    }
    return { interactiveGrid, highPrecisionGrid };
  }

  public getDevice(): GPUDevice | null {
    return this.device;
  }

  public getReport(): GPUCapabilitiesReport | null {
    return this.report;
  }
}

export const gpuContext = new WebGPUContextManager();
