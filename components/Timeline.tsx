
import React, { useRef } from 'react';
import { Play, Pause, Plus, Copy, Trash2, Layers, Settings2, Music, X, Projector } from 'lucide-react';
import { Frame } from '../types';

interface TimelineProps {
  frames: Frame[];
  currentFrameIndex: number;
  isPlaying: boolean;
  fps: number;
  onionSkin: boolean;
  onSelectFrame: (index: number) => void;
  onAddFrame: () => void;
  onDuplicateFrame: () => void;
  onDeleteFrame: (index: number) => void;
  onTogglePlay: () => void;
  onChangeFps: (fps: number) => void;
  onToggleOnionSkin: () => void;
  audioUrl: string | null;
  onUploadAudio: (file: File) => void;
  onRemoveAudio: () => void;
  onEnterCinema: () => void;
}

export const Timeline: React.FC<TimelineProps> = ({
  frames,
  currentFrameIndex,
  isPlaying,
  fps,
  onionSkin,
  onSelectFrame,
  onAddFrame,
  onDuplicateFrame,
  onDeleteFrame,
  onTogglePlay,
  onChangeFps,
  onToggleOnionSkin,
  audioUrl,
  onUploadAudio,
  onRemoveAudio,
  onEnterCinema
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
        onUploadAudio(file);
    }
    // Reset value so same file can be selected again if needed
    if (e.target) e.target.value = '';
  };

  return (
    <div className="glass-panel rounded-[24px] p-2 shadow-glass w-full flex flex-col gap-2 backdrop-blur-xl bg-white/80">
      
      <div className="flex items-center gap-4 px-2">
        {/* Playback Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={onTogglePlay}
            className={`
                w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200
                ${isPlaying ? 'bg-apple-red text-white' : 'bg-black text-white hover:scale-105'}
            `}
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="ml-0.5" />}
          </button>
          
          <button
            onClick={onEnterCinema}
            className="w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 bg-gray-100 text-gray-600 hover:bg-apple-indigo hover:text-white hover:scale-105"
            title="Cinema Mode"
          >
            <Projector size={18} />
          </button>
        </div>

        {/* FPS Slider */}
        <div className="hidden sm:flex items-center gap-2 bg-gray-100/50 rounded-full px-3 py-1.5">
            <Settings2 size={14} className="text-gray-400" />
            <input
              type="range"
              min="1"
              max="24"
              value={fps}
              onChange={(e) => onChangeFps(parseInt(e.target.value))}
              className="w-20 h-1 bg-gray-300 rounded-lg appearance-none cursor-pointer accent-apple-blue"
            />
            <span className="text-[10px] font-semibold text-gray-500 w-8">{fps} FPS</span>
        </div>

        {/* Onion Skin */}
        <button
            onClick={onToggleOnionSkin}
            className={`p-2 rounded-full transition-all duration-200 ${
                onionSkin ? 'bg-apple-blue/10 text-apple-blue' : 'text-gray-400 hover:text-gray-600'
            }`}
            title="Onion Skin"
        >
            <Layers size={18} />
        </button>

        <div className="flex-grow" />

        {/* Add / Duplicate */}
        <div className="flex items-center gap-1">
           <button
            onClick={onDuplicateFrame}
            className="p-2 text-gray-500 hover:bg-gray-100 rounded-full transition-colors"
            title="Duplicate Frame"
          >
            <Copy size={18} />
          </button>
           <button
            onClick={onAddFrame}
            className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-1.5 rounded-full text-sm font-medium transition-colors flex items-center gap-1"
          >
            <Plus size={16} /> New
          </button>
        </div>
      </div>

      {/* Frames Strip */}
      <div className="flex gap-2 overflow-x-auto px-2 pb-1 no-scrollbar h-20 items-center">
        {frames.map((frame, index) => (
          <div
            key={frame.id}
            className={`
                relative flex-shrink-0 cursor-pointer group transition-all duration-300 ease-out
                ${index === currentFrameIndex ? 'scale-100' : 'scale-95 opacity-60 hover:opacity-100'}
            `}
            onClick={() => onSelectFrame(index)}
          >
            <div className={`
                w-24 h-16 bg-white rounded-lg overflow-hidden shadow-sm border-2 transition-colors
                ${index === currentFrameIndex ? 'border-apple-blue ring-2 ring-apple-blue/20' : 'border-transparent'}
            `}>
                <img src={frame.dataUrl} alt={`Frame ${index + 1}`} className="w-full h-full object-contain" />
            </div>
            
            {/* Hover Actions */}
            <div className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                <button 
                    onClick={(e) => { e.stopPropagation(); onDeleteFrame(index); }}
                    className="bg-white text-red-500 border border-gray-200 rounded-full p-1 shadow-sm hover:scale-110"
                    disabled={frames.length <= 1}
                >
                    <Trash2 size={10} />
                </button>
            </div>
            
            <span className={`
                absolute bottom-1 left-1 text-[9px] font-bold px-1.5 rounded-full
                ${index === currentFrameIndex ? 'bg-apple-blue text-white' : 'bg-gray-200 text-gray-500'}
            `}>
                {index + 1}
            </span>
          </div>
        ))}
        
        {/* Quick Add Placeholder */}
        <div 
            onClick={onAddFrame}
            className="flex-shrink-0 w-24 h-16 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-300 hover:border-apple-blue hover:text-apple-blue cursor-pointer transition-colors"
        >
            <Plus size={24} />
        </div>
      </div>

      {/* Music Track */}
      <div className="px-2 border-t border-gray-100 pt-2">
         <input 
            type="file" 
            ref={fileInputRef} 
            className="hidden" 
            accept="audio/*" 
            onChange={handleFileChange}
         />
         
         {audioUrl ? (
            <div className="relative w-full h-8 bg-gradient-to-r from-apple-indigo/10 to-apple-purple/10 rounded-md flex items-center px-3 gap-2 group overflow-hidden border border-apple-indigo/10">
                {/* Fake Waveform Background */}
                <div className="absolute inset-0 flex items-end justify-around opacity-20 px-1 pointer-events-none">
                    {[...Array(40)].map((_, i) => (
                        <div 
                            key={i} 
                            className="w-1 bg-apple-indigo rounded-t-full transition-all duration-500"
                            style={{ height: `${20 + Math.random() * 60}%` }} 
                        />
                    ))}
                </div>

                <Music size={14} className="text-apple-indigo relative z-10" />
                <span className="text-[10px] font-semibold text-apple-indigo uppercase tracking-wider relative z-10">Music Track</span>
                
                <div className="flex-grow" />
                
                <button 
                    onClick={onRemoveAudio}
                    className="text-apple-indigo hover:bg-apple-indigo/20 p-1 rounded-full relative z-10 transition-colors"
                >
                    <X size={12} />
                </button>
            </div>
         ) : (
             <button 
                onClick={() => fileInputRef.current?.click()}
                className="w-full h-8 border border-dashed border-gray-300 rounded-md flex items-center justify-center gap-2 text-gray-400 hover:text-apple-blue hover:border-apple-blue hover:bg-apple-blue/5 transition-all text-xs font-medium"
             >
                <Music size={14} /> Add Background Music
             </button>
         )}
      </div>

    </div>
  );
};
