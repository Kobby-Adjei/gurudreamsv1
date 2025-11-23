
import React, { useRef, useEffect, useState, useImperativeHandle, forwardRef } from 'react';
import { DrawingSettings, ToolType } from '../types';

interface CanvasProps {
  width: number;
  height: number;
  settings: DrawingSettings;
  layers: string[]; // [Back, Mid, Fore]
  activeLayerIndex: number;
  currentFrameId: string; // NEW: Needed to track when to actually reset history
  prevFrameData?: string; // Onion skin composite
  onionSkin: boolean;
  showGrid: boolean;
  onDrawEnd: (newLayerData: string, newCompositeData: string) => void;
  isPlaying: boolean;
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
  onPickColor: (color: string) => void; // New prop for picker
}

export interface CanvasHandle {
  undo: () => void;
  redo: () => void;
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(({
  width,
  height,
  settings,
  layers,
  activeLayerIndex,
  currentFrameId,
  prevFrameData,
  onionSkin,
  showGrid,
  onDrawEnd,
  isPlaying,
  onHistoryChange,
  onPickColor
}, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const lastPos = useRef<{ x: number; y: number; pressure: number } | null>(null);

  // History State
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const ignoreFrameUpdate = useRef(false);

  // Expose Undo/Redo methods to parent
  useImperativeHandle(ref, () => ({
    undo: () => {
      if (historyIndexRef.current > 0) {
        historyIndexRef.current--;
        const previousData = historyRef.current[historyIndexRef.current];
        ignoreFrameUpdate.current = true; // Tell useEffect not to reset history
        updateLayerAndComposite(previousData);
        drawDataToCanvas(previousData);
        updateHistoryState();
      }
    },
    redo: () => {
      if (historyIndexRef.current < historyRef.current.length - 1) {
        historyIndexRef.current++;
        const nextData = historyRef.current[historyIndexRef.current];
        ignoreFrameUpdate.current = true;
        updateLayerAndComposite(nextData);
        drawDataToCanvas(nextData);
        updateHistoryState();
      }
    }
  }));

  const updateHistoryState = () => {
    onHistoryChange(
      historyIndexRef.current > 0,
      historyIndexRef.current < historyRef.current.length - 1
    );
  };

  const addToHistory = (dataUrl: string) => {
    // If we are in the middle of the stack, chop off the future
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);
    }
    historyRef.current.push(dataUrl);

    // Limit history size to prevent memory leaks
    if (historyRef.current.length > 20) {
      historyRef.current.shift();
    } else {
      historyIndexRef.current++;
    }
    updateHistoryState();
  };

  const drawDataToCanvas = (data: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, width, height);
    };
    img.src = data;
  };

  // --- CRITICAL FIX --- 
  // Only reset history if the Frame ID or Active Layer changes. 
  // We do NOT depend on `layers` content here, otherwise every stroke resets history.
  useEffect(() => {
    if (ignoreFrameUpdate.current) {
      ignoreFrameUpdate.current = false;
      return;
    }

    const currentLayerData = layers[activeLayerIndex] || layers[0] || '';

    // Initialize history with the current state of the layer
    historyRef.current = [currentLayerData];
    historyIndexRef.current = 0;
    updateHistoryState();

    drawDataToCanvas(currentLayerData);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFrameId, activeLayerIndex, width, height]);

  // Helper to composite all layers including the new update
  const updateLayerAndComposite = (newActiveLayerData: string) => {
    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = width;
    compositeCanvas.height = height;
    const ctx = compositeCanvas.getContext('2d');
    if (!ctx) return;

    // Fill white background for composite
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);

    const loadAndDraw = async () => {
      const promises = layers.map((layerData, idx) => {
        return new Promise<HTMLImageElement>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          // Use the NEW data for the active layer, existing data for others
          img.src = idx === activeLayerIndex ? newActiveLayerData : layerData;
        });
      });

      const images = await Promise.all(promises);
      images.forEach(img => {
        ctx.drawImage(img, 0, 0, width, height);
      });

      onDrawEnd(newActiveLayerData, compositeCanvas.toDataURL());
    };
    loadAndDraw();
  };

  // --- Flood Fill Algorithm ---
  const hexToRgba = (hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b, 255];
  };

  const floodFill = (startX: number, startY: number, fillColorHex: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    const startPos = (startY * width + startX) * 4;
    const [startR, startG, startB, startA] = [data[startPos], data[startPos + 1], data[startPos + 2], data[startPos + 3]];
    const [fillR, fillG, fillB, fillA] = hexToRgba(fillColorHex);

    // Tolerance check could be added here, but exact match for now
    if (startR === fillR && startG === fillG && startB === fillB && startA === fillA) return;

    const matchStartColor = (pos: number) => {
      return data[pos] === startR && data[pos + 1] === startG && data[pos + 2] === startB && data[pos + 3] === startA;
    };

    const colorPixel = (pos: number) => {
      data[pos] = fillR;
      data[pos + 1] = fillG;
      data[pos + 2] = fillB;
      data[pos + 3] = fillA;
    };

    const stack = [[startX, startY]];

    while (stack.length) {
      const pop = stack.pop();
      if (!pop) continue;
      let [x, y] = pop;
      let pos = (y * width + x) * 4;

      while (y >= 0 && matchStartColor(pos)) {
        y--;
        pos -= width * 4;
      }
      pos += width * 4;
      y++;

      let reachLeft = false;
      let reachRight = false;

      while (y < height && matchStartColor(pos)) {
        colorPixel(pos);

        if (x > 0) {
          if (matchStartColor(pos - 4)) {
            if (!reachLeft) {
              stack.push([x - 1, y]);
              reachLeft = true;
            }
          } else if (reachLeft) {
            reachLeft = false;
          }
        }

        if (x < width - 1) {
          if (matchStartColor(pos + 4)) {
            if (!reachRight) {
              stack.push([x + 1, y]);
              reachRight = true;
            }
          } else if (reachRight) {
            reachRight = false;
          }
        }

        y++;
        pos += width * 4;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    const newData = canvas.toDataURL();
    addToHistory(newData);
    updateLayerAndComposite(newData);
  };

  const pickColorAt = (x: number, y: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    // We only read from the active layer canvas. 
    // Ideally we'd read from composite, but that requires merging first or reading the visual state.
    // For simplicity, let's read the current layer. If transparent, default to white or underlying?
    // Let's grab data from current context.

    const pixel = ctx.getImageData(x, y, 1, 1).data;
    const r = pixel[0].toString(16).padStart(2, '0');
    const g = pixel[1].toString(16).padStart(2, '0');
    const b = pixel[2].toString(16).padStart(2, '0');
    // Simple RGB, ignoring alpha for now or assuming white bg if alpha 0
    onPickColor(`#${r}${g}${b}`.toUpperCase());
  };

  // --- Input Handling ---

  const getCoordinates = (e: React.PointerEvent, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      offsetX: (e.clientX - rect.left) * scaleX,
      offsetY: (e.clientY - rect.top) * scaleY,
    };
  };

  const getPressureLineWidth = (baseSize: number, pressure: number, tool: ToolType, pointerType: string) => {
    if (tool === ToolType.ERASER) return baseSize;

    // If not a pen, or if pressure is default (0.5 often means "unknown" or mouse), treat as full
    if (pointerType !== 'pen' || pressure === 0.5) {
      if (tool === ToolType.PENCIL || tool === ToolType.CRAYON) return baseSize * 0.8;
      return baseSize;
    }

    // Boost pressure sensitivity for iPad/Tablets
    // Use an even flatter curve (power 0.2) to make light touches very strong
    // Increase minimum floor to 0.5 to ensure visibility
    const p = Math.max(Math.pow(pressure, 0.2), 0.5);

    if (tool === ToolType.PENCIL || tool === ToolType.CRAYON) {
      return baseSize * (0.6 + p * 0.4); // Range: 0.8 to 1.0 * base (approx)
    } else if (tool === ToolType.MARKER) {
      return baseSize * (0.7 + p * 0.3);
    } else {
      // Brush/Watercolor dynamic range
      const minSize = baseSize * 0.5;
      const variableSize = baseSize * 1.5 * p;
      return Math.max(minSize, variableSize);
    }
  };

  const startDrawing = (e: React.PointerEvent) => {
    if (isPlaying) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.setPointerCapture(e.pointerId);

    const { offsetX, offsetY } = getCoordinates(e, canvas);

    if (settings.tool === ToolType.PICKER) {
      pickColorAt(Math.floor(offsetX), Math.floor(offsetY));
      return;
    }

    if (settings.tool === ToolType.FILL) {
      floodFill(Math.floor(offsetX), Math.floor(offsetY), settings.color);
      return;
    }

    setIsDrawing(true);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const pressure = e.pressure !== 0 ? e.pressure : 0.5;
    lastPos.current = { x: offsetX, y: offsetY, pressure };

    const currentWidth = getPressureLineWidth(settings.brushSize, pressure, settings.tool, e.pointerType);

    // Initial setup for the stroke
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (settings.tool === ToolType.ERASER) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000000'; // Color doesn't matter for destination-out
      ctx.strokeStyle = '#000000';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = settings.color;
      ctx.strokeStyle = settings.color;
    }

    ctx.globalAlpha = 1.0;
    if (settings.tool === ToolType.MARKER) ctx.globalAlpha = 0.5;

    // Draw initial dot
    if (settings.tool === ToolType.PENCIL || settings.tool === ToolType.CRAYON) {
      drawTextureDot(ctx, offsetX, offsetY, currentWidth, pressure, settings.color, settings.tool);
    } else {
      ctx.beginPath();
      ctx.arc(offsetX, offsetY, currentWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const drawTextureDot = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number, pressure: number, color: string, tool: ToolType) => {
    const isCrayon = tool === ToolType.CRAYON;
    const maxOpacity = isCrayon ? 1.0 : 0.8;

    // Boost pressure for opacity too
    const pRaw = pressure <= 0 ? 0.5 : pressure;
    // Stronger boost: power 0.2 and min 0.5
    const p = Math.max(Math.pow(pRaw, 0.2), 0.5);

    // Minimum opacity 0.5 to ensure strokes are never too faint
    const opacity = Math.max(0.5, Math.min(maxOpacity, p * (isCrayon ? 2.0 : 1.5)));

    const oldAlpha = ctx.globalAlpha;
    const oldComposite = ctx.globalCompositeOperation;
    const oldFill = ctx.fillStyle;

    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;

    if (tool === ToolType.ERASER) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000000';
      ctx.globalAlpha = 1.0;
    }

    const roughness = size * (isCrayon ? 0.6 : 0.2);

    ctx.beginPath();
    const jx = x + (Math.random() - 0.5) * roughness;
    const jy = y + (Math.random() - 0.5) * roughness;
    const particleSize = isCrayon ? size * 0.8 : size * 0.5;

    ctx.arc(jx, jy, particleSize, 0, Math.PI * 2);
    ctx.fill();

    // Restore context
    ctx.globalAlpha = oldAlpha;
    ctx.globalCompositeOperation = oldComposite;
    ctx.fillStyle = oldFill;
  };

  const draw = (e: React.PointerEvent) => {
    // If picker is active, maybe update a preview? For now, do nothing on move
    if (!isDrawing || isPlaying || !lastPos.current || settings.tool === ToolType.FILL || settings.tool === ToolType.PICKER) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Prevent default touch actions like scrolling
    e.preventDefault();

    const { offsetX, offsetY } = getCoordinates(e, canvas);
    const pressure = e.pressure !== 0 ? e.pressure : 0.5;
    const currentWidth = getPressureLineWidth(settings.brushSize, pressure, settings.tool, e.pointerType);

    if (settings.tool === ToolType.ERASER) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = '#000000';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = settings.color;
    }

    if (settings.tool === ToolType.MARKER) ctx.globalAlpha = 0.5;
    else ctx.globalAlpha = 1.0;

    if (settings.tool === ToolType.PENCIL || settings.tool === ToolType.CRAYON) {
      const dist = Math.hypot(offsetX - lastPos.current.x, offsetY - lastPos.current.y);
      const angle = Math.atan2(offsetY - lastPos.current.y, offsetX - lastPos.current.x);
      const step = settings.tool === ToolType.CRAYON ? 2 : 1;

      for (let i = 0; i < dist; i += step) {
        const x = lastPos.current.x + Math.cos(angle) * i;
        const y = lastPos.current.y + Math.sin(angle) * i;
        // Linear interpolation of pressure
        const ratio = i / dist;
        const p = lastPos.current.pressure + (pressure - lastPos.current.pressure) * ratio;
        const w = getPressureLineWidth(settings.brushSize, p, settings.tool, e.pointerType);
        drawTextureDot(ctx, x, y, w, p, settings.color, settings.tool);
      }
    } else {
      ctx.lineWidth = currentWidth;
      ctx.beginPath();
      ctx.moveTo(lastPos.current.x, lastPos.current.y);
      ctx.lineTo(offsetX, offsetY);
      ctx.stroke();

      // Fill gaps in fast strokes with circles
      ctx.beginPath();
      ctx.arc(offsetX, offsetY, currentWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Reset standard context
    ctx.globalAlpha = 1.0;
    ctx.globalCompositeOperation = 'source-over';
    lastPos.current = { x: offsetX, y: offsetY, pressure };
  };

  const stopDrawing = (e: React.PointerEvent) => {
    if (settings.tool === ToolType.PICKER) return;

    if (!isDrawing) return;

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.releasePointerCapture(e.pointerId);
      const newData = canvas.toDataURL();
      // IMPORTANT: Add to history BEFORE updating parent to ensure sync
      addToHistory(newData);
      updateLayerAndComposite(newData);
    }

    setIsDrawing(false);
    lastPos.current = null;
  };

  return (
    <div className="relative shadow-sm bg-[#FAFAF8] rounded-xl overflow-hidden touch-none select-none w-full h-full" style={{ touchAction: 'none' }}>

      {/* Warm Paper Texture Background */}
      <div className="absolute inset-0 opacity-[0.05] pointer-events-none z-0"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
          backgroundSize: 'cover'
        }}
      />

      {/* Grid */}
      {showGrid && (
        <div className="absolute inset-0 pointer-events-none opacity-10 z-[10]"
          style={{
            backgroundImage: `linear-gradient(#000 1px, transparent 1px), linear-gradient(90deg, #000 1px, transparent 1px)`,
            backgroundSize: '50px 50px'
          }}
        />
      )}

      {/* Onion Skin */}
      {onionSkin && prevFrameData && !isPlaying && (
        <img
          src={prevFrameData}
          alt="onion-skin"
          className="absolute inset-0 pointer-events-none opacity-30 select-none w-full h-full object-contain z-[5]"
        />
      )}

      {/* Inactive Layers */}
      {layers.map((layerSrc, index) => (
        index !== activeLayerIndex ? (
          <img
            key={index}
            src={layerSrc}
            alt={`layer-${index}`}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: index + 1 }}
          />
        ) : null
      ))}

      {/* Active Interactive Canvas */}
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        onPointerDown={startDrawing}
        onPointerMove={draw}
        onPointerUp={stopDrawing}
        onPointerLeave={stopDrawing}
        className="absolute inset-0 touch-none w-full h-full"
        style={{
          touchAction: 'none',
          cursor: settings.tool === ToolType.ERASER ? 'cell' : settings.tool === ToolType.FILL ? 'pointer' : settings.tool === ToolType.PICKER ? 'crosshair' : 'crosshair',
          zIndex: activeLayerIndex + 1
        }}
      />
    </div>
  );
});
