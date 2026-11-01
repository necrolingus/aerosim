import type {
  AerodynamicTelemetry,
  GPUCapabilitiesReport,
  MeshStats,
  SolverMode,
  VoxelTelemetry,
} from '../core/types';
import type { AerodynamicForceReadout } from '../solver/forceIntegrator';

export class TelemetryHudUI {
  private container: HTMLElement;
  private gpuReport: GPUCapabilitiesReport | null = null;
  private meshStats: MeshStats | null = null;
  private telemetry: AerodynamicTelemetry | null = null;
  private voxelTelemetry: VoxelTelemetry | null = null;
  private forceReadout: AerodynamicForceReadout | null = null;
  private solverMode: SolverMode = 'interactive';
  private groundPlaneEnabled = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  public updateGPU(report: GPUCapabilitiesReport): void {
    this.gpuReport = report;
    this.render();
  }

  public updateMeshAndTelemetry(
    stats: MeshStats,
    telemetry: AerodynamicTelemetry,
    solverMode: SolverMode,
    voxelTelemetry?: VoxelTelemetry,
    groundPlaneEnabled?: boolean
  ): void {
    this.meshStats = stats;
    this.telemetry = telemetry;
    this.solverMode = solverMode;
    if (groundPlaneEnabled !== undefined) {
      this.groundPlaneEnabled = groundPlaneEnabled;
    }
    if (voxelTelemetry) {
      this.voxelTelemetry = voxelTelemetry;
    }
    this.render();
  }

  public updateSolverSteps(
    stepCount: number,
    mlups: number,
    forceReadout?: AerodynamicForceReadout
  ): void {
    const stepEl = this.container.querySelector('#hud-solver-steps');
    const mlupsEl = this.container.querySelector('#hud-solver-mlups');
    if (stepEl) stepEl.textContent = `${stepCount.toLocaleString()} steps`;
    if (mlupsEl) mlupsEl.textContent = `${mlups.toFixed(1)} MLUPS`;

    if (forceReadout) {
      this.forceReadout = forceReadout;
      const cdEl = this.container.querySelector('#hud-cd-value');
      const cdSubEl = this.container.querySelector('#hud-cd-sub');
      const clEl = this.container.querySelector('#hud-cl-value');
      const clSubEl = this.container.querySelector('#hud-cl-sub');
      const dragForceEl = this.container.querySelector('#hud-drag-force');
      const dragSubEl = this.container.querySelector('#hud-drag-sub');

      if (cdEl) cdEl.innerHTML = `${forceReadout.meanCd.toFixed(3)} <small>±${forceReadout.stdCd.toFixed(3)}</small>`;
      if (cdSubEl) {
        cdSubEl.textContent = forceReadout.isConverged
          ? `✓ Converged (${forceReadout.stabilityPercent.toFixed(0)}% stable)`
          : `⟳ Averaging (${forceReadout.stabilityPercent.toFixed(0)}% stable)`;
      }
      if (clEl) {
        const sign = forceReadout.meanCl >= 0 ? '+' : '';
        clEl.innerHTML = `${sign}${forceReadout.meanCl.toFixed(3)} <small>C<sub>m</sub> ${forceReadout.pitchingMomentCm.toFixed(2)}</small>`;
      }
      if (clSubEl) {
        const liftSign = forceReadout.liftForceNewtons >= 0 ? '+' : '';
        const labelText = this.groundPlaneEnabled ? 'Roof Uplift' : 'Lift';
        clSubEl.textContent = `${labelText}: ${liftSign}${forceReadout.liftForceNewtons.toFixed(1)} N (${liftSign}${forceReadout.liftForceLbs.toFixed(1)} lbf)`;
      }
      if (dragForceEl) {
        dragForceEl.innerHTML = `${forceReadout.dragForceNewtons.toFixed(1)} <small>N</small>`;
      }
      if (dragSubEl) {
        dragSubEl.textContent = `${forceReadout.dragForceLbs.toFixed(1)} lbf · ${forceReadout.dragForceKgf.toFixed(1)} kgf`;
      }
    }
  }

  private formatSci(val: number): string {
    if (val === 0) return '0';
    if (val >= 1000 && val < 1e7) {
      return val.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }
    return val.toExponential(2);
  }

  private render(): void {
    const gpu = this.gpuReport;
    const stats = this.meshStats;
    const tel = this.telemetry;
    const frc = this.forceReadout;

    const activeGrid =
      this.solverMode === 'high_precision' ? gpu?.highPrecisionGrid : gpu?.interactiveGrid;

    const blockageWarning =
      tel && tel.blockageRatioPercent > 10.0
        ? `<span class="badge-warn" title="Blockage > 10% increases wall-interference speed-up. Maskell correction active.">⚠ Blockage ${tel.blockageRatioPercent.toFixed(1)}% (Corrected)</span>`
        : `<span class="badge-ok">Blockage ${tel ? tel.blockageRatioPercent.toFixed(1) : '0.0'}%</span>`;

    const watertightBadge = stats?.isWatertight
      ? `<span class="badge-ok">✓ Manifold Watertight</span>`
      : `<span class="badge-warn">⚠ ${stats?.openEdgeCount ?? 0} Open Edges</span>`;

    this.container.innerHTML = `
      <div class="telemetry-card">
        <div class="card-header">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="card-title">QUANTITATIVE AERODYNAMIC FORCES (MOMENTUM EXCHANGE)</span>
            ${this.groundPlaneEnabled ? '<span class="badge-ok" style="font-size:9.5px; padding:2px 6px;">🏡 Ground ABL</span>' : '<span class="badge-accent" style="font-size:9.5px; padding:2px 6px;">🚀 Freestream</span>'}
          </div>
          ${blockageWarning}
        </div>
        <div class="metrics-grid">
          <div class="metric-item highlight-amber">
            <span class="metric-label">Drag Coefficient (C<sub>d</sub>)</span>
            <span class="metric-value" id="hud-cd-value">${frc ? `${frc.meanCd.toFixed(3)} <small>±${frc.stdCd.toFixed(3)}</small>` : '0.470'}</span>
            <span class="metric-sub" id="hud-cd-sub">${frc ? (frc.isConverged ? `✓ Converged (${frc.stabilityPercent.toFixed(0)}% stable)` : `⟳ Averaging (${frc.stabilityPercent.toFixed(0)}% stable)`) : 'Maskell Blockage Corrected'}</span>
          </div>
          <div class="metric-item highlight-cyan">
            <span class="metric-label">Lift & Moment (C<sub>l</sub> / C<sub>m</sub>)</span>
            <span class="metric-value" id="hud-cl-value">${frc ? `${frc.meanCl >= 0 ? '+' : ''}${frc.meanCl.toFixed(3)} <small>C<sub>m</sub> ${frc.pitchingMomentCm.toFixed(2)}</small>` : '+0.000'}</span>
            <span class="metric-sub" id="hud-cl-sub">${frc ? `Lift: ${frc.liftForceNewtons >= 0 ? '+' : ''}${frc.liftForceNewtons.toFixed(1)} N (${frc.liftForceLbs.toFixed(1)} lbf)` : 'Lift / Roof Uplift Force'}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Physical Drag Force (F<sub>d</sub>)</span>
            <span class="metric-value" id="hud-drag-force">${frc ? `${frc.dragForceNewtons.toFixed(1)} <small>N</small>` : '—'}</span>
            <span class="metric-sub" id="hud-drag-sub">${frc ? `${frc.dragForceLbs.toFixed(1)} lbf · ${frc.dragForceKgf.toFixed(1)} kgf` : `A_ref = ${tel ? tel.frontalAreaM2.toFixed(3) : '—'} m²`}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Reynolds Number (Re)</span>
            <span class="metric-value" id="hud-reynolds">${tel ? this.formatSci(tel.reynoldsNumber) : '—'}</span>
            <span class="metric-sub">q = ${tel ? tel.dynamicPressurePa.toFixed(0) : '—'} Pa · A<sub>ref</sub> ${tel ? tel.frontalAreaM2.toFixed(3) : '—'} m²</span>
          </div>
        </div>
      </div>

      <div class="telemetry-card">
        <div class="card-header">
          <span class="card-title">MESH TOPOLOGY & WEBGPU LBM ALLOCATION</span>
          ${watertightBadge}
        </div>
        <div class="mesh-gpu-rows">
          <div class="info-row">
            <span class="info-key">Active Specimen:</span>
            <strong id="hud-mesh-name">${stats ? stats.name : 'Loading...'}</strong>
            <span class="info-muted">(${stats ? stats.triangleCount.toLocaleString() : 0} tris | Vol: ${stats ? stats.volume.toFixed(4) : 0} m³)</span>
          </div>
          <div class="info-row">
            <span class="info-key">WebGPU Compute Engine:</span>
            <span class="${gpu?.supported ? 'status-ready' : 'status-fallback'}">
              ● ${gpu ? gpu.adapterName : 'Detecting GPU...'}
            </span>
          </div>
          <div class="info-row">
            <span class="info-key">Allocated D3Q19 Lattice (${this.solverMode === 'high_precision' ? 'High-Precision' : 'Interactive 60FPS'}):</span>
            <strong id="hud-grid-res">
              ${activeGrid ? `${activeGrid.nx} × ${activeGrid.ny} × ${activeGrid.nz}` : '—'}
            </strong>
            <span class="info-muted">
              (${activeGrid ? (activeGrid.totalCells / 1e6).toFixed(2) : 0}M cells · ~${activeGrid ? activeGrid.estimatedVramMB : 0} MB VRAM)
            </span>
          </div>
          <div class="info-row">
            <span class="info-key">Sub-Grid Voxelizer (18-Link q):</span>
            <strong id="hud-voxel-stats">
              ${this.voxelTelemetry ? `${this.voxelTelemetry.solidCellCount.toLocaleString()} solid · ${this.voxelTelemetry.boundaryCellCount.toLocaleString()} curved-wall links` : '—'}
            </strong>
            <span class="badge-ok" id="hud-voxel-time">
              ${this.voxelTelemetry ? `${this.voxelTelemetry.voxelizationTimeMs.toFixed(1)} ms` : '—'}
            </span>
          </div>
          <div class="info-row">
            <span class="info-key">D3Q19 + LES Solver Status:</span>
            <strong id="hud-solver-steps">0 steps</strong>
            <span class="badge-ok" id="hud-solver-mlups">Live WebGPU</span>
          </div>
        </div>
      </div>
    `;
  }
}
