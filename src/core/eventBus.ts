import type {
  AerodynamicTelemetry,
  GPUCapabilitiesReport,
  GizmoMode,
  MeshStats,
  ModelTransform,
  PresetModelId,
  WindTunnelState,
} from './types';

export interface AppEvents {
  'state:changed': WindTunnelState;
  'mesh:loaded': { stats: MeshStats; source: PresetModelId | 'uploaded_stl' };
  'mesh:transformed': { transform: ModelTransform; stats: MeshStats };
  'telemetry:updated': AerodynamicTelemetry;
  'gpu:initialized': GPUCapabilitiesReport;
  'gizmo:mode': GizmoMode;
  'camera:reset': void;
}

type Listener<T> = (payload: T) => void;

export class EventBus {
  private listeners = new Map<keyof AppEvents, Set<Listener<any>>>();

  public on<K extends keyof AppEvents>(event: K, listener: Listener<AppEvents[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  public off<K extends keyof AppEvents>(event: K, listener: Listener<AppEvents[K]>): void {
    this.listeners.get(event)?.delete(listener);
  }

  public emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      listener(payload);
    }
  }
}

export const eventBus = new EventBus();
