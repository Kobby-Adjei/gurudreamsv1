
import React, { useEffect } from 'react';
import { X, Pause, Play, Maximize2 } from 'lucide-react';

interface CinemaViewProps {
  frameData: string;
  onClose: () => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
}

export const CinemaView: React.FC<CinemaViewProps> = ({ frameData, onClose, isPlaying, onTogglePlay }) => {
  
  // Auto-play when entering cinema mode if not already playing
  useEffect(() => {
    if (!isPlaying) {
      onTogglePlay();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-[#050505] flex flex-col items-center justify-center animate-in fade-in duration-700">
      
      {/* Ambient Glow Background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
         <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[120vw] h-[120vh] bg-apple-blue/10 blur-[150px] rounded-full opacity-20" />
      </div>

      {/* Screen Container */}
      <div className="relative z-10 w-full max-w-5xl aspect-[4/3] max-h-[75vh] mx-4 animate-in zoom-in-95 duration-700 ease-out fill-mode-forwards">
        
        {/* The Screen Itself */}
        <div className="relative w-full h-full bg-black rounded-lg overflow-hidden shadow-[0_0_50px_rgba(255,255,255,0.05)] border border-gray-800/50 ring-1 ring-white/10">
            <img 
                src={frameData} 
                className="w-full h-full object-contain" 
                alt="Cinema Screen"
            />
            
            {/* Screen Gloss/Reflection overlay */}
            <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/5 to-transparent pointer-events-none" />
        </div>

        {/* Backlight/Projector Glow behind screen */}
        <div className="absolute -inset-10 bg-white/5 blur-3xl -z-10 rounded-[40%]" />
      </div>
      
      {/* Floor Reflection */}
      <div className="relative z-0 w-full max-w-5xl mx-4 h-40 -mt-2 opacity-30 pointer-events-none perspective-1000">
          <div className="w-full h-full transform scale-y-[-1] origin-top blur-lg opacity-50">
             <img src={frameData} className="w-full h-full object-contain opacity-50 mask-linear-fade" />
          </div>
          {/* Mask for fade out */}
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[#050505]" />
      </div>

      {/* Floating Controls */}
      <div className="absolute bottom-12 flex items-center gap-8 z-20 animate-in slide-in-from-bottom-10 duration-700 delay-300">
        
        <button 
            onClick={(e) => { e.stopPropagation(); onTogglePlay(); }}
            className="group p-5 rounded-full bg-white/10 hover:bg-white/20 hover:scale-105 transition-all backdrop-blur-xl border border-white/5 shadow-2xl"
        >
            {isPlaying ? (
                <Pause fill="currentColor" className="text-white opacity-80 group-hover:opacity-100" size={32} />
            ) : (
                <Play fill="currentColor" className="text-white opacity-80 group-hover:opacity-100 ml-1" size={32} />
            )}
        </button>

        <button 
            onClick={onClose} 
            className="group p-5 rounded-full bg-white/5 hover:bg-red-500/20 hover:scale-105 transition-all backdrop-blur-xl border border-white/5 shadow-xl"
        >
            <X className="text-white opacity-60 group-hover:text-red-400 group-hover:opacity-100" size={32} />
        </button>
      </div>

      {/* Title/Status */}
      <div className="absolute top-8 text-white/20 font-medium tracking-[0.2em] text-xs uppercase animate-in fade-in slide-in-from-top-4 duration-1000">
         Cinema Mode
      </div>

    </div>
  );
};
