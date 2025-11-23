import React, { useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { DrawObject, DrawingSettings, ToolType } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { Copy, Trash2 } from 'lucide-react';

interface ObjectCanvasProps {
  width: number;
  height: number;
  settings: DrawingSettings;
  objects: DrawObject[];
  onObjectsChange: (objects: DrawObject[]) => void;
  isPlaying: boolean;
}

export interface ObjectCanvasHandle {
  copySelected: () => void;
  pasteObject: () => void;
  deleteSelected: () => void;
}

export const ObjectCanvas = forwardRef<ObjectCanvasHandle, ObjectCanvasProps>(({
  width,
  height,
  settings,
  objects,
  onObjectsChange,
  isPlaying
}, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPath, setCurrentPath] = useState<{ x: number; y: number; pressure?: number }[]>([]);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [resizeHandle, setResizeHandle] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<DrawObject | null>(null);

  const selectedObject = objects.find(obj => obj.id === selectedObjectId);

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    copySelected: () => {
      if (selectedObject) {
        setClipboard({ ...selectedObject, id: uuidv4() });
      }
    },
    pasteObject: () => {
      if (clipboard) {
        const newObj = {
          ...clipboard,
          id: uuidv4(),
          bounds: {
            ...clipboard.bounds,
            x: clipboard.bounds.x + 20,
            y: clipboard.bounds.y + 20
          }
        };
        onObjectsChange([...objects, newObj]);
        setSelectedObjectId(newObj.id);
      }
    },
    deleteSelected: () => {
      if (selectedObjectId) {
        onObjectsChange(objects.filter(obj => obj.id !== selectedObjectId));
        setSelectedObjectId(null);
      }
    }
  }));

  // Calculate bounding box for a path
  const calculateBounds = (paths: { x: number; y: number }[], brushSize: number) => {
    if (paths.length === 0) return { x: 0, y: 0, width: 0, height: 0 };

    let minX = paths[0].x;
    let minY = paths[0].y;
    let maxX = paths[0].x;
    let maxY = paths[0].y;

    paths.forEach(p => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    });

    const padding = brushSize;
    return {
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2
    };
  };

  // Check if point is inside bounds
  const isPointInBounds = (x: number, y: number, bounds: { x: number; y: number; width: number; height: number }) => {
    return x >= bounds.x && x <= bounds.x + bounds.width &&
           y >= bounds.y && y <= bounds.y + bounds.height;
  };

  // Get resize handle at point
  const getResizeHandle = (x: number, y: number, bounds: { x: number; y: number; width: number; height: number }) => {
    const handleSize = 10;
    const handles = {
      'nw': { x: bounds.x, y: bounds.y },
      'ne': { x: bounds.x + bounds.width, y: bounds.y },
      'sw': { x: bounds.x, y: bounds.y + bounds.height },
      'se': { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      'n': { x: bounds.x + bounds.width / 2, y: bounds.y },
      's': { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height },
      'w': { x: bounds.x, y: bounds.y + bounds.height / 2 },
      'e': { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 }
    };

    for (const [handle, pos] of Object.entries(handles)) {
      if (Math.abs(x - pos.x) < handleSize && Math.abs(y - pos.y) < handleSize) {
        return handle;
      }
    }
    return null;
  };

  // Get coordinates from event
  const getCoordinates = (e: React.PointerEvent, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  // Draw object on canvas
  const drawObject = (ctx: CanvasRenderingContext2D, obj: DrawObject) => {
    if (obj.paths.length === 0) return;

    ctx.save();

    // Apply rotation if needed
    if (obj.rotation !== 0) {
      const centerX = obj.bounds.x + obj.bounds.width / 2;
      const centerY = obj.bounds.y + obj.bounds.height / 2;
      ctx.translate(centerX, centerY);
      ctx.rotate(obj.rotation);
      ctx.translate(-centerX, -centerY);
    }

    ctx.strokeStyle = obj.color;
    ctx.fillStyle = obj.color;
    ctx.lineWidth = obj.brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = obj.tool === ToolType.MARKER ? 0.5 : 1.0;

    ctx.beginPath();
    ctx.moveTo(obj.paths[0].x, obj.paths[0].y);

    for (let i = 1; i < obj.paths.length; i++) {
      ctx.lineTo(obj.paths[i].x, obj.paths[i].y);
    }

    ctx.stroke();
    ctx.restore();
  };

  // Draw selection box and handles
  const drawSelection = (ctx: CanvasRenderingContext2D, bounds: { x: number; y: number; width: number; height: number }) => {
    ctx.save();
    ctx.strokeStyle = '#007AFF';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    ctx.setLineDash([]);

    // Draw handles
    const handleSize = 8;
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#007AFF';
    ctx.lineWidth = 2;

    const handles = [
      { x: bounds.x, y: bounds.y }, // nw
      { x: bounds.x + bounds.width, y: bounds.y }, // ne
      { x: bounds.x, y: bounds.y + bounds.height }, // sw
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, // se
      { x: bounds.x + bounds.width / 2, y: bounds.y }, // n
      { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height }, // s
      { x: bounds.x, y: bounds.y + bounds.height / 2 }, // w
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 } // e
    ];

    handles.forEach(handle => {
      ctx.fillRect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize);
      ctx.strokeRect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize);
    });

    ctx.restore();
  };

  // Redraw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    // Draw all objects
    objects.forEach(obj => drawObject(ctx, obj));

    // Draw current path
    if (currentPath.length > 0 && isDrawing) {
      ctx.strokeStyle = settings.color;
      ctx.lineWidth = settings.brushSize;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = settings.tool === ToolType.MARKER ? 0.5 : 1.0;

      ctx.beginPath();
      ctx.moveTo(currentPath[0].x, currentPath[0].y);
      currentPath.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.stroke();
    }

    // Draw selection
    if (selectedObject && settings.tool === ToolType.SELECT) {
      drawSelection(ctx, selectedObject.bounds);
    }
  }, [objects, currentPath, selectedObject, settings, width, height, isDrawing]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (isPlaying) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.setPointerCapture(e.pointerId);
    const { x, y } = getCoordinates(e, canvas);

    if (settings.tool === ToolType.SELECT) {
      // Check if clicking on a resize handle
      if (selectedObject) {
        const handle = getResizeHandle(x, y, selectedObject.bounds);
        if (handle) {
          setIsResizing(true);
          setResizeHandle(handle);
          setDragStart({ x, y });
          return;
        }

        // Check if clicking inside selected object
        if (isPointInBounds(x, y, selectedObject.bounds)) {
          setIsDragging(true);
          setDragStart({ x, y });
          return;
        }
      }

      // Check if clicking on any object
      for (let i = objects.length - 1; i >= 0; i--) {
        if (isPointInBounds(x, y, objects[i].bounds)) {
          setSelectedObjectId(objects[i].id);
          setIsDragging(true);
          setDragStart({ x, y });
          return;
        }
      }

      // Deselect if clicking on empty space
      setSelectedObjectId(null);
    } else if (settings.tool !== ToolType.FILL && settings.tool !== ToolType.PICKER && settings.tool !== ToolType.ERASER) {
      // Start drawing a new object
      setIsDrawing(true);
      setCurrentPath([{ x, y, pressure: e.pressure || 0.5 }]);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isPlaying) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { x, y } = getCoordinates(e, canvas);

    if (isDrawing && currentPath.length > 0) {
      setCurrentPath(prev => [...prev, { x, y, pressure: e.pressure || 0.5 }]);
    } else if (isDragging && dragStart && selectedObject) {
      const dx = x - dragStart.x;
      const dy = y - dragStart.y;

      const updatedObjects = objects.map(obj => {
        if (obj.id === selectedObjectId) {
          return {
            ...obj,
            bounds: {
              ...obj.bounds,
              x: obj.bounds.x + dx,
              y: obj.bounds.y + dy
            },
            paths: obj.paths.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }))
          };
        }
        return obj;
      });

      onObjectsChange(updatedObjects);
      setDragStart({ x, y });
    } else if (isResizing && dragStart && selectedObject && resizeHandle) {
      const dx = x - dragStart.x;
      const dy = y - dragStart.y;

      let newBounds = { ...selectedObject.bounds };
      const scaleX = (newBounds.width + dx) / newBounds.width;
      const scaleY = (newBounds.height + dy) / newBounds.height;

      // Simple resize for now - proportional scaling
      if (resizeHandle.includes('e')) {
        newBounds.width += dx;
      }
      if (resizeHandle.includes('w')) {
        newBounds.x += dx;
        newBounds.width -= dx;
      }
      if (resizeHandle.includes('s')) {
        newBounds.height += dy;
      }
      if (resizeHandle.includes('n')) {
        newBounds.y += dy;
        newBounds.height -= dy;
      }

      const updatedObjects = objects.map(obj => {
        if (obj.id === selectedObjectId) {
          return {
            ...obj,
            bounds: newBounds
          };
        }
        return obj;
      });

      onObjectsChange(updatedObjects);
      setDragStart({ x, y });
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.releasePointerCapture(e.pointerId);
    }

    if (isDrawing && currentPath.length > 1) {
      const newObject: DrawObject = {
        id: uuidv4(),
        type: 'stroke',
        paths: currentPath,
        color: settings.color,
        brushSize: settings.brushSize,
        tool: settings.tool,
        bounds: calculateBounds(currentPath, settings.brushSize),
        rotation: 0
      };

      onObjectsChange([...objects, newObject]);
      setCurrentPath([]);
    }

    setIsDrawing(false);
    setIsDragging(false);
    setIsResizing(false);
    setResizeHandle(null);
    setDragStart(null);
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        className="absolute inset-0 touch-none w-full h-full"
        style={{
          touchAction: 'none',
          cursor: settings.tool === ToolType.SELECT ? 'default' : 'crosshair',
          zIndex: 10
        }}
      />

      {/* Action buttons for selected object */}
      {selectedObject && settings.tool === ToolType.SELECT && (
        <div
          className="absolute bg-white rounded-lg shadow-lg flex gap-2 p-2 z-20"
          style={{
            left: `${selectedObject.bounds.x + selectedObject.bounds.width + 10}px`,
            top: `${selectedObject.bounds.y}px`
          }}
        >
          <button
            onClick={() => {
              if (selectedObject) {
                setClipboard({ ...selectedObject, id: uuidv4() });
              }
            }}
            className="p-2 hover:bg-gray-100 rounded transition-colors"
            title="Copy"
          >
            <Copy size={16} />
          </button>
          <button
            onClick={() => {
              if (selectedObjectId) {
                onObjectsChange(objects.filter(obj => obj.id !== selectedObjectId));
                setSelectedObjectId(null);
              }
            }}
            className="p-2 hover:bg-red-50 text-red-500 rounded transition-colors"
            title="Delete"
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}
    </>
  );
});
