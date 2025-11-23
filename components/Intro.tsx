
import React, { useRef, useState } from 'react';
import { Play, SkipForward, AlertCircle, Upload } from 'lucide-react';

interface IntroProps {
  onComplete: () => void;
}

export const Intro: React.FC<IntroProps> = ({ onComplete }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasStarted, setHasStarted] = useState(false);
  const [hasError, setHasError] = useState(false);
  
  // Try to load from the public folder (served as static asset by Vite)
  // If this 404s, the onError handler will show the upload button.
  const [videoSrc, setVideoSrc] = useState<string>('/animation_intro.mp4');

  const handleStart = () => {
    if (videoRef.current) {
      videoRef.current.play().then(() => {
        setHasStarted(true);
        setHasError(false);
      }).catch(e => {
        console.warn("Auto-play failed or source invalid:", e);
        setHasError(true);
      });
    }
  };

  const handleError = () => {
    // When the browser fails to find the file at the path, show the manual upload UI
    console.warn("Video file could not be loaded from path:", videoSrc);
    setHasError(true);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
        const url = URL.createObjectURL(file);
        setVideoSrc(url);
        setHasError(false);
        // Give the video element a moment to update its source
        setTimeout(() => {
            if (videoRef.current) {
                videoRef.current.load();
                videoRef.current.play().then(() => setHasStarted(true)).catch(() => {}); 
            }
        }, 100);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-[#050505] flex items-center justify-center font-sans">
      
      {/* Intro Overlay (Visible before video starts) */}
      {!hasStarted && !hasError && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/60 backdrop-blur-md animate-in fade-in duration-700">
           {/* Guru Dreams Branding */}
           <div className="text-center mb-12 transform hover:scale-105 transition-transform duration-700">
             <div className="w-24 h-24 rounded-full bg-gradient-to-tr from-amber-300 to-orange-500 mx-auto mb-6 shadow-[0_0_60px_rgba(255,160,0,0.4)] animate-pulse" />
             <h1 className="text-5xl md:text-7xl font-black text-white tracking-tight drop-shadow-2xl mb-2">
               GURU DREAMS
             </h1>
             <p className="text-white/60 text-lg font-light tracking-widest uppercase">Animation Studio</p>
           </div>

           <button 
             onClick={handleStart}
             className="group flex items-center gap-3 px-10 py-5 bg-white text-black rounded-full font-bold text-xl hover:scale-105 transition-all duration-300 shadow-[0_0_40px_rgba(255,255,255,0.15)] hover:shadow-[0_0_60px_rgba(255,255,255,0.3)] hover:bg-gray-100"
           >
             <Play fill="black" size={24} className="group-hover:translate-x-0.5 transition-transform" />
             Enter Studio
           </button>
        </div>
      )}

      {/* Error / Manual Upload State */}
      {hasError && (
         <div className="absolute z-30 flex flex-col items-center text-white p-8 text-center bg-black/80 rounded-2xl backdrop-blur-xl border border-white/10 max-w-md mx-4 animate-in zoom-in-95 duration-300">
            <AlertCircle size={48} className="text-red-500 mb-4" />
            <p className="text-lg font-medium mb-2">Video Not Found</p>
            <p className="text-sm text-gray-400 mb-6">
              We couldn't auto-load <code>animation_intro.mp4</code>.<br/>
              Please select the file manually to continue.
            </p>
            
            <div className="flex flex-col gap-3 w-full">
                <label className="flex items-center justify-center gap-2 px-6 py-3 bg-white text-black rounded-full font-bold cursor-pointer hover:bg-gray-200 transition-colors shadow-lg hover:shadow-xl">
                    <Upload size={18} />
                    Select Video File
                    <input type="file" accept="video/*" className="hidden" onChange={handleFileUpload} />
                </label>
                
                <button onClick={onComplete} className="px-6 py-3 bg-white/10 rounded-full hover:bg-white/20 transition-colors text-sm font-medium">
                    Skip Intro
                </button>
            </div>
         </div>
      )}

      {/* Video Player */}
      <video 
        ref={videoRef}
        src={videoSrc}
        className={`w-full h-full object-cover transition-opacity duration-1000 ${hasStarted ? 'opacity-100' : 'opacity-40'}`}
        playsInline
        onEnded={onComplete}
        onError={handleError}
      />
      
      {/* Skip Button (Visible when playing) */}
      {hasStarted && (
        <button 
          onClick={onComplete}
          className="absolute bottom-10 right-10 text-white/50 hover:text-white flex items-center gap-2 text-sm font-medium transition-colors z-20 bg-black/40 px-5 py-2.5 rounded-full backdrop-blur-xl border border-white/10 hover:bg-black/60 hover:border-white/30 group"
        >
          Skip Intro <SkipForward size={14} className="group-hover:translate-x-0.5 transition-transform" />
        </button>
      )}
    </div>
  );
};
