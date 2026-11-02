import type { AerodynamicForceReadout } from '../solver/forceIntegrator';
import type { BenchmarkTestResult } from '../validation/testRunner';

export interface ConvergenceChartCallbacks {
  onRunBenchmarks: () => void;
}

export class ConvergenceChartUI {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement | null = null;
  private callbacks: ConvergenceChartCallbacks;
  private isRunningBenchmarks = false;

  constructor(container: HTMLElement, callbacks: ConvergenceChartCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.renderShell();
  }

  private renderShell(): void {
    this.container.innerHTML = `
      <div class="convergence-widget">
        <div class="conv-header">
          <div class="conv-title-group">
            <span class="card-title">LIVE C<sub>d</sub> / C<sub>l</sub> CONVERGENCE & BENCHMARK SUITE</span>
            <span id="conv-badge" class="badge-warn">⏳ Accumulating Samples...</span>
          </div>
          <button type="button" id="btn-run-benchmarks" class="btn-benchmark">
            🧪 Run Physics Validation Suite
          </button>
        </div>

        <div class="conv-body">
          <canvas id="convergence-canvas" width="440" height="84"></canvas>
          <div id="benchmark-results-drawer" class="benchmark-drawer hidden"></div>
        </div>
      </div>
    `;

    this.canvas = this.container.querySelector<HTMLCanvasElement>('#convergence-canvas');
    const btn = this.container.querySelector<HTMLButtonElement>('#btn-run-benchmarks');
    btn?.addEventListener('click', () => {
      if (this.isRunningBenchmarks) return;
      this.isRunningBenchmarks = true;
      btn.textContent = '⏳ Running Suite...';
      btn.disabled = true;
      btn.style.opacity = '0.6';
      setTimeout(() => {
        this.callbacks.onRunBenchmarks();
      }, 50);
    });
  }

  public showBenchmarkProgress(currentModel: string, currentIndex: number, totalModels: number, percent: number): void {
    const drawer = this.container.querySelector<HTMLElement>('#benchmark-results-drawer');
    if (!drawer) return;
    drawer.classList.remove('hidden');

    drawer.innerHTML = `
      <div class="benchmark-progress-box">
        <div class="bench-header">
          <strong style="color:#38bdf8; display:flex; align-items:center; gap:6px;">
            <span>🔬</span> Running Deep Physics Validation Suite (${currentIndex}/${totalModels})
          </strong>
        </div>
        <div class="benchmark-progress-notice">
          Simulating 4 distinct wind tunnels on CPU. High CPU usage is <strong>completely normal and expected</strong> — unadulterated Navier-Stokes physics is running in the background. Please keep this tab active.
        </div>
        <div style="font-size:11px; font-weight:600; color:#f8fafc; margin-top:2px;">
          Active: <span style="color:#facc15;">${currentModel}</span>
        </div>
        <div class="benchmark-progress-bar-bg">
          <div class="benchmark-progress-bar-fill" style="width: ${percent}%;"></div>
        </div>
      </div>
    `;
  }

  public showBenchmarkResults(results: BenchmarkTestResult[]): void {
    this.isRunningBenchmarks = false;
    const btn = this.container.querySelector<HTMLButtonElement>('#btn-run-benchmarks');
    if (btn) {
      btn.textContent = '✓ Re-Run Physics Validation Suite';
      btn.disabled = false;
      btn.style.opacity = '1.0';
    }

    const drawer = this.container.querySelector<HTMLElement>('#benchmark-results-drawer');
    if (!drawer) return;
    drawer.classList.remove('hidden');

    const rowsHtml = results
      .map(
        (r) => `
        <div class="bench-row">
          <span class="bench-name">${r.benchmark.name}</span>
          <span class="bench-vals">
            Computed <strong>C<sub>d</sub> = ${r.computedCd.toFixed(3)}</strong>
            <small>(Target: ${r.effectiveTargetCd.toFixed(2)} · Re: ${r.simulatedRe} · Err: ${r.relativeErrorPercent}%)</small>
          </span>
          <span class="${r.passed ? 'badge-ok' : 'badge-warn'}">${r.passed ? 'PASS' : 'WARN'}</span>
        </div>
      `
      )
      .join('');

    drawer.innerHTML = `
      <div class="bench-header">
        <strong>Gate 4 Empirical Wind-Tunnel Validation Results</strong>
        <button type="button" id="btn-close-bench" class="bench-close">✕</button>
      </div>
      ${rowsHtml}
    `;

    drawer.querySelector('#btn-close-bench')?.addEventListener('click', () => {
      drawer.classList.add('hidden');
    });
  }

  public updatePlot(readout: AerodynamicForceReadout): void {
    const badge = this.container.querySelector<HTMLElement>('#conv-badge');
    if (badge) {
      if (readout.isConverged) {
        badge.className = 'badge-ok';
        badge.textContent = `✓ Converged (${readout.stabilityPercent.toFixed(0)}% stable · ±${readout.stdCd.toFixed(3)})`;
      } else {
        badge.className = 'badge-warn';
        badge.textContent = `⟳ Converging (${readout.stabilityPercent.toFixed(0)}% stable)`;
      }
    }

    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Background grid
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = 1;
    for (let y = 16; y < h; y += 22) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const hist = readout.history;
    if (hist.length < 2) return;

    let minVal = Infinity;
    let maxVal = -Infinity;
    for (let i = 0; i < hist.length; i++) {
      if (hist[i].cd < minVal) minVal = hist[i].cd;
      if (hist[i].cd > maxVal) maxVal = hist[i].cd;
      if (hist[i].cl < minVal) minVal = hist[i].cl;
      if (hist[i].cl > maxVal) maxVal = hist[i].cl;
    }

    const pad = Math.max(0.15, (maxVal - minVal) * 0.25);
    const yMin = minVal - pad;
    const yMax = maxVal + pad;
    const mapY = (v: number) => h - 8 - ((v - yMin) / Math.max(1e-5, yMax - yMin)) * (h - 16);

    // Draw Cl curve (Cyan)
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const x = (i / (hist.length - 1)) * (w - 12) + 6;
      const y = mapY(hist[i].cl);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw Cd curve (Amber/Orange)
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const x = (i / (hist.length - 1)) * (w - 12) + 6;
      const y = mapY(hist[i].cd);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Legend labels inside canvas
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.fillStyle = '#f59e0b';
    ctx.fillText(`Cd: ${readout.meanCd.toFixed(3)}`, 10, 15);
    ctx.fillStyle = '#22d3ee';
    ctx.fillText(`Cl: ${readout.meanCl >= 0 ? '+' : ''}${readout.meanCl.toFixed(3)}`, 95, 15);
  }
}
