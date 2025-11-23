
import React, { useState, useRef, useEffect } from 'react';
import { Pen, Pencil, Eraser, Trash2, Highlighter, Brush, PaintBucket, Undo2, Redo2, Grid3X3, Layers, Pipette } from 'lucide-react';
import { ToolType, DrawingSettings } from '../types';
import { ColorPicker } from './ColorPicker';

interface ToolbarProps {
  settings: DrawingSettings;
  onUpdateSettings: (settings: Partial<DrawingSettings>) => void;
  onClear: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleGrid: () => void;
  onToggleLayers: () => void;
  showGrid: boolean;
  showLayers: boolean;
  canUndo: boolean;
  canRedo: boolean;
  orientation?: 'vertical' | 'horizontal';
  compact?: boolean;
}

const PRESET_COLORS = [
  '#000000', '#FF3B30', '#007AFF', '#34C759', '#FFCC00'
];

const SIZES = [2, 5, 10, 20, 40];

export const Toolbar: React.FC<ToolbarProps> = ({ 
    settings, 
    onUpdateSettings, 
    onClear, 
    onUndo,
    onRedo,
    onToggleGrid,
    onToggleLayers,
    showGrid,
    showLayers,
    canUndo,
    canRedo,
    orientation = 'horizontal',
    compact = false
}) => {
  const isVertical = orientation === 'vertical';
  const [showColorPicker, setShowColorPicker] = useState(false);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        pickerRef.current && 
        !pickerRef.current.contains(event.target as Node) &&
        colorButtonRef.current &&
        !colorButtonRef.current.contains(event.target as Node)
      ) {
        setShowColorPicker(false);
      }
    };

    if (showColorPicker) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showColorPicker]);

  const ToolButton = ({ type, icon: Icon, label }: { type: ToolType, icon: any, label: string }) => (
    <button
      type="button"
      onClick={() => onUpdateSettings({ tool: type })}
      className={`p-3 rounded-xl transition-all duration-200 group relative flex-shrink-0 border ${
        settings.tool === type 
            ? 'bg-gray-900 text-white shadow-md border-gray-900 scale-105 z-10' 
            : 'bg-transparent text-gray-500 hover:bg-gray-100 border-transparent'
      }`}
      title={label}
      aria-label={label}
      aria-pressed={settings.tool === type}
    >
      <Icon size={24} strokeWidth={settings.tool === type ? 2.5 : 2} />
    </button>
  );

  return (
    <div className="relative">
        <div className={`
            glass-panel rounded-[2rem] p-3 shadow-glass transition-all duration-300
            flex ${isVertical ? 'flex-col' : 'flex-row'} items-center gap-3
            max-h-[85vh] overflow-y-auto no-scrollbar
            border border-white/60 bg-white/90 backdrop-blur-xl
            z-30
        `}>
        
        {/* History & Helpers */}
        <div className={`flex ${isVertical ? 'flex-col' : 'flex-row'} gap-2 pb-2 ${isVertical ? 'border-b w-full justify-center' : 'border-r h-full'} border-gray-200/50`}>
            <button 
                type="button"
                onClick={onUndo} 
                disabled={!canUndo}
                className={`p-3 rounded-full transition-colors ${!canUndo ? 'text-gray-300' : 'text-gray-700 hover:bg-gray-100 active:bg-gray-200'}`}
                title="Undo"
            >
                <Undo2 size={20} />
            </button>
            <button 
                type="button"
                onClick={onRedo} 
                disabled={!canRedo}
                className={`p-3 rounded-full transition-colors ${!canRedo ? 'text-gray-300' : 'text-gray-700 hover:bg-gray-100 active:bg-gray-200'}`}
                title="Redo"
            >
                <Redo2 size={20} />
            </button>
            <button 
                type="button"
                onClick={onToggleGrid} 
                className={`p-3 rounded-full transition-colors ${showGrid ? 'bg-apple-blue/10 text-apple-blue' : 'text-gray-400 hover:bg-gray-100'}`}
                title="Toggle Grid"
            >
                <Grid3X3 size={20} />
            </button>
            <button 
                type="button"
                onClick={onToggleLayers} 
                className={`p-3 rounded-full transition-colors ${showLayers ? 'bg-apple-blue/10 text-apple-blue' : 'text-gray-400 hover:bg-gray-100'}`}
                title="Layers"
            >
                <Layers size={20} />
            </button>
        </div>

        {/* Tools */}
        <div className={`flex ${isVertical ? 'flex-col' : 'flex-row'} gap-2`}>
            <ToolButton type={ToolType.PENCIL} icon={Pencil} label="Pencil" />
            <ToolButton type={ToolType.BRUSH} icon={Pen} label="Pen" />
            <ToolButton type={ToolType.MARKER} icon={Highlighter} label="Marker" />
            <ToolButton type={ToolType.CRAYON} icon={Brush} label="Crayon" />
            <ToolButton type={ToolType.FILL} icon={PaintBucket} label="Fill" />
            <ToolButton type={ToolType.ERASER} icon={Eraser} label="Eraser" />
            <ToolButton type={ToolType.PICKER} icon={Pipette} label="Color Picker" />
        </div>

        {/* Separator */}
        <div className={`${isVertical ? 'w-full h-px' : 'w-px h-full'} bg-gray-200/50 my-1`} />

        {/* Color Button */}
        <div className="flex flex-col gap-2 items-center">
            <button
                ref={colorButtonRef}
                type="button"
                onClick={() => setShowColorPicker(!showColorPicker)}
                className={`
                    w-10 h-10 rounded-full border-2 border-white shadow-md transition-transform duration-200
                    ${showColorPicker ? 'scale-110 ring-2 ring-apple-blue' : 'hover:scale-110'}
                `}
                style={{ backgroundColor: settings.color }}
                title="Current Color"
            />
            
            {/* Quick Colors (Mini) */}
            <div className={`grid ${isVertical ? 'grid-cols-2' : 'grid-cols-5'} gap-1.5`}>
                {PRESET_COLORS.map(c => (
                    <button
                        key={c}
                        onClick={() => onUpdateSettings({ color: c, tool: settings.tool === ToolType.ERASER || settings.tool === ToolType.PICKER ? ToolType.PENCIL : settings.tool })}
                        className="w-4 h-4 rounded-full border border-black/10 hover:scale-125 transition-transform"
                        style={{ backgroundColor: c }}
                    />
                ))}
            </div>
        </div>

        {/* Separator */}
        <div className={`${isVertical ? 'w-full h-px' : 'w-px h-full'} bg-gray-200/50 my-1`} />

        {/* Brush Sizes */}
        <div className={`flex ${isVertical ? 'flex-col' : 'flex-row'} items-center gap-2 justify-center py-2`}>
            {SIZES.map((size) => (
            <button
                key={size}
                type="button"
                onClick={() => onUpdateSettings({ brushSize: size })}
                className="group relative w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors cursor-pointer"
                title={`Brush Size ${size}`}
            >
                <div 
                    className={`rounded-full bg-gray-800 transition-all duration-200 ${
                        settings.brushSize === size ? 'opacity-100 scale-110 bg-black shadow-sm' : 'opacity-30 group-hover:opacity-50'
                    }`}
                    style={{ width: Math.min(size/2 + 4, 24), height: Math.min(size/2 + 4, 24) }}
                />
            </button>
            ))}
        </div>

        {/* Separator */}
        <div className={`${isVertical ? 'w-full h-px' : 'w-px h-full'} bg-gray-200/50 my-1`} />

        {/* Actions */}
        <div className="pb-2">
            <button 
            type="button"
            onClick={onClear}
            className="p-4 text-red-500 rounded-full hover:bg-red-50 transition-colors flex items-center justify-center active:scale-95"
            title="Clear Frame"
            >
            <Trash2 size={24} />
            </button>
        </div>
        </div>

        {/* Floating Color Picker Popover */}
        {showColorPicker && (
            <div 
                ref={pickerRef}
                className="absolute left-full top-0 ml-4 z-50 md:left-full md:top-0 md:ml-4 bottom-auto"
                style={{
                    // Adjust for mobile view if needed
                    ...(isVertical ? {} : { left: '0', top: '100%', marginTop: '1rem', marginLeft: '0' })
                }}
            >
                <ColorPicker 
                    color={settings.color} 
                    onChange={(c) => onUpdateSettings({ color: c })}
                    onActivateEyedropper={() => {
                        onUpdateSettings({ tool: ToolType.PICKER });
                        setShowColorPicker(false);
                    }}
                    onClose={() => setShowColorPicker(false)}
                />
            </div>
        )}
    </div>
  );
};
