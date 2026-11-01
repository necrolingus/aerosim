import initShaderWgsl from './shaders/init.wgsl?raw';
import collideStreamWgsl from './shaders/collideStream.wgsl?raw';
import boundaryWgsl from './shaders/boundary.wgsl?raw';
import postProcessWgsl from './shaders/postProcess.wgsl?raw';
import forcesWgsl from './shaders/forces.wgsl?raw';
import { D3Q19_COMMON_WGSL, LBM_CONSTANTS } from './lbmConstants';
import type { VoxelGridResult } from '../geometry/voxelizer';
import { LBMCpuReferenceSolver, type SliceAxis, type SliceFieldMode } from './lbmCpuReference';
import {
  computeNormalizedForceCoefficients,
  ForceConvergenceTracker,
  integrateLatticeMomentumExchange,
  type AerodynamicForceReadout,
} from './forceIntegrator';
import { FLUID_PRESETS, type FluidPreset, type TunnelDimensions, type Vector3D } from '../core/types';

export interface LBMSolverConfig {
  uInletLattice: number; // Lattice velocity (typically 0.075 - 0.10 for incompressible Mach < 0.2)
  nuLattice: number;     // Lattice kinematic viscosity nu_lat = U_lat * L_lat / Re
  smagorinskyCs: number; // Smagorinsky LES sub-grid constant (0.10 - 0.14)
  groundNoSlip: boolean;
  sliceAxis: SliceAxis;
  sliceFraction: number; // 0..1
  fieldMode: SliceFieldMode;
  windSpeedMps: number;
  fluid: FluidPreset;
  trueSurfaceAreaM2: number;
  frontalAreaM2: number;
  characteristicLengthM: number;
  boundingBoxSize: Vector3D;
  tunnel: TunnelDimensions;
}

/**
 * Orchestrates the Phase 3 & Phase 4 3D Lattice Boltzmann (D3Q19) Fluid Solver on WebGPU
 * + Galilean-Invariant Momentum-Exchange Force Integrator (`forces.wgsl`),
 * with automatic fallback to `LBMCpuReferenceSolver` if WebGPU compute is unavailable.
 */
export class LBMEngine {
  private device: GPUDevice | null;
  private voxel: VoxelGridResult | null = null;
  private config: LBMSolverConfig = {
    uInletLattice: 0.085,
    nuLattice: 0.0005,
    smagorinskyCs: LBM_CONSTANTS.DEFAULT_SMAGORINSKY_CS,
    groundNoSlip: false,
    sliceAxis: 'z',
    sliceFraction: 0.5,
    fieldMode: 'vorticity',
    windSpeedMps: 25.0,
    fluid: { ...FLUID_PRESETS.air_20c },
    trueSurfaceAreaM2: Math.PI,
    frontalAreaM2: Math.PI * 0.25,
    characteristicLengthM: 1.0,
    boundingBoxSize: { x: 1, y: 1, z: 1 },
    tunnel: { length: 6.0, width: 2.8, height: 2.4 },
  };

  private stepCount = 0;
  private isBusy = false;
  private forceTracker = new ForceConvergenceTracker();
  private totalCutFaceLinks = 100;

  // WebGPU Pipelines & Buffers
  private initPipeline: GPUComputePipeline | null = null;
  private collidePipeline: GPUComputePipeline | null = null;
  private boundaryPipeline: GPUComputePipeline | null = null;
  private postProcessPipeline: GPUComputePipeline | null = null;
  private forcesPipeline: GPUComputePipeline | null = null;

  private paramsBuffer: GPUBuffer | null = null;
  private forceParamsBuffer: GPUBuffer | null = null;
  private cellFlagsBuffer: GPUBuffer | null = null;
  private fBufferA: GPUBuffer | null = null;
  private fBufferB: GPUBuffer | null = null;
  private macroBuffer: GPUBuffer | null = null;
  private macroReadbackBuffer: GPUBuffer | null = null;
  private boundaryMapBuffer: GPUBuffer | null = null;
  private boundaryIndicesBuffer: GPUBuffer | null = null;
  private boundaryQBuffer: GPUBuffer | null = null;
  private forceMomentsBuffer: GPUBuffer | null = null;
  private forceReadbackBuffer: GPUBuffer | null = null;
  private sliceRgbaBuffer: GPUBuffer | null = null;
  private sliceReadbackBuffer: GPUBuffer | null = null;

  private pingPong = 0; // 0: A->B, 1: B->A
  private allocatedTotalCells = 0;

  // CPU Fallback / Reference Solver
  private cpuSolver: LBMCpuReferenceSolver | null = null;

  constructor(device: GPUDevice | null) {
    this.device = device;
    if (this.device) {
      this.compilePipelines(this.device);
    }
  }

  private compilePipelines(device: GPUDevice): void {
    const initMod = device.createShaderModule({ code: D3Q19_COMMON_WGSL + '\n' + initShaderWgsl });
    const collideMod = device.createShaderModule({ code: D3Q19_COMMON_WGSL + '\n' + collideStreamWgsl });
    const boundaryMod = device.createShaderModule({ code: D3Q19_COMMON_WGSL + '\n' + boundaryWgsl });
    const postMod = device.createShaderModule({ code: postProcessWgsl });
    const forcesMod = device.createShaderModule({ code: D3Q19_COMMON_WGSL + '\n' + forcesWgsl });

    this.initPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: initMod, entryPoint: 'main' },
    });
    this.collidePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: collideMod, entryPoint: 'main' },
    });
    this.boundaryPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: boundaryMod, entryPoint: 'main' },
    });
    this.postProcessPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: postMod, entryPoint: 'main' },
    });
    this.forcesPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: forcesMod, entryPoint: 'main' },
    });
  }

  private countCutFaceLinks(voxel: VoxelGridResult): number {
    let count = 0;
    const { boundaryCellCount, boundaryQValues } = voxel;
    for (let b = 0; b < boundaryCellCount; b++) {
      const qBase = b * 18;
      for (let d = 1; d <= 6; d++) {
        if (boundaryQValues[qBase + (d - 1)] > 0) {
          count++;
        }
      }
    }
    return Math.max(1, count);
  }

  public setVoxelGrid(voxel: VoxelGridResult, config: Partial<LBMSolverConfig>, resetFlow = true): void {
    this.voxel = voxel;
    Object.assign(this.config, config);
    this.totalCutFaceLinks = this.countCutFaceLinks(voxel);
    this.forceTracker.reset(60);

    if (!this.device) {
      if (!this.cpuSolver || resetFlow || this.cpuSolver.totalCells !== voxel.nx * voxel.ny * voxel.nz) {
        this.cpuSolver = new LBMCpuReferenceSolver(voxel, {
          uInlet: this.config.uInletLattice,
          nuLattice: this.config.nuLattice,
          smagorinskyCs: this.config.smagorinskyCs,
          groundNoSlip: this.config.groundNoSlip,
        });
      } else {
        this.cpuSolver.updateVoxelGrid(voxel);
      }
      return;
    }

    const totalCells = voxel.nx * voxel.ny * voxel.nz;
    const needsRealloc = totalCells !== this.allocatedTotalCells || !this.fBufferA;

    if (needsRealloc) {
      this.destroyBuffers();
      this.allocatedTotalCells = totalCells;

      this.paramsBuffer = this.device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      this.forceParamsBuffer = this.device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      this.cellFlagsBuffer = this.device.createBuffer({
        size: totalCells * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      const fBytes = totalCells * 19 * 4;
      this.fBufferA = this.device.createBuffer({
        size: fBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.fBufferB = this.device.createBuffer({
        size: fBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      this.macroBuffer = this.device.createBuffer({
        size: totalCells * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      this.macroReadbackBuffer = this.device.createBuffer({
        size: totalCells * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      const maxSlicePixels = Math.max(voxel.nx * voxel.ny, voxel.nx * voxel.nz, voxel.ny * voxel.nz);
      this.sliceRgbaBuffer = this.device.createBuffer({
        size: maxSlicePixels * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      this.sliceReadbackBuffer = this.device.createBuffer({
        size: maxSlicePixels * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      const maxBoundaryCells = Math.max(2048, Math.ceil(totalCells * 0.35));
      const maxForceBytes = maxBoundaryCells * 32;
      this.forceMomentsBuffer = this.device.createBuffer({
        size: maxForceBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      this.forceReadbackBuffer = this.device.createBuffer({
        size: maxForceBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    }

    // Upload cellFlags as u32 array
    const flagsU32 = new Uint32Array(totalCells);
    for (let i = 0; i < totalCells; i++) {
      flagsU32[i] = voxel.cellFlags[i];
    }
    this.device.queue.writeBuffer(this.cellFlagsBuffer!, 0, flagsU32.buffer);

    // Upload boundaryIndexMap, boundaryCellIndices, and boundaryQValues buffers
    this.boundaryMapBuffer?.destroy();
    this.boundaryIndicesBuffer?.destroy();
    this.boundaryQBuffer?.destroy();

    this.boundaryMapBuffer = this.device.createBuffer({
      size: Math.max(16, voxel.boundaryIndexMap.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(
      this.boundaryMapBuffer,
      0,
      voxel.boundaryIndexMap.buffer as ArrayBuffer,
      voxel.boundaryIndexMap.byteOffset,
      voxel.boundaryIndexMap.byteLength
    );

    const bIndicesByteLen = Math.max(16, voxel.boundaryCellIndices.byteLength);
    this.boundaryIndicesBuffer = this.device.createBuffer({
      size: bIndicesByteLen,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (voxel.boundaryCellIndices.length > 0) {
      this.device.queue.writeBuffer(
        this.boundaryIndicesBuffer,
        0,
        voxel.boundaryCellIndices.buffer as ArrayBuffer,
        voxel.boundaryCellIndices.byteOffset,
        voxel.boundaryCellIndices.byteLength
      );
    }

    const qByteLen = Math.max(16, voxel.boundaryQValues.byteLength);
    this.boundaryQBuffer = this.device.createBuffer({
      size: qByteLen,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (voxel.boundaryQValues.length > 0) {
      this.device.queue.writeBuffer(
        this.boundaryQBuffer,
        0,
        voxel.boundaryQValues.buffer as ArrayBuffer,
        voxel.boundaryQValues.byteOffset,
        voxel.boundaryQValues.byteLength
      );
    }

    if (resetFlow || needsRealloc) {
      this.stepCount = 0;
      this.pingPong = 0;
      this.uploadUniformParams();
      this.dispatchInitPass();
    } else {
      this.uploadUniformParams();
    }
  }

  public updateConfig(config: Partial<LBMSolverConfig>): void {
    Object.assign(this.config, config);
    if (this.cpuSolver) {
      this.cpuSolver.uInlet = this.config.uInletLattice;
      this.cpuSolver.nuLattice = this.config.nuLattice;
      this.cpuSolver.smagorinskyCs = this.config.smagorinskyCs;
      this.cpuSolver.groundNoSlip = this.config.groundNoSlip;
    }
    if (this.device && this.voxel) {
      this.uploadUniformParams();
    }
  }

  private getSliceDimensions(): { width: number; height: number; sliceIndex: number; axisCode: number } {
    if (!this.voxel) return { width: 1, height: 1, sliceIndex: 0, axisCode: 0 };
    const { nx, ny, nz } = this.voxel;
    const frac = Math.max(0, Math.min(1, this.config.sliceFraction));

    if (this.config.sliceAxis === 'y') {
      return {
        width: nx,
        height: nz,
        sliceIndex: Math.min(ny - 1, Math.floor(frac * ny)),
        axisCode: 1,
      };
    } else if (this.config.sliceAxis === 'x') {
      return {
        width: nz,
        height: ny,
        sliceIndex: Math.min(nx - 1, Math.floor(frac * nx)),
        axisCode: 2,
      };
    }
    return {
      width: nx,
      height: ny,
      sliceIndex: Math.min(nz - 1, Math.floor(frac * nz)),
      axisCode: 0,
    };
  }

  private uploadUniformParams(): void {
    if (!this.device || !this.paramsBuffer || !this.forceParamsBuffer || !this.voxel) return;
    const { nx, ny, nz, dx, dy, dz, originX, originY, originZ, boundaryCellCount } = this.voxel;
    const totalCells = nx * ny * nz;
    const { sliceIndex, axisCode } = this.getSliceDimensions();
    const fieldCode = this.config.fieldMode === 'velocity' ? 0 : this.config.fieldMode === 'vorticity' ? 1 : 2;

    const buf = new ArrayBuffer(48);
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);

    u32[0] = nx;
    u32[1] = ny;
    u32[2] = nz;
    u32[3] = totalCells;
    f32[4] = this.config.uInletLattice;
    f32[5] = this.config.nuLattice;
    f32[6] = this.config.smagorinskyCs;
    u32[7] = this.config.groundNoSlip ? 1 : 0;
    u32[8] = this.stepCount;
    u32[9] = axisCode;
    u32[10] = sliceIndex;
    u32[11] = fieldCode;

    this.device.queue.writeBuffer(this.paramsBuffer, 0, buf);

    const fBuf = new ArrayBuffer(48);
    const fu32 = new Uint32Array(fBuf);
    const ff32 = new Float32Array(fBuf);
    fu32[0] = nx;
    fu32[1] = ny;
    fu32[2] = nz;
    fu32[3] = totalCells;
    fu32[4] = boundaryCellCount;
    ff32[5] = dx;
    ff32[6] = dy;
    ff32[7] = dz;
    ff32[8] = originX;
    ff32[9] = originY;
    ff32[10] = originZ;
    ff32[11] = 1.0;

    this.device.queue.writeBuffer(this.forceParamsBuffer, 0, fBuf);
  }

  private dispatchInitPass(): void {
    if (!this.device || !this.initPipeline || !this.voxel) return;
    const totalCells = this.voxel.nx * this.voxel.ny * this.voxel.nz;

    const bindGroup = this.device.createBindGroup({
      layout: this.initPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer! } },
        { binding: 1, resource: { buffer: this.cellFlagsBuffer! } },
        { binding: 2, resource: { buffer: this.fBufferA! } },
        { binding: 3, resource: { buffer: this.fBufferB! } },
        { binding: 4, resource: { buffer: this.macroBuffer! } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.initPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(totalCells / 64));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Advances the 3D LBM simulation by `substeps` iterations and returns both the updated 2D slice RGBA8 pixels
   * and the integrated AerodynamicForceReadout (Cd, Cl, Drag Newtons/lbs, Pitching Moment, Convergence state).
   */
  public async stepAndExtractSlice(
    substeps = 4,
    readMacroField = false
  ): Promise<{
    width: number;
    height: number;
    rgba: Uint8Array;
    stepCount: number;
    forceReadout: AerodynamicForceReadout;
    macroField?: {
      ux: Float32Array;
      uy: Float32Array;
      uz: Float32Array;
      rho: Float32Array;
    };
  } | null> {
    if (!this.voxel || this.isBusy) return null;

    if (
      !this.device ||
      !this.collidePipeline ||
      !this.boundaryPipeline ||
      !this.postProcessPipeline ||
      !this.forcesPipeline
    ) {
      if (!this.cpuSolver) return null;
      this.cpuSolver.step(substeps);
      this.stepCount = this.cpuSolver.stepIndex;
      const slice = this.cpuSolver.extractSliceRGBA(
        this.config.sliceAxis,
        this.config.sliceFraction,
        this.config.fieldMode
      );

      const forces = integrateLatticeMomentumExchange({
        voxel: this.voxel,
        fPreStream: this.cpuSolver.fDst,
        fPostBoundary: this.cpuSolver.fSrc,
        ux: this.cpuSolver.ux,
        uy: this.cpuSolver.uy,
        uz: this.cpuSolver.uz,
        rho: this.cpuSolver.rho,
        uInletLattice: this.config.uInletLattice,
        nuLattice: this.config.nuLattice,
        trueSurfaceAreaM2: this.config.trueSurfaceAreaM2,
        frontalAreaM2: this.config.frontalAreaM2,
        characteristicLengthM: this.config.characteristicLengthM,
        boundingBoxSize: this.config.boundingBoxSize,
        tunnel: this.config.tunnel,
      });

      const forceReadout = this.forceTracker.pushSample({
        step: this.stepCount,
        cd: forces.cdCorrected,
        cl: forces.cl,
        cm: forces.cmPitch,
        xcp: forces.centerOfPressureX,
        windSpeed: this.config.windSpeedMps,
        fluid: this.config.fluid,
        frontalAreaM2: this.config.frontalAreaM2,
      });

      const macroField = readMacroField
        ? {
            ux: this.cpuSolver.ux,
            uy: this.cpuSolver.uy,
            uz: this.cpuSolver.uz,
            rho: this.cpuSolver.rho,
          }
        : undefined;

      return { ...slice, stepCount: this.stepCount, forceReadout, macroField };
    }

    this.isBusy = true;
    try {
      const totalCells = this.voxel.nx * this.voxel.ny * this.voxel.nz;
      const workgroups = Math.ceil(totalCells / 64);

      for (let s = 0; s < substeps; s++) {
        this.uploadUniformParams();

        const srcBuf = this.pingPong === 0 ? this.fBufferA! : this.fBufferB!;
        const dstBuf = this.pingPong === 0 ? this.fBufferB! : this.fBufferA!;

        const collideBG = this.device.createBindGroup({
          layout: this.collidePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.paramsBuffer! } },
            { binding: 1, resource: { buffer: this.cellFlagsBuffer! } },
            { binding: 2, resource: { buffer: srcBuf } },
            { binding: 3, resource: { buffer: dstBuf } },
            { binding: 4, resource: { buffer: this.macroBuffer! } },
            { binding: 5, resource: { buffer: this.boundaryMapBuffer! } },
            { binding: 6, resource: { buffer: this.boundaryQBuffer! } },
          ],
        });

        const boundaryBG = this.device.createBindGroup({
          layout: this.boundaryPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.paramsBuffer! } },
            { binding: 1, resource: { buffer: this.cellFlagsBuffer! } },
            { binding: 3, resource: { buffer: dstBuf } },
            { binding: 4, resource: { buffer: this.macroBuffer! } },
          ],
        });

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.collidePipeline);
        pass.setBindGroup(0, collideBG);
        pass.dispatchWorkgroups(workgroups);

        pass.setPipeline(this.boundaryPipeline);
        pass.setBindGroup(0, boundaryBG);
        pass.dispatchWorkgroups(workgroups);
        pass.end();

        this.device.queue.submit([encoder.finish()]);

        this.pingPong = 1 - this.pingPong;
        this.stepCount++;
      }

      // Dispatch Post-Process Slice Extraction & GPU Momentum-Exchange Force Reduction
      const { width, height } = this.getSliceDimensions();
      const slicePixels = width * height;
      const sliceBytes = slicePixels * 4;

      const postBG = this.device.createBindGroup({
        layout: this.postProcessPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.paramsBuffer! } },
          { binding: 1, resource: { buffer: this.cellFlagsBuffer! } },
          { binding: 4, resource: { buffer: this.macroBuffer! } },
          { binding: 7, resource: { buffer: this.sliceRgbaBuffer! } },
        ],
      });

      const boundaryCellCount = this.voxel.boundaryCellCount;
      const forceBytes = Math.max(32, boundaryCellCount * 32);
      const postStepSrcBuf = this.pingPong === 0 ? this.fBufferA! : this.fBufferB!;

      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.postProcessPipeline);
      pass.setBindGroup(0, postBG);
      pass.dispatchWorkgroups(Math.ceil(slicePixels / 64));

      if (boundaryCellCount > 0) {
        const forceBG = this.device.createBindGroup({
          layout: this.forcesPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.forceParamsBuffer! } },
            { binding: 1, resource: { buffer: postStepSrcBuf } },
            { binding: 2, resource: { buffer: this.boundaryIndicesBuffer! } },
            { binding: 3, resource: { buffer: this.boundaryQBuffer! } },
            { binding: 4, resource: { buffer: this.forceMomentsBuffer! } },
          ],
        });
        pass.setPipeline(this.forcesPipeline);
        pass.setBindGroup(0, forceBG);
        pass.dispatchWorkgroups(Math.ceil(boundaryCellCount / 64));
      }
      pass.end();

      encoder.copyBufferToBuffer(this.sliceRgbaBuffer!, 0, this.sliceReadbackBuffer!, 0, sliceBytes);
      if (boundaryCellCount > 0) {
        encoder.copyBufferToBuffer(this.forceMomentsBuffer!, 0, this.forceReadbackBuffer!, 0, forceBytes);
      }
      const macroBytes = totalCells * 16;
      if (readMacroField && this.macroBuffer && this.macroReadbackBuffer) {
        encoder.copyBufferToBuffer(this.macroBuffer, 0, this.macroReadbackBuffer, 0, macroBytes);
      }
      this.device.queue.submit([encoder.finish()]);

      await Promise.all([
        this.sliceReadbackBuffer!.mapAsync(GPUMapMode.READ, 0, sliceBytes),
        boundaryCellCount > 0
          ? this.forceReadbackBuffer!.mapAsync(GPUMapMode.READ, 0, forceBytes)
          : Promise.resolve(),
        readMacroField && this.macroReadbackBuffer
          ? this.macroReadbackBuffer.mapAsync(GPUMapMode.READ, 0, macroBytes)
          : Promise.resolve(),
      ]);

      const mappedSlice = this.sliceReadbackBuffer!.getMappedRange(0, sliceBytes);
      const rgba = new Uint8Array(sliceBytes);
      rgba.set(new Uint8Array(mappedSlice));
      this.sliceReadbackBuffer!.unmap();

      let macroField: { ux: Float32Array; uy: Float32Array; uz: Float32Array; rho: Float32Array } | undefined = undefined;
      if (readMacroField && this.macroReadbackBuffer) {
        const mappedMacro = new Float32Array(this.macroReadbackBuffer.getMappedRange(0, macroBytes));
        const ux = new Float32Array(totalCells);
        const uy = new Float32Array(totalCells);
        const uz = new Float32Array(totalCells);
        const rho = new Float32Array(totalCells);
        for (let i = 0; i < totalCells; i++) {
          const b = i * 4;
          ux[i] = mappedMacro[b];
          uy[i] = mappedMacro[b + 1];
          uz[i] = mappedMacro[b + 2];
          rho[i] = mappedMacro[b + 3];
        }
        this.macroReadbackBuffer.unmap();
        macroField = { ux, uy, uz, rho };
      }

      let fxLat = 0;
      let fyLat = 0;
      let fzLat = 0;
      let mzLat = 0;

      if (boundaryCellCount > 0) {
        const mappedForce = new Float32Array(this.forceReadbackBuffer!.getMappedRange(0, forceBytes));
        for (let b = 0; b < boundaryCellCount; b++) {
          const base = b * 8;
          fxLat += mappedForce[base];
          fyLat += mappedForce[base + 1];
          fzLat += mappedForce[base + 2];
          mzLat += mappedForce[base + 6];
        }
        this.forceReadbackBuffer!.unmap();
      }

      const normForces = computeNormalizedForceCoefficients({
        fxLat,
        fyLat,
        fzLat,
        mzLat,
        totalCutFaceLinks: this.totalCutFaceLinks,
        voxel: this.voxel,
        uInletLattice: this.config.uInletLattice,
        nuLattice: this.config.nuLattice,
        trueSurfaceAreaM2: this.config.trueSurfaceAreaM2,
        frontalAreaM2: this.config.frontalAreaM2,
        characteristicLengthM: this.config.characteristicLengthM,
        boundingBoxSize: this.config.boundingBoxSize,
        tunnel: this.config.tunnel,
      });

      const forceReadout = this.forceTracker.pushSample({
        step: this.stepCount,
        cd: normForces.cdCorrected,
        cl: normForces.cl,
        cm: normForces.cmPitch,
        xcp: normForces.centerOfPressureX,
        windSpeed: this.config.windSpeedMps,
        fluid: this.config.fluid,
        frontalAreaM2: this.config.frontalAreaM2,
      });

      return { width, height, rgba, stepCount: this.stepCount, forceReadout, macroField };
    } finally {
      this.isBusy = false;
    }
  }

  public resetFlow(): void {
    this.stepCount = 0;
    this.pingPong = 0;
    this.forceTracker.reset(60);
    if (this.cpuSolver) {
      this.cpuSolver.resetEquilibrium();
    }
    if (this.device && this.voxel) {
      this.uploadUniformParams();
      this.dispatchInitPass();
    }
  }

  public getStepCount(): number {
    return this.stepCount;
  }

  private destroyBuffers(): void {
    this.paramsBuffer?.destroy();
    this.forceParamsBuffer?.destroy();
    this.cellFlagsBuffer?.destroy();
    this.fBufferA?.destroy();
    this.fBufferB?.destroy();
    this.macroBuffer?.destroy();
    this.macroReadbackBuffer?.destroy();
    this.boundaryMapBuffer?.destroy();
    this.boundaryIndicesBuffer?.destroy();
    this.boundaryQBuffer?.destroy();
    this.forceMomentsBuffer?.destroy();
    this.forceReadbackBuffer?.destroy();
    this.sliceRgbaBuffer?.destroy();
    this.sliceReadbackBuffer?.destroy();
  }
}
