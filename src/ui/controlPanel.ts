import { FLUID_PRESETS, type FluidPresetId, type GizmoMode, type WindTunnelState } from '../core/types';
import { eventBus } from '../core/eventBus';
import { LBM_CONSTANTS } from '../solver/lbmConstants';
import type {
  ABComparisonDelta,
  BuildingStormReport,
  RocketStabilityReport,
} from '../solver/domainWorkflows';

export interface ControlPanelCallbacks {
  onStateChange: (newState: WindTunnelState) => void;
  onResetFlow?: () => void;
  onSaveBaseline?: () => void;
  onClearBaseline?: () => void;
  onExportCSV?: () => void;
  onExportJSON?: () => void;
  onSnapshotViewport?: () => void;
}

export class ControlPanelUI {
  private container: HTMLElement;
  private state: WindTunnelState;
  private callbacks: ControlPanelCallbacks;
  private abComparison: ABComparisonDelta | null = null;
  private rocketStability: RocketStabilityReport | null = null;
  private buildingStormReport: BuildingStormReport | null = null;

  constructor(container: HTMLElement, initialState: WindTunnelState, callbacks: ControlPanelCallbacks) {
    this.container = container;
    this.state = structuredClone(initialState);
    this.callbacks = callbacks;
    this.render();
  }

  public setABComparison(delta: ABComparisonDelta | null): void {
    this.abComparison = delta;
    const box = this.container.querySelector('#ab-comparison-content');
    const clearBtn = this.container.querySelector<HTMLButtonElement>('#btn-clear-baseline');
    if (clearBtn) {
      clearBtn.style.display = delta ? 'inline-block' : 'none';
    }
    if (box) {
      if (delta) {
        box.innerHTML = `
          <div style="background:var(--bg-input); padding:8px 10px; border-radius:3px; border:1px solid var(--border-subtle); margin-top:8px;">
            <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:4px;">
              <span style="color:var(--text-muted);">Run A (Baseline):</span>
              <strong style="color:var(--text-main); font-family:var(--font-mono);">${delta.baseline.specimenName} · Cd ${delta.baseline.cd.toFixed(3)}</strong>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:6px;">
              <span style="color:var(--text-muted);">Run B (Live):</span>
              <strong style="color:var(--accent-orange); font-family:var(--font-mono);">${delta.live.specimenName} · Cd ${delta.live.cd.toFixed(3)}</strong>
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <span class="${delta.isDragReduced ? 'badge-ok' : 'badge-warn'}" style="font-size:10px;">
                ΔCd ${delta.deltaCd >= 0 ? '+' : ''}${delta.deltaCd.toFixed(3)} (${delta.percentDeltaCd >= 0 ? '+' : ''}${delta.percentDeltaCd.toFixed(1)}%)
              </span>
              <span class="badge-neutral" style="font-size:10px;">
                ΔLift ${delta.deltaLiftForceN >= 0 ? '+' : ''}${delta.deltaLiftForceN.toFixed(1)} N
              </span>
            </div>
          </div>
        `;
      } else {
        box.innerHTML = `
          <p style="font-size:10.5px; color:var(--text-muted); margin-top:6px; line-height:1.45;">
            Click <strong>Capture Run A</strong> to freeze reference forces, then modify shape, scale, or orientation to measure live aerodynamic deltas.
          </p>
        `;
      }
    }
  }

  public setRocketStability(report: RocketStabilityReport | null): void {
    this.rocketStability = report;
    const stabBox = this.container.querySelector('#stability-stats-container');
    if (stabBox && report) {
      stabBox.innerHTML = `
        <div class="stat-row" style="display:flex; justify-content:space-between; margin-bottom:4px;">
          <span style="color:var(--text-muted);">Center of Pressure (X<sub>cp</sub>):</span>
          <strong style="color:var(--text-main); font-family:var(--font-mono); font-size:11px;">${report.xcpMeters.toFixed(2)} m</strong>
        </div>
        <div class="stat-row" style="display:flex; justify-content:space-between; margin-bottom:4px;">
          <span style="color:var(--text-muted);">Static Margin:</span>
          <strong style="color:${report.isStable ? 'var(--accent-green)' : 'var(--accent-red)'}; font-family:var(--font-mono); font-size:11px;">
            ${report.staticMarginCalibers.toFixed(2)} calibers
          </strong>
        </div>
        <div style="font-size:10.5px; line-height:1.4; color:var(--text-muted); margin-top:6px;">
          ${report.explanation}
        </div>
      `;
    }
    const badge = this.container.querySelector('#rocket-stab-badge');
    if (badge && report) {
      badge.className = report.isStable ? 'badge-ok' : 'badge-warn';
      badge.textContent = report.isStable ? '✓ Stable' : '⚠ Unstable';
    }
  }

  public setBuildingStormReport(report: BuildingStormReport | null): void {
    this.buildingStormReport = report;
    const tableBody = this.container.querySelector('#storm-ratings-tbody');
    if (tableBody && report) {
      tableBody.innerHTML = report.ratings.slice(1, 5).map((r) => `
        <tr style="border-bottom: 1px solid var(--border-subtle);">
          <td style="padding: 4px 2px; color: var(--text-main);">${r.ratingName.split('(')[0]}</td>
          <td style="padding: 4px 2px; text-align: right; font-family: var(--font-mono); color: var(--text-muted);">${r.stormWindKmh.toFixed(0)} km/h</td>
          <td style="padding: 4px 2px; text-align: right; font-family: var(--font-mono); color: ${r.upliftForceN > 0 ? 'var(--accent-amber)' : 'var(--accent-teal)'};">
            ${r.upliftForceN >= 0 ? '+' : ''}${r.upliftForceN.toFixed(0)} N <small>(${r.upliftForceKgf.toFixed(0)} kgf)</small>
          </td>
        </tr>
      `).join('');
    }
  }

  public syncTransformInputs(transform: WindTunnelState['transform']): void {
    this.state.transform = structuredClone(transform);
    const setVal = (id: string, val: number) => {
      const el = this.container.querySelector<HTMLInputElement>(`#${id}`);
      if (el && document.activeElement !== el) {
        el.value = String(val);
      }
    };
    setVal('rot-x', transform.rotationDeg.x);
    setVal('rot-y', transform.rotationDeg.y);
    setVal('rot-z', transform.rotationDeg.z);
    setVal('scale-uniform', transform.scale.x);
  }

  public syncGroundPlaneToggle(enabled: boolean): void {
    this.state.groundPlaneEnabled = enabled;
    const toggle = this.container.querySelector<HTMLInputElement>('#ground-plane-toggle');
    if (toggle) toggle.checked = enabled;
  }

  private render(): void {
    const fluidOptions = Object.values(FLUID_PRESETS)
      .filter((f) => f.id !== 'custom')
      .map(
        (f) => `<option value="${f.id}" ${f.id === this.state.fluid.id ? 'selected' : ''}>${f.name}</option>`
      )
      .join('');

    this.container.innerHTML = `
      <div class="panel-section">
        <div class="section-header">
          <span class="section-title">2. TRANSFORM & ORIENTATION</span>
          <div class="gizmo-toolbar">
            <button type="button" class="gizmo-btn ${this.state.gizmoMode === 'translate' ? 'active' : ''}" data-gizmo="translate" title="Translate (W)">Move</button>
            <button type="button" class="gizmo-btn ${this.state.gizmoMode === 'rotate' ? 'active' : ''}" data-gizmo="rotate" title="Rotate (E)">Rotate</button>
            <button type="button" class="gizmo-btn ${this.state.gizmoMode === 'scale' ? 'active' : ''}" data-gizmo="scale" title="Scale (R)">Scale</button>
          </div>
        </div>

        <div class="input-grid-3">
          <div class="field-box">
            <label for="rot-x">Roll X (°)</label>
            <input type="number" id="rot-x" step="5" value="${this.state.transform.rotationDeg.x}" />
          </div>
          <div class="field-box">
            <label for="rot-y">Yaw Y (°)</label>
            <input type="number" id="rot-y" step="5" value="${this.state.transform.rotationDeg.y}" />
          </div>
          <div class="field-box">
            <label for="rot-z">Pitch Z (°)</label>
            <input type="number" id="rot-z" step="5" value="${this.state.transform.rotationDeg.z}" />
          </div>
        </div>

        <div class="control-row" style="margin-top: 8px;">
          <label for="scale-uniform">Uniform Scale Multiplier</label>
          <div class="slider-group">
            <input type="range" id="scale-slider" min="0.1" max="3.0" step="0.05" value="${this.state.transform.scale.x}" />
            <input type="number" id="scale-uniform" min="0.05" max="10" step="0.05" value="${this.state.transform.scale.x}" class="num-sm" />
          </div>
        </div>

        <div class="btn-row-2">
          <button type="button" id="btn-reset-transform" class="btn-secondary">Reset Pose (0°)</button>
          <button type="button" id="btn-reset-camera" class="btn-secondary">Reset Camera</button>
        </div>
      </div>

      <div class="panel-section">
        <div class="section-header">
          <span class="section-title">3. WIND & FLUID CONDITIONS</span>
        </div>

        <div class="control-row">
          <div class="label-with-val">
            <label for="wind-speed-slider">Freestream Wind Speed (U∞)</label>
            <span id="wind-speed-readout" class="val-highlight">${this.state.windSpeed.toFixed(1)} m/s (${(this.state.windSpeed * 3.6).toFixed(0)} km/h)</span>
          </div>
          <input type="range" id="wind-speed-slider" min="1" max="120" step="0.5" value="${this.state.windSpeed}" />
        </div>

        <div class="control-row">
          <label for="fluid-select">Working Fluid Medium</label>
          <select id="fluid-select" class="select-input">
            ${fluidOptions}
          </select>
        </div>

        <div class="toggle-row">
          <div>
            <strong>Ground-Mounted Boundary Floor</strong>
            <small>Enable for Sheds, Tiny Homes & Cars (ABL profile)</small>
          </div>
          <input type="checkbox" id="ground-plane-toggle" ${this.state.groundPlaneEnabled ? 'checked' : ''} />
        </div>
      </div>

      <div class="panel-section">
        <div class="section-header">
          <span class="section-title">4. TEST SECTION ENCLOSURE (m)</span>
        </div>
        <div class="input-grid-3">
          <div class="field-box">
            <label for="tunnel-l">Length (X)</label>
            <input type="number" id="tunnel-l" min="2" max="20" step="0.5" value="${this.state.tunnel.length}" />
          </div>
          <div class="field-box">
            <label for="tunnel-w">Width (Z)</label>
            <input type="number" id="tunnel-w" min="1" max="10" step="0.2" value="${this.state.tunnel.width}" />
          </div>
          <div class="field-box">
            <label for="tunnel-h">Height (Y)</label>
            <input type="number" id="tunnel-h" min="1" max="10" step="0.2" value="${this.state.tunnel.height}" />
          </div>
        </div>

        <div class="control-row" style="margin-top: 10px;">
          <label>Target Solver Resolution Mode</label>
          <div class="mode-switch">
            <button type="button" class="mode-btn ${this.state.solverMode === 'interactive' ? 'active' : ''}" data-mode="interactive">
              Interactive (60 FPS)
            </button>
            <button type="button" class="mode-btn ${this.state.solverMode === 'high_precision' ? 'active' : ''}" data-mode="high_precision">
              High-Precision Lock
            </button>
          </div>
        </div>
      </div>

      <div class="panel-section">
        <div class="section-header">
          <span class="section-title">5. LIVE WEBGPU FLOW SLICE (D3Q19 + LES)</span>
          <span class="badge-accent">PHASE 3</span>
        </div>

        <div class="input-grid-3" style="margin-bottom: 8px;">
          <button type="button" class="gizmo-btn ${this.state.flowSliceField === 'vorticity' ? 'active' : ''}" data-flowfield="vorticity" title="Curl |∇×u| (Vortex Cores)">Vorticity</button>
          <button type="button" class="gizmo-btn ${this.state.flowSliceField === 'velocity' ? 'active' : ''}" data-flowfield="velocity" title="Velocity Magnitude |u|/U∞">Velocity</button>
          <button type="button" class="gizmo-btn ${this.state.flowSliceField === 'cp' ? 'active' : ''}" data-flowfield="cp" title="Pressure Coefficient Cp">Pressure C<sub>p</sub></button>
        </div>

        <div class="input-grid-3" style="margin-bottom: 8px;">
          <button type="button" class="gizmo-btn ${this.state.flowSliceAxis === 'z' ? 'active' : ''}" data-flowaxis="z">XY (Z-Slice)</button>
          <button type="button" class="gizmo-btn ${this.state.flowSliceAxis === 'y' ? 'active' : ''}" data-flowaxis="y">XZ (Y-Slice)</button>
          <button type="button" class="gizmo-btn ${this.state.flowSliceAxis === 'x' ? 'active' : ''}" data-flowaxis="x">YZ (X-Slice)</button>
        </div>

        <div class="control-row" style="margin-bottom: 8px;">
          <div class="label-with-val">
            <label for="flow-slice-pos">Cross-Section Plane Offset</label>
            <span id="flow-slice-readout" class="val-highlight">${Math.round(this.state.flowSlicePos * 100)}% (Midplane)</span>
          </div>
          <input type="range" id="flow-slice-pos" min="0.05" max="0.95" step="0.01" value="${this.state.flowSlicePos}" />
        </div>

        <div class="btn-row-2">
          <button type="button" id="btn-toggle-pause" class="btn-secondary">${this.state.solverPaused ? '▶ Resume Flow' : '⏸ Pause Flow'}</button>
          <button type="button" id="btn-reset-flow" class="btn-secondary">↻ Reset Wind</button>
        </div>
      </div>

      <div class="panel-section">
        <div class="section-header">
          <span class="section-title">6. SUB-GRID VOXEL & Q-DISTANCE INSPECTOR</span>
          <span class="badge-accent">PHASE 2</span>
        </div>
        <div class="input-grid-3" style="margin-bottom: 10px;">
          <button type="button" class="gizmo-btn ${this.state.voxelVizMode === 'slice_2d' ? 'active' : ''}" data-voxviz="slice_2d">2D q-Slice</button>
          <button type="button" class="gizmo-btn ${this.state.voxelVizMode === 'shell_3d' ? 'active' : ''}" data-voxviz="shell_3d">3D q-Shell</button>
          <button type="button" class="gizmo-btn ${this.state.voxelVizMode === 'off' ? 'active' : ''}" data-voxviz="off">Hidden</button>
        </div>
        <div class="control-row" style="margin-bottom: 0;">
          <div class="label-with-val">
            <label for="voxel-slice-z">Spanwise Z-Slice Position</label>
            <span id="voxel-slice-readout" class="val-highlight">${Math.round(this.state.voxelSliceZ * 100)}% (Midplane)</span>
          </div>
          <input type="range" id="voxel-slice-z" min="0.05" max="0.95" step="0.01" value="${this.state.voxelSliceZ}" />
        </div>
      </div>

      <div class="panel-section">
        <div class="section-header">
          <span class="section-title">7. 3D AERODYNAMIC VISUALIZATIONS</span>
          <span class="badge-accent">PHASE 5</span>
        </div>

        <div class="control-row">
          <label>Surface Heatmap (CFD Palette)</label>
          <div class="input-grid-3">
            <button type="button" class="gizmo-btn ${this.state.surfaceHeatmapMode === 'off' ? 'active' : ''}" data-surfheatmap="off">Off</button>
            <button type="button" class="gizmo-btn ${this.state.surfaceHeatmapMode === 'cp' ? 'active' : ''}" data-surfheatmap="cp">Pressure (Cp)</button>
            <button type="button" class="gizmo-btn ${this.state.surfaceHeatmapMode === 'drag' ? 'active' : ''}" data-surfheatmap="drag">Surface Drag</button>
          </div>
        </div>

        <div class="control-row">
          <div class="label-with-val">
            <label>3D Vortex Cores (Q-Criterion)</label>
            <span class="val-highlight">${this.state.vortexTubesEnabled ? 'ACTIVE' : 'OFF'}</span>
          </div>
          <div class="btn-row-2">
            <button type="button" id="btn-toggle-vortex" class="btn-secondary ${this.state.vortexTubesEnabled ? 'btn-active-highlight' : ''}">${this.state.vortexTubesEnabled ? 'Hide Vortex Cores' : 'Show Vortex Cores'}</button>
          </div>
          <div class="slider-group" style="margin-top: 6px;">
            <label for="vortex-threshold" style="font-size: 11px; color: var(--text-muted);">Threshold Q / Qmax</label>
            <input type="range" id="vortex-threshold" min="0.05" max="0.80" step="0.05" value="${this.state.vortexThreshold}" />
            <span id="vortex-threshold-val" class="val-highlight" style="font-size: 11px;">${Math.round(this.state.vortexThreshold * 100)}%</span>
          </div>
        </div>

        <div class="control-row">
          <div class="label-with-val">
            <label>3D Smoke Rake & Streamlines</label>
            <span class="val-highlight">${this.state.streamlinesEnabled ? 'ACTIVE' : 'OFF'}</span>
          </div>
          <div class="btn-row-2">
            <button type="button" id="btn-toggle-streamlines" class="btn-secondary ${this.state.streamlinesEnabled ? 'btn-active-highlight' : ''}">${this.state.streamlinesEnabled ? 'Stop Smoke Rake' : 'Inject Smoke Streamlines'}</button>
          </div>
          <div class="slider-group" style="margin-top: 6px;">
            <label for="rake-y-slider" style="font-size: 11px; color: var(--text-muted);">Rake Height (Y)</label>
            <input type="range" id="rake-y-slider" min="-0.8" max="0.8" step="0.05" value="${this.state.streamlineRakeY}" />
          </div>
          <div class="slider-group" style="margin-top: 4px;">
            <label for="rake-z-slider" style="font-size: 11px; color: var(--text-muted);">Rake Lateral (Z)</label>
            <input type="range" id="rake-z-slider" min="-0.8" max="0.8" step="0.05" value="${this.state.streamlineRakeZ}" />
          </div>
        </div>

        <div class="control-row" style="margin-bottom: 0;">
          <div class="label-with-val">
            <label>Interactive 3D Point Probe Tool</label>
            <span class="val-highlight">${this.state.probeEnabled ? 'ACTIVE' : 'OFF'}</span>
          </div>
          <div class="btn-row-2">
            <button type="button" id="btn-toggle-probe" class="btn-secondary ${this.state.probeEnabled ? 'btn-active-highlight' : ''}">${this.state.probeEnabled ? 'Deactivate Point Probe' : 'Activate 3D Point Probe'}</button>
          </div>
        </div>
      </div>

      <div class="panel-section">
        <div class="section-header">
          <span class="section-title">8. DOMAIN WORKFLOWS & DATA EXPORT</span>
          <span class="badge-accent">PHASE 6</span>
        </div>

        <div class="control-row">
          <label>Workflow Persona Mode</label>
          <div class="btn-row-2">
            <button type="button" class="gizmo-btn ${this.state.domainWorkflowMode === 'freestream' ? 'active' : ''}" data-domain="freestream">
              Freestream (Rockets)
            </button>
            <button type="button" class="gizmo-btn ${this.state.domainWorkflowMode === 'ground_atmospheric' ? 'active' : ''}" data-domain="ground_atmospheric">
              Ground ABL (Sheds)
            </button>
          </div>
        </div>

        ${this.state.domainWorkflowMode === 'freestream' ? `
          <div class="domain-card" style="background:var(--bg-card); padding:10px; border-radius:6px; border:1px solid var(--border-subtle);">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong style="color:var(--text-main); font-size:11.5px; font-weight:700;">Rocket Static Stability</strong>
              <span id="rocket-stab-badge" class="${this.rocketStability?.isStable ? 'badge-ok' : 'badge-warn'}">
                ${this.rocketStability ? (this.rocketStability.isStable ? '✓ Stable' : '⚠ Unstable') : 'Estimating...'}
              </span>
            </div>
            <div style="margin-top: 8px;">
              <label for="rocket-stab-toggle" style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:11px; color:var(--text-main);">
                <input type="checkbox" id="rocket-stab-toggle" ${this.state.rocketStabilityEnabled ? 'checked' : ''} />
                <span>Show 3D X<sub>cp</sub> & X<sub>cg</sub> Markers</span>
              </label>
            </div>
            <div class="slider-group" style="margin-top: 6px;">
              <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-muted); margin-bottom:4px;">
                <span>Center of Gravity (X<sub>cg</sub>):</span>
                <span id="xcg-val" class="val-highlight">${this.state.rocketXcgOffset.toFixed(2)} m</span>
              </div>
              <input type="range" id="xcg-slider" min="-1.5" max="1.5" step="0.05" value="${this.state.rocketXcgOffset}" />
            </div>
            <div id="stability-stats-container" style="background:var(--bg-card-subtle); padding:8px; border-radius:6px; border:1px solid var(--border-subtle); margin-top:8px;">
              ${this.rocketStability ? `
                <div class="stat-row" style="display:flex; justify-content:space-between; margin-bottom:4px;">
                  <span style="color:var(--text-muted);">Center of Pressure (X<sub>cp</sub>):</span>
                  <strong style="color:var(--text-main); font-family:var(--font-mono); font-size:11px;">${this.rocketStability.xcpMeters.toFixed(2)} m</strong>
                </div>
                <div class="stat-row" style="display:flex; justify-content:space-between; margin-bottom:4px;">
                  <span style="color:var(--text-muted);">Static Margin:</span>
                  <strong style="color:${this.rocketStability.isStable ? 'var(--accent-green)' : 'var(--accent-red)'}; font-family:var(--font-mono); font-size:11px;">
                    ${this.rocketStability.staticMarginCalibers.toFixed(2)} calibers
                  </strong>
                </div>
                <div style="font-size:10.5px; line-height:1.4; color:var(--text-muted); margin-top:6px;">
                  ${this.rocketStability.explanation}
                </div>
              ` : '<div style="color:var(--text-muted); font-size:11px;">Awaiting aerodynamic convergence...</div>'}
            </div>
          </div>
        ` : `
          <div class="domain-card" style="background:var(--bg-card); padding:10px; border-radius:6px; border:1px solid var(--border-subtle);">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong style="color:var(--accent-amber); font-size:11.5px; font-weight:700;">Building Roof Suction & Storm Loads</strong>
            </div>
            <p style="font-size:10.5px; color:var(--text-muted); margin-top:4px;">
              Scales measured wake suction (negative C<sub>p</sub>) to severe storm conditions:
            </p>
            <table style="width:100%; margin-top:8px; font-size:11px; border-collapse:collapse;">
              <thead>
                <tr style="border-bottom:1px solid var(--border-subtle); color:var(--text-muted); text-align:left;">
                  <th style="padding:3px 2px;">Storm</th>
                  <th style="padding:3px 2px; text-align:right;">Wind</th>
                  <th style="padding:3px 2px; text-align:right;">Roof Uplift</th>
                </tr>
              </thead>
              <tbody id="storm-ratings-tbody">
                ${this.buildingStormReport ? this.buildingStormReport.ratings.slice(1, 5).map(r => `
                  <tr style="border-bottom: 1px solid var(--border-subtle);">
                    <td style="padding: 3px 2px; color: var(--text-main);">${r.ratingName.split('(')[0]}</td>
                    <td style="padding: 3px 2px; text-align: right; font-family: var(--font-mono); color: var(--text-muted);">${r.stormWindKmh.toFixed(0)} km/h</td>
                    <td style="padding: 3px 2px; text-align: right; font-family: var(--font-mono); color: ${r.upliftForceN > 0 ? 'var(--accent-amber)' : 'var(--accent-teal)'};">
                      ${r.upliftForceN >= 0 ? '+' : ''}${r.upliftForceN.toFixed(0)} N <small>(${r.upliftForceKgf.toFixed(0)} kgf)</small>
                    </td>
                  </tr>
                `).join('') : '<tr><td colspan="3" style="padding:4px; color:var(--text-muted);">Simulating flow...</td></tr>'}
              </tbody>
            </table>
          </div>
        `}

        <!-- A/B Specimen Comparison -->
        <div class="domain-card" style="background:var(--bg-card); padding:10px; border-radius:6px; border:1px solid var(--border-subtle); margin-top: 10px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong style="color:var(--text-main); font-size:11px; letter-spacing:0.3px;">A/B SPECIMEN DELTA</strong>
            <div style="display:flex; gap:4px; align-items:center;">
              <button type="button" class="btn-secondary" id="btn-save-baseline" style="padding:3px 8px; font-size:10.5px; font-family:var(--font-mono);">CAPTURE RUN A</button>
              <button type="button" class="btn-secondary" id="btn-clear-baseline" style="padding:3px 8px; font-size:10.5px; color:var(--accent-red); font-family:var(--font-mono); display:${this.abComparison ? 'inline-block' : 'none'};">CLEAR</button>
            </div>
          </div>
          <div id="ab-comparison-content">
            ${this.abComparison ? `
              <div style="background:var(--bg-card-subtle); padding:8px 10px; border-radius:3px; border:1px solid var(--border-subtle); margin-top:8px;">
                <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:3px;">
                  <span style="color:var(--text-muted);">Run A (Baseline):</span>
                  <strong style="color:var(--text-main); font-family:var(--font-mono);">${this.abComparison.baseline.specimenName} · Cd ${this.abComparison.baseline.cd.toFixed(3)}</strong>
                </div>
                <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:6px;">
                  <span style="color:var(--text-muted);">Run B (Live):</span>
                  <strong style="color:var(--accent-orange); font-family:var(--font-mono);">${this.abComparison.live.specimenName} · Cd ${this.abComparison.live.cd.toFixed(3)}</strong>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                  <span class="${this.abComparison.isDragReduced ? 'badge-ok' : 'badge-warn'}" style="font-size:10.5px;">
                    ΔCd ${this.abComparison.deltaCd >= 0 ? '+' : ''}${this.abComparison.deltaCd.toFixed(3)} (${this.abComparison.percentDeltaCd >= 0 ? '+' : ''}${this.abComparison.percentDeltaCd.toFixed(1)}%)
                  </span>
                  <span class="badge-accent" style="font-size:10.5px;">
                    ΔLift ${this.abComparison.deltaLiftForceN >= 0 ? '+' : ''}${this.abComparison.deltaLiftForceN.toFixed(1)} N
                  </span>
                </div>
              </div>
            ` : `
              <p style="font-size:10.5px; color:var(--text-muted); margin-top:6px;">
                Click <strong>Capture Run A</strong> to freeze reference forces, then modify shape, scale, or orientation to measure live aerodynamic deltas.
              </p>
            `}
          </div>
        </div>

        <!-- Telemetry & Report Export -->
        <div style="margin-top: 12px;">
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px;">
            <button type="button" class="btn-secondary" id="btn-export-csv" style="font-weight:600; font-size:11px; letter-spacing:0.3px;">
              EXPORT CSV
            </button>
            <button type="button" class="btn-secondary" id="btn-export-json" style="font-weight:600; font-size:11px; letter-spacing:0.3px;">
              EXPORT JSON
            </button>
          </div>
          <button type="button" class="btn-secondary" id="btn-snapshot-png" style="width:100%; margin-top:6px; font-weight:600; font-size:11px; letter-spacing:0.3px;">
            CAPTURE VIEWPORT (PNG)
          </button>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  private bindEvents(): void {
    // Gizmo mode buttons
    this.container.querySelectorAll<HTMLButtonElement>('[data-gizmo]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-gizmo') as GizmoMode;
        this.state.gizmoMode = mode;
        this.container.querySelectorAll('[data-gizmo]').forEach((b) => b.classList.toggle('active', b === btn));
        eventBus.emit('gizmo:mode', mode);
      });
    });

    // Rotation inputs
    const updateRotation = () => {
      const rx = parseFloat((this.container.querySelector('#rot-x') as HTMLInputElement).value) || 0;
      const ry = parseFloat((this.container.querySelector('#rot-y') as HTMLInputElement).value) || 0;
      const rz = parseFloat((this.container.querySelector('#rot-z') as HTMLInputElement).value) || 0;
      this.state.transform.rotationDeg = { x: rx, y: ry, z: rz };
      this.callbacks.onStateChange(structuredClone(this.state));
    };
    ['rot-x', 'rot-y', 'rot-z'].forEach((id) => {
      this.container.querySelector(`#${id}`)?.addEventListener('input', updateRotation);
    });

    // Scale inputs
    const scaleSlider = this.container.querySelector<HTMLInputElement>('#scale-slider');
    const scaleNum = this.container.querySelector<HTMLInputElement>('#scale-uniform');
    const applyScale = (s: number) => {
      const clamped = Math.max(0.05, Math.min(10, s));
      this.state.transform.scale = { x: clamped, y: clamped, z: clamped };
      if (scaleSlider) scaleSlider.value = String(clamped);
      if (scaleNum) scaleNum.value = String(clamped);
      this.callbacks.onStateChange(structuredClone(this.state));
    };
    scaleSlider?.addEventListener('input', () => applyScale(parseFloat(scaleSlider.value) || 1));
    scaleNum?.addEventListener('input', () => applyScale(parseFloat(scaleNum.value) || 1));

    // Reset Pose & Camera
    this.container.querySelector('#btn-reset-transform')?.addEventListener('click', () => {
      this.state.transform = {
        position: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      };
      this.syncTransformInputs(this.state.transform);
      if (scaleSlider) scaleSlider.value = '1';
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    this.container.querySelector('#btn-reset-camera')?.addEventListener('click', () => {
      eventBus.emit('camera:reset', undefined);
    });

    // Wind Speed
    const windSlider = this.container.querySelector<HTMLInputElement>('#wind-speed-slider');
    const windReadout = this.container.querySelector<HTMLElement>('#wind-speed-readout');
    windSlider?.addEventListener('input', () => {
      const u = parseFloat(windSlider.value) || 1;
      this.state.windSpeed = u;
      if (windReadout) {
        const kmh = (u * LBM_CONSTANTS.SPEED_MPS_TO_KMH).toFixed(0);
        const mph = (u * LBM_CONSTANTS.SPEED_MPS_TO_MPH).toFixed(0);
        windReadout.textContent = `${u.toFixed(1)} m/s (${kmh} km/h | ${mph} mph)`;
      }
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    // Fluid Preset
    const fluidSelect = this.container.querySelector<HTMLSelectElement>('#fluid-select');
    fluidSelect?.addEventListener('change', () => {
      const id = fluidSelect.value as FluidPresetId;
      this.state.fluid = { ...FLUID_PRESETS[id] };
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    // Ground Plane Toggle
    const groundToggle = this.container.querySelector<HTMLInputElement>('#ground-plane-toggle');
    groundToggle?.addEventListener('change', () => {
      this.state.groundPlaneEnabled = groundToggle.checked;
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    // Tunnel Dimensions
    const updateTunnel = () => {
      const l = Math.max(2, parseFloat((this.container.querySelector('#tunnel-l') as HTMLInputElement).value) || 6);
      const w = Math.max(1, parseFloat((this.container.querySelector('#tunnel-w') as HTMLInputElement).value) || 2.8);
      const h = Math.max(1, parseFloat((this.container.querySelector('#tunnel-h') as HTMLInputElement).value) || 2.4);
      this.state.tunnel = { length: l, width: w, height: h };
      this.callbacks.onStateChange(structuredClone(this.state));
    };
    ['tunnel-l', 'tunnel-w', 'tunnel-h'].forEach((id) => {
      this.container.querySelector(`#${id}`)?.addEventListener('change', updateTunnel);
    });

    // Solver Mode Switch
    this.container.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode') as WindTunnelState['solverMode'];
        this.state.solverMode = mode;
        this.container.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
        this.callbacks.onStateChange(structuredClone(this.state));
      });
    });

    // Voxel Debug Viz Mode
    this.container.querySelectorAll<HTMLButtonElement>('[data-voxviz]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const vizMode = btn.getAttribute('data-voxviz') as WindTunnelState['voxelVizMode'];
        this.state.voxelVizMode = vizMode;
        this.container.querySelectorAll('[data-voxviz]').forEach((b) => b.classList.toggle('active', b === btn));
        this.callbacks.onStateChange(structuredClone(this.state));
      });
    });

    // Voxel Z-Slice Slider
    const sliceSlider = this.container.querySelector<HTMLInputElement>('#voxel-slice-z');
    const sliceReadout = this.container.querySelector<HTMLElement>('#voxel-slice-readout');
    sliceSlider?.addEventListener('input', () => {
      const zFrac = parseFloat(sliceSlider.value) || 0.5;
      this.state.voxelSliceZ = zFrac;
      if (sliceReadout) {
        const zMeters = (zFrac - 0.5) * this.state.tunnel.width;
        sliceReadout.textContent = `${Math.round(zFrac * 100)}% (z = ${zMeters >= 0 ? '+' : ''}${zMeters.toFixed(2)}m)`;
      }
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    // Phase 3 Flow Slice Field Mode
    this.container.querySelectorAll<HTMLButtonElement>('[data-flowfield]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const field = btn.getAttribute('data-flowfield') as WindTunnelState['flowSliceField'];
        this.state.flowSliceField = field;
        this.state.flowSliceEnabled = true;
        this.container.querySelectorAll('[data-flowfield]').forEach((b) => b.classList.toggle('active', b === btn));
        this.callbacks.onStateChange(structuredClone(this.state));
      });
    });

    // Phase 3 Flow Slice Axis
    this.container.querySelectorAll<HTMLButtonElement>('[data-flowaxis]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const axis = btn.getAttribute('data-flowaxis') as WindTunnelState['flowSliceAxis'];
        this.state.flowSliceAxis = axis;
        this.container.querySelectorAll('[data-flowaxis]').forEach((b) => b.classList.toggle('active', b === btn));
        this.callbacks.onStateChange(structuredClone(this.state));
      });
    });

    // Phase 3 Flow Slice Offset Slider
    const flowPosSlider = this.container.querySelector<HTMLInputElement>('#flow-slice-pos');
    const flowPosReadout = this.container.querySelector<HTMLElement>('#flow-slice-readout');
    flowPosSlider?.addEventListener('input', () => {
      const frac = parseFloat(flowPosSlider.value) || 0.5;
      this.state.flowSlicePos = frac;
      if (flowPosReadout) {
        flowPosReadout.textContent = `${Math.round(frac * 100)}%`;
      }
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    // Pause / Resume & Reset Wind
    const pauseBtn = this.container.querySelector<HTMLButtonElement>('#btn-toggle-pause');
    pauseBtn?.addEventListener('click', () => {
      this.state.solverPaused = !this.state.solverPaused;
      pauseBtn.textContent = this.state.solverPaused ? '▶ Resume Flow' : '⏸ Pause Flow';
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    this.container.querySelector('#btn-reset-flow')?.addEventListener('click', () => {
      this.callbacks.onResetFlow?.();
    });

    // Phase 5: Surface Heatmap Mode Buttons
    this.container.querySelectorAll<HTMLButtonElement>('[data-surfheatmap]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-surfheatmap') as WindTunnelState['surfaceHeatmapMode'];
        this.state.surfaceHeatmapMode = mode;
        this.container.querySelectorAll('[data-surfheatmap]').forEach((b) => b.classList.toggle('active', b === btn));
        this.callbacks.onStateChange(structuredClone(this.state));
      });
    });

    // Phase 5: 3D Vortex Cores Toggle & Threshold
    const vortexBtn = this.container.querySelector<HTMLButtonElement>('#btn-toggle-vortex');
    vortexBtn?.addEventListener('click', () => {
      this.state.vortexTubesEnabled = !this.state.vortexTubesEnabled;
      this.render();
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    const vortexThreshSlider = this.container.querySelector<HTMLInputElement>('#vortex-threshold');
    const vortexThreshVal = this.container.querySelector<HTMLElement>('#vortex-threshold-val');
    vortexThreshSlider?.addEventListener('input', () => {
      const val = parseFloat(vortexThreshSlider.value) || 0.2;
      this.state.vortexThreshold = val;
      if (vortexThreshVal) vortexThreshVal.textContent = `${Math.round(val * 100)}%`;
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    // Phase 5: Streamlines Toggle & Rake Sliders
    const streamBtn = this.container.querySelector<HTMLButtonElement>('#btn-toggle-streamlines');
    streamBtn?.addEventListener('click', () => {
      this.state.streamlinesEnabled = !this.state.streamlinesEnabled;
      this.render();
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    const rakeYSlider = this.container.querySelector<HTMLInputElement>('#rake-y-slider');
    rakeYSlider?.addEventListener('input', () => {
      this.state.streamlineRakeY = parseFloat(rakeYSlider.value) || 0;
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    const rakeZSlider = this.container.querySelector<HTMLInputElement>('#rake-z-slider');
    rakeZSlider?.addEventListener('input', () => {
      this.state.streamlineRakeZ = parseFloat(rakeZSlider.value) || 0;
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    // Phase 5: Point Probe Toggle
    const probeBtn = this.container.querySelector<HTMLButtonElement>('#btn-toggle-probe');
    probeBtn?.addEventListener('click', () => {
      this.state.probeEnabled = !this.state.probeEnabled;
      this.render();
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    // Phase 6: Domain Mode Buttons
    this.container.querySelectorAll<HTMLButtonElement>('[data-domain]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-domain') as WindTunnelState['domainWorkflowMode'];
        this.state.domainWorkflowMode = mode;
        this.state.groundPlaneEnabled = mode === 'ground_atmospheric';
        this.render();
        this.callbacks.onStateChange(structuredClone(this.state));
      });
    });

    // Phase 6: Rocket Stability Toggle & Xcg Slider
    const stabToggle = this.container.querySelector<HTMLInputElement>('#rocket-stab-toggle');
    stabToggle?.addEventListener('change', () => {
      this.state.rocketStabilityEnabled = stabToggle.checked;
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    const xcgSlider = this.container.querySelector<HTMLInputElement>('#xcg-slider');
    const xcgVal = this.container.querySelector<HTMLElement>('#xcg-val');
    xcgSlider?.addEventListener('input', () => {
      const val = parseFloat(xcgSlider.value) || 0;
      this.state.rocketXcgOffset = val;
      if (xcgVal) xcgVal.textContent = `${val.toFixed(2)} m`;
      this.callbacks.onStateChange(structuredClone(this.state));
    });

    // Phase 6: A/B Comparison Buttons
    const saveBaseBtn = this.container.querySelector<HTMLButtonElement>('#btn-save-baseline');
    saveBaseBtn?.addEventListener('click', () => {
      this.callbacks.onSaveBaseline?.();
    });

    const clearBaseBtn = this.container.querySelector<HTMLButtonElement>('#btn-clear-baseline');
    clearBaseBtn?.addEventListener('click', () => {
      this.callbacks.onClearBaseline?.();
    });

    this.container.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('#btn-clear-baseline');
      if (target) {
        this.callbacks.onClearBaseline?.();
      }
    });

    // Phase 6: Export Buttons
    const exportCsvBtn = this.container.querySelector<HTMLButtonElement>('#btn-export-csv');
    exportCsvBtn?.addEventListener('click', () => {
      this.callbacks.onExportCSV?.();
    });

    const exportJsonBtn = this.container.querySelector<HTMLButtonElement>('#btn-export-json');
    exportJsonBtn?.addEventListener('click', () => {
      this.callbacks.onExportJSON?.();
    });

    const snapshotBtn = this.container.querySelector<HTMLButtonElement>('#btn-snapshot-png');
    snapshotBtn?.addEventListener('click', () => {
      this.callbacks.onSnapshotViewport?.();
    });
  }
}
