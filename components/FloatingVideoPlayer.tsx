import React, { useState, useRef, useEffect } from 'react';
import { X, Minimize2, Maximize2, Move, Maximize } from 'lucide-react';
import { Tutorial } from '../types';

interface FloatingVideoPlayerProps {
  tutorial: Tutorial;
  onClose: () => void;
  onMinimize?: () => void;
}

export const FloatingVideoPlayer: React.FC<FloatingVideoPlayerProps> = ({
  tutorial,
  onClose,
  onMinimize
}) => {
  const [isMinimized, setIsMinimized] = useState(false);
  const [size, setSize] = useState<'small' | 'medium' | 'large'>('medium');
  const [position, setPosition] = useState({ x: window.innerWidth - 450, y: 100 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const playerRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);

  // Get dimensions based on size
  const getDimensions = () => {
    if (isMinimized) return { width: 320, height: 60 };
    switch(size) {
      case 'small': return { width: 320, height: 240 };
      case 'medium': return { width: 400, height: 300 };
      case 'large': return { width: 560, height: 420 };
    }
  };

  const { width, height } = getDimensions();

  const handlePointerDown = (e: React.PointerEvent) => {
    // Only allow dragging from the header bar
    const target = e.target as HTMLElement;
    if (dragHandleRef.current && dragHandleRef.current.contains(target)) {
      e.preventDefault();
      setIsDragging(true);
      setDragStart({
        x: e.clientX - position.x,
        y: e.clientY - position.y
      });
    }
  };

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      if (isDragging) {
        e.preventDefault();
        const newX = Math.max(0, Math.min(window.innerWidth - width, e.clientX - dragStart.x));
        const newY = Math.max(0, Math.min(window.innerHeight - height, e.clientY - dragStart.y));
        setPosition({ x: newX, y: newY });
      }
    };

    const handlePointerUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
    }

    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isDragging, dragStart, width, height]);

  const toggleMinimize = () => {
    setIsMinimized(!isMinimized);
  };

  const cycleSize = () => {
    setSize(prev => {
      if (prev === 'small') return 'medium';
      if (prev === 'medium') return 'large';
      return 'small';
    });
  };

  return (
    <div
      ref={playerRef}
      className={`fixed z-[60] bg-white rounded-xl shadow-2xl border-2 transition-all duration-200 ease-out select-none ${
        isDragging ? 'shadow-3xl border-apple-blue scale-[1.02]' : 'border-gray-200'
      }`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: `${width}px`,
        height: isMinimized ? '60px' : 'auto',
        touchAction: 'none'
      }}
      onPointerDown={handlePointerDown}
    >

      {/* Header Bar - Drag Handle */}
      <div
        ref={dragHandleRef}
        className={`flex items-center justify-between p-3 bg-gradient-to-r from-gray-50 to-gray-100 rounded-t-xl border-b border-gray-200 ${
          isDragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0 pointer-events-none">
          <Move size={14} className="text-gray-400 flex-shrink-0" />
          <span className="text-xs font-semibold text-gray-700 truncate">
            {tutorial.title}
          </span>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0 pointer-events-auto">
          {!isMinimized && (
            <button
              onClick={cycleSize}
              className="w-7 h-7 rounded-md hover:bg-white/80 flex items-center justify-center text-gray-500 hover:text-gray-700 transition-colors"
              title={`Resize (${size})`}
            >
              <Maximize size={13} />
            </button>
          )}
          <button
            onClick={toggleMinimize}
            className="w-7 h-7 rounded-md hover:bg-white/80 flex items-center justify-center text-gray-500 hover:text-gray-700 transition-colors"
            title={isMinimized ? 'Restore' : 'Minimize'}
          >
            {isMinimized ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
          </button>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md hover:bg-red-100 flex items-center justify-center text-gray-500 hover:text-red-600 transition-colors"
            title="Close"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Video Content */}
      {!isMinimized && (
        <>
          {/* Video Player */}
          <div className="aspect-video bg-black w-full">
            <iframe 
              width="100%" 
              height="100%" 
              src={tutorial.videoUrl} 
              title={tutorial.title}
              frameBorder="0" 
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" 
              allowFullScreen
              className="rounded-none"
            ></iframe>
          </div>
          
          {/* Video Info */}
          <div className="p-4 rounded-b-xl">
            <div className="flex items-center gap-2 mb-2">
              <span className={`
                inline-block text-[10px] font-bold px-2 py-1 rounded-sm
                ${tutorial.difficulty === 'Beginner' ? 'bg-green-100 text-green-700' : 
                  tutorial.difficulty === 'Intermediate' ? 'bg-yellow-100 text-yellow-700' : 
                  'bg-red-100 text-red-700'}
              `}>
                {tutorial.difficulty}
              </span>
            </div>
            <p className="text-xs text-gray-600 leading-relaxed">
              {tutorial.description}
            </p>
          </div>
        </>
      )}
      
      {/* Minimized Content */}
      {isMinimized && (
        <div className="px-3 py-2 flex items-center gap-3">
          <div className="w-10 h-10 bg-gray-200 rounded-md flex-shrink-0 overflow-hidden shadow-sm">
            <img src={tutorial.thumbnail} alt="" className="w-full h-full object-cover" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-gray-700 truncate">{tutorial.title}</p>
            <p className="text-[10px] text-gray-500">Tutorial playing...</p>
          </div>
        </div>
      )}
    </div>
  );
};