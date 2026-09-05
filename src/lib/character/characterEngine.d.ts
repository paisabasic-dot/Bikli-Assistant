export type CharacterActivity = "idle" | "listening" | "thinking" | "talking";

export type CharacterEmotion =
  | "idle"
  | "neutral"
  | "happy"
  | "excited"
  | "curious"
  | "thinking"
  | "proud"
  | "sad"
  | "confused"
  | "surprised"
  | "embarrassed"
  | "playful"
  | "listening";

export interface FrameInput {
  activity: CharacterActivity;
  emotion: CharacterEmotion;
  outputAnalyser: AnalyserNode | null;
  inputAnalyser: AnalyserNode | null;
}

export interface CharacterBehaviour {
  name: string;
  duration: number;
  weight: number;
  allowedIn?: CharacterActivity[];
  gaze?: "user" | "wander" | "away";
  blinkOnStart?: boolean;
  idleIntensity?: number;
  expression?: Record<string, number>;
  pose?: (progress: number, weight: number, poseManager: any, bones: any) => void;
}

export interface CharacterConfig {
  id: string;
  displayName: string;
  modelUrl: string;
  textureMapUrl: string;
  scale: number;
  groundOffset: number;
  bones: Record<string, string>;
  basePose: Record<string, any>;
  outline: { enabled: boolean; scale: number };
  morphs: Record<string, string>;
  materialRoles: Record<string, string[]>;
  materialTuning: Record<string, any>;
  [key: string]: any;
}

export interface EngineInitOptions {
  canvas: HTMLCanvasElement;
  config: CharacterConfig;
  onProgress?: (phase: string, ratio: number) => void;
  onError?: (error: Error) => void;
}

export class BikliCharacterEngine {
  constructor(options: EngineInitOptions);

  readonly isLoaded: boolean;
  readonly isViewLocked: boolean;
  readonly isEyeTracking: boolean;
  readonly diagnostics: Record<string, any>;

  load(): Promise<void>;
  start(): void;
  stop(): void;
  dispose(): void;
  resize(width: number, height: number): void;

  setFrameInput(input: FrameInput): void;
  setExpression(emotion: string, duration?: number): void;
  triggerBehaviour(name: string): boolean;

  setPointer(ndcX: number, ndcY: number): void;
  orbitBy(deltaYaw: number, deltaPitch: number): void;
  zoomBy(delta: number): void;
  resetView(): void;
  setView(preset: "front" | "threeQuarter" | "right" | "back"): void;
  setViewLocked(locked: boolean): void;
  setEyeTracking(tracking: boolean): void;
  setReflectionStrength(strength: number): void;
}

export const bikliConfig: CharacterConfig;
export const BIKLI_BEHAVIOURS: CharacterBehaviour[];
export const BIKLI_EMOTIONS: string[];
export const BIKLI_ACTIVITIES: CharacterActivity[];
