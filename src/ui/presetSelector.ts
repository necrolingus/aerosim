import { PRESET_MODELS } from '../geometry/presets';
import type { PresetModelId } from '../core/types';

export interface PresetSelectorCallbacks {
  onSelectPreset: (id: PresetModelId) => void;
  onUploadSTL: (file: File) => void;
}

export class PresetSelectorUI {
  private container: HTMLElement;
  private activeId: PresetModelId | 'uploaded_stl' = 'sphere';
  private callbacks: PresetSelectorCallbacks;

  constructor(container: HTMLElement, callbacks: PresetSelectorCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.render();
  }

  public setActive(id: PresetModelId | 'uploaded_stl'): void {
    this.activeId = id;
    const buttons = this.container.querySelectorAll<HTMLButtonElement>('[data-preset-id]');
    buttons.forEach((btn) => {
      const btnId = btn.getAttribute('data-preset-id');
      btn.classList.toggle('active', btnId === id);
    });

    const descEl = this.container.querySelector('#preset-description');
    if (descEl) {
      if (id === 'uploaded_stl') {
        descEl.textContent = 'Custom uploaded STL geometry. Use transform gizmos (W/E/R) to orient into the +X wind.';
      } else {
        const meta = PRESET_MODELS[id];
        descEl.textContent = `${meta.description} Reference Cd: ${meta.theoreticalCd}`;
      }
    }
  }

  private render(): void {
    const presetButtonsHtml = Object.values(PRESET_MODELS)
      .map(
        (preset) => `
        <button
          type="button"
          class="preset-btn ${preset.id === this.activeId ? 'active' : ''}"
          data-preset-id="${preset.id}"
          title="${preset.description}"
        >
          <span class="preset-cat">${preset.category}</span>
          <span class="preset-name">${preset.name}</span>
        </button>
      `
      )
      .join('');

    this.container.innerHTML = `
      <div class="panel-section">
        <div class="section-header">
          <span class="section-title">1. TEST SPECIMEN / STL</span>
          <span class="badge-accent">STAGE</span>
        </div>

        <label class="stl-upload-zone" for="stl-file-input">
          <input type="file" id="stl-file-input" accept=".stl" hidden />
          <div class="upload-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
              <path d="M12 18V4M5 11l7-7 7 7" />
              <path d="M4 20h16" />
            </svg>
          </div>
          <div class="upload-text">
            <strong>Upload Custom STL Mesh</strong>
            <span>Binary or ASCII STL (auto-detects mm / m scale)</span>
          </div>
        </label>

        <div class="preset-grid">
          ${presetButtonsHtml}
        </div>
        <p id="preset-description" class="preset-desc">
          ${PRESET_MODELS.sphere.description} Reference Cd: ${PRESET_MODELS.sphere.theoreticalCd}
        </p>
      </div>
    `;

    const buttons = this.container.querySelectorAll<HTMLButtonElement>('[data-preset-id]');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-preset-id') as PresetModelId;
        this.setActive(id);
        this.callbacks.onSelectPreset(id);
      });
    });

    const fileInput = this.container.querySelector<HTMLInputElement>('#stl-file-input');
    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) {
        this.setActive('uploaded_stl');
        this.callbacks.onUploadSTL(file);
        fileInput.value = '';
      }
    });
  }
}
