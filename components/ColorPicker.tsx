
import React, { useState, useEffect, useRef } from 'react';
import { Pipette, Plus, Check, X, Copy } from 'lucide-react';

interface ColorPickerProps {
  color: string;
  onChange: (color: string) => void;
  onActivateEyedropper: () => void;
  onClose: () => void;
}

// Utility functions for color conversion
const hexToRgb = (hex: string) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
};

const rgbToHex = (r: number, g: number, b: number) => {
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
};

const rgbToHsl = (r: number, g: number, b: number) => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s, l = (max + min) / 2;

  if (max === min) {
    h = s = 0; // achromatic
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
};

const hslToRgb = (h: number, s: number, l: number) => {
  let r, g, b;
  h /= 360; s /= 100; l /= 100;

  if (s === 0) {
    r = g = b = l; // achromatic
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
};

export const ColorPicker: React.FC<ColorPickerProps> = ({ color, onChange, onActivateEyedropper, onClose }) => {
  const [mode, setMode] = useState<'solid' | 'sliders'>('solid');
  const [customPalette, setCustomPalette] = useState<string[]>(() => {
    const saved = localStorage.getItem('animate_custom_palette');
    return saved ? JSON.parse(saved) : ['#FFFFFF', '#000000'];
  });

  const rgb = hexToRgb(color);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

  // Saturation/Brightness Interaction
  const sbRef = useRef<HTMLDivElement>(null);
  const isDraggingSB = useRef(false);

  // Hue Slider Interaction
  const hueRef = useRef<HTMLDivElement>(null);
  const isDraggingHue = useRef(false);

  useEffect(() => {
    localStorage.setItem('animate_custom_palette', JSON.stringify(customPalette));
  }, [customPalette]);

  const handleSbChange = (e: React.MouseEvent | React.TouchEvent | MouseEvent | TouchEvent) => {
    if (!sbRef.current) return;
    const rect = sbRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
    
    let x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    let y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    
    // x is Saturation, y is (1 - Value/Brightness)
    // Convert HSV to HSL for display
    // Current H is kept
    const s = x * 100;
    const v = (1 - y) * 100;
    
    // HSV to HSL
    let l = (2 - s / 100) * v / 2;
    let sl = s * v / (l < 50 ? l * 2 : 200 - l * 2);
    if (isNaN(sl)) sl = 0;
    
    const newRgb = hslToRgb(hsl.h, sl, l);
    onChange(rgbToHex(newRgb.r, newRgb.g, newRgb.b));
  };

  const handleHueChange = (e: React.MouseEvent | React.TouchEvent | MouseEvent | TouchEvent) => {
    if (!hueRef.current) return;
    const rect = hueRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
    let x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    
    const newH = x * 360;
    const newRgb = hslToRgb(newH, hsl.s, hsl.l);
    onChange(rgbToHex(newRgb.r, newRgb.g, newRgb.b));
  };

  // Global mouse up for dragging
  useEffect(() => {
    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (isDraggingSB.current) handleSbChange(e);
      if (isDraggingHue.current) handleHueChange(e);
    };
    const handleUp = () => {
      isDraggingSB.current = false;
      isDraggingHue.current = false;
    };
    
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('touchmove', handleMove);
    window.addEventListener('mouseup', handleUp);
    window.addEventListener('touchend', handleUp);
    
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('touchend', handleUp);
    };
  });

  const saveColor = () => {
    if (!customPalette.includes(color)) {
      setCustomPalette([...customPalette, color]);
    }
  };

  const removeColor = (colorToRemove: string) => {
      setCustomPalette(customPalette.filter(c => c !== colorToRemove));
  };

  const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      if (/^#[0-9A-F]{6}$/i.test(val)) {
          onChange(val);
      }
  };

  return (
    <div className="w-72 glass-panel-dark rounded-2xl p-4 shadow-2xl animate-in zoom-in-95 duration-200">
      
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-white font-semibold text-sm">Colors</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white">
          <X size={16} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/10 p-1 rounded-lg mb-4">
        <button 
          onClick={() => setMode('solid')}
          className={`flex-1 py-1 text-xs font-medium rounded-md transition-colors ${mode === 'solid' ? 'bg-white/20 text-white' : 'text-gray-400 hover:text-white'}`}
        >
          Spectrum
        </button>
        <button 
          onClick={() => setMode('sliders')}
          className={`flex-1 py-1 text-xs font-medium rounded-md transition-colors ${mode === 'sliders' ? 'bg-white/20 text-white' : 'text-gray-400 hover:text-white'}`}
        >
          Sliders
        </button>
      </div>

      {mode === 'solid' ? (
        <div className="space-y-4">
          {/* Saturation/Brightness Box */}
          <div 
            ref={sbRef}
            className="w-full h-40 rounded-lg relative cursor-crosshair shadow-inner"
            style={{
              backgroundColor: `hsl(${hsl.h}, 100%, 50%)`,
              backgroundImage: 'linear-gradient(to right, #fff, transparent), linear-gradient(to top, #000, transparent)'
            }}
            onMouseDown={(e) => { isDraggingSB.current = true; handleSbChange(e); }}
            onTouchStart={(e) => { isDraggingSB.current = true; handleSbChange(e); }}
          >
             {/* Cursor indicator would ideally be calculated from S/L to X/Y. Simplified for centeredness. */}
             <div className="absolute w-4 h-4 rounded-full border-2 border-white shadow-sm -translate-x-1/2 -translate-y-1/2 pointer-events-none" 
                  style={{ 
                      // Rough approximation for UI feedback
                      // In a real app we'd need precise HSV back-calculation
                      left: `${hsl.s}%`, 
                      top: `${100 - (hsl.l < 50 ? hsl.l * 2 : 200 - hsl.l * 2) / 2}%` // Very rough visual approx
                  }} 
             />
          </div>

          {/* Hue Slider */}
          <div 
            ref={hueRef}
            className="w-full h-4 rounded-full relative cursor-pointer"
            style={{
              background: 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)'
            }}
            onMouseDown={(e) => { isDraggingHue.current = true; handleHueChange(e); }}
            onTouchStart={(e) => { isDraggingHue.current = true; handleHueChange(e); }}
          >
            <div 
                className="absolute top-0 bottom-0 w-4 h-4 bg-white rounded-full shadow-md border border-gray-200 -translate-x-1/2 pointer-events-none"
                style={{ left: `${hsl.h / 3.6}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="space-y-4 py-2">
            {/* RGB Sliders */}
            {['r', 'g', 'b'].map((channel) => (
                <div key={channel} className="flex items-center gap-2 text-xs text-gray-300 uppercase">
                    <span className="w-3">{channel}</span>
                    <input 
                        type="range" 
                        min="0" 
                        max="255" 
                        value={rgb[channel as keyof typeof rgb]} 
                        onChange={(e) => {
                            const newRgb = { ...rgb, [channel]: parseInt(e.target.value) };
                            onChange(rgbToHex(newRgb.r, newRgb.g, newRgb.b));
                        }}
                        className="flex-1 accent-white h-1 bg-white/20 rounded-lg appearance-none cursor-pointer"
                    />
                    <span className="w-6 text-right">{rgb[channel as keyof typeof rgb]}</span>
                </div>
            ))}
        </div>
      )}

      {/* Hex & Eyedropper */}
      <div className="flex items-center gap-2 mt-4">
        <div className="flex-1 h-9 bg-white/10 rounded-lg flex items-center px-2 border border-white/10 focus-within:border-white/40 transition-colors">
            <span className="text-gray-400 text-xs mr-2">#</span>
            <input 
                type="text" 
                defaultValue={color}
                onBlur={handleHexChange}
                className="bg-transparent text-white text-xs font-mono w-full outline-none uppercase"
            />
        </div>
        <button 
            onClick={onActivateEyedropper}
            className="w-9 h-9 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
            title="Eyedropper"
        >
            <Pipette size={16} />
        </button>
      </div>

      <div className="w-full h-px bg-white/10 my-4" />

      {/* Saved Palette */}
      <div>
        <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-400 font-medium">Saved Colors</span>
            <button onClick={saveColor} className="text-xs flex items-center gap-1 text-apple-blue hover:text-apple-blue/80">
                <Plus size={12} /> Add
            </button>
        </div>
        <div className="grid grid-cols-6 gap-2">
            {customPalette.map((c, i) => (
                <div 
                    key={i} 
                    className="group relative w-8 h-8 rounded-full cursor-pointer shadow-sm border border-white/10 hover:scale-110 transition-transform"
                    style={{ backgroundColor: c }}
                    onClick={() => onChange(c)}
                >
                    {c === color && (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <div className="w-2 h-2 bg-white rounded-full shadow-sm" />
                        </div>
                    )}
                    <button 
                        onClick={(e) => { e.stopPropagation(); removeColor(c); }}
                        className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                        <X size={8} />
                    </button>
                </div>
            ))}
        </div>
      </div>

    </div>
  );
};
