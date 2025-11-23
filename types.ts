
export interface DrawObject {
  id: string;
  type: 'stroke' | 'shape';
  paths: { x: number; y: number; pressure?: number }[];
  color: string;
  brushSize: number;
  tool: ToolType;
  bounds: { x: number; y: number; width: number; height: number };
  rotation: number;
}

export interface Frame {
  id: string;
  dataUrl: string; // Base64 composite image for playback/timeline
  layers: string[]; // Array of 3 Base64 images [Background, Middle, Foreground]
  objects?: DrawObject[][]; // Array of 3 object arrays for each layer
}

export enum ToolType {
  BRUSH = 'BRUSH',   // Smooth Ink/Pen
  PENCIL = 'PENCIL', // Textured Graphite
  MARKER = 'MARKER', // Thick, semi-transparent
  CRAYON = 'CRAYON', // Waxy texture
  ERASER = 'ERASER',
  FILL = 'FILL',     // Paint Bucket
  PICKER = 'PICKER', // Eyedropper
  SELECT = 'SELECT', // Selection tool
}

export interface AnimationState {
  frames: Frame[];
  currentFrameIndex: number;
  isPlaying: boolean;
  fps: number;
  onionSkin: boolean;
}

export interface DrawingSettings {
  color: string;
  brushSize: number;
  tool: ToolType;
}

export interface Project {
  id: string;
  name: string;
  lastModified: number;
  previewImage: string; // URL of the first frame
  frames: Frame[];
  fps: number;
}

export interface Tutorial {
  id: string;
  title: string;
  description: string;
  videoUrl: string; // YouTube Embed URL
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced';
  thumbnail: string;
}
