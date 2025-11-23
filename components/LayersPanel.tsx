
import React from 'react';
import { Layers, Lock, Eye, EyeOff, Unlock } from 'lucide-react';

interface LayersPanelProps {
  layers: string[];
  activeIndex: number;
  onSelectLayer: (index: number) => void;
  onToggleVisibility?: (index: number) => void; // Placeholder for future
  onToggleLock?: (index: number) => void;      // Placeholder for future
  onClose: () => void;
}

const LAYER_NAMES = ['Background', 'Middle', 'Foreground'];

export const LayersPanel: React.FC<LayersPanelProps> = ({ 
  activeIndex, 
  onSelectLayer, 
  onClose 
}) => {
  return (
    <div className="glass-panel rounded-2xl p-4 shadow-glass w-64 animate-in slide-in-from-right-10 duration-200">
      <div className="flex items-center justify-between mb-4 border-b border-gray-100 pb-2">
        <div className="flex items-center gap-2 text-gray-800 font-semibold">
          <Layers size={18} />
          <span>Layers</span>
        </div>
        <button onClick={onClose} className="text-xs text-apple-blue font-medium hover:underline">
          Done
        </button>
      </div>

      <div className="flex flex-col-reverse gap-2">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            onClick={() => onSelectLayer(index)}
            className={`
              relative flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all border-2
              ${activeIndex === index 
                ? 'bg-apple-blue/5 border-apple-blue shadow-sm' 
                : 'bg-white border-transparent hover:bg-gray-50'
              }
            `}
          >
            {/* Layer Preview Thumbnail (Placeholder) */}
            <div className={`w-10 h-8 rounded border ${activeIndex === index ? 'border-apple-blue/30' : 'border-gray-200'} bg-white flex items-center justify-center`}>
               <span className="text-[10px] text-gray-400 font-bold">{index + 1}</span>
            </div>

            <div className="flex-grow">
               <div className={`text-sm font-medium ${activeIndex === index ? 'text-apple-blue' : 'text-gray-700'}`}>
                 {LAYER_NAMES[index]}
               </div>
               <div className="text-[10px] text-gray-400">
                  {index === 0 ? 'Bottom' : index === 2 ? 'Top' : 'Normal'}
               </div>
            </div>

            {activeIndex === index && (
                <div className="w-2 h-2 rounded-full bg-apple-blue shadow-sm" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
