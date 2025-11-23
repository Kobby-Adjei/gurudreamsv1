import React, { useState, useRef, useEffect } from 'react';
import { X, Minimize2, Maximize2, Move } from 'lucide-react';
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
  const [position, setPosition] = useState({ x: 50, y: 50 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const playerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.target === playerRef.current || (e.target as HTMLElement).classList.contains('drag-handle')) {
      setIsDragging(true);
      setDragStart({
        x: e.clientX - position.x,
        y: e.clientY - position.y
      });
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        const newX = Math.max(0, Math.min(window.innerWidth - 400, e.clientX - dragStart.x));
        const newY = Math.max(0, Math.min(window.innerHeight - (isMinimized ? 60 : 300), e.clientY - dragStart.y));
        setPosition({ x: newX, y: newY });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragStart, isMinimized]);

  const toggleMinimize = () => {
    setIsMinimized(!isMinimized);
  };

  return (
    <div
      ref={playerRef}
      className={`fixed z-[60] bg-white rounded-xl shadow-2xl border border-gray-200 transition-all duration-300 ease-out ${
        isDragging ? 'cursor-grabbing' : 'cursor-grab'
      } ${isMinimized ? 'w-80 h-16' : 'w-96 h-auto'}`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
      }}
      onMouseDown={handleMouseDown}
    >
      
      {/* Header Bar */}
      <div className="drag-handle flex items-center justify-between p-3 bg-gray-50/80 rounded-t-xl border-b border-gray-100">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Move size={14} className="text-gray-400 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-700 truncate">
            {tutorial.title}
          </span>
        </div>
        
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={toggleMinimize}
            className="w-6 h-6 rounded-md hover:bg-gray-200 flex items-center justify-center text-gray-500 hover:text-gray-700 transition-colors"
            title={isMinimized ? 'Maximize' : 'Minimize'}
          >
            {isMinimized ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
          </button>
          <button
            onClick={onClose}
            className="w-6 h-6 rounded-md hover:bg-red-100 flex items-center justify-center text-gray-500 hover:text-red-600 transition-colors"
            title="Close"
          >
            <X size={12} />
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
        <div className="px-4 py-1 flex items-center gap-3">
          <div className="w-8 h-8 bg-gray-200 rounded-md flex-shrink-0 overflow-hidden">
            <img src={tutorial.thumbnail} alt="" className="w-full h-full object-cover" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-600 truncate">Video playing...</p>
          </div>
        </div>
      )}
    </div>
  );
};