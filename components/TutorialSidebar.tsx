
import React, { useState } from 'react';
import { X, Play, ChevronRight, BookOpen, Trophy, ExternalLink } from 'lucide-react';
import { Tutorial } from '../types';

interface TutorialSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenFloatingVideo: (tutorial: Tutorial) => void;
}

const TUTORIALS: Tutorial[] = [
  {
    id: '1',
    title: 'Animation Basics - Getting Started',
    description: 'Learn the fundamentals of animation: timing, spacing, and basic principles.',
    videoUrl: 'https://www.youtube.com/embed/haa7n3UGyDc?rel=0',
    difficulty: 'Beginner',
    thumbnail: 'https://img.youtube.com/vi/haa7n3UGyDc/0.jpg'
  },
  {
    id: '2',
    title: 'Squash and Stretch Principle',
    description: 'Master the most important animation principle for bringing life to your characters.',
    videoUrl: 'https://www.youtube.com/embed/yskCJ7kpW3U?rel=0',
    difficulty: 'Beginner',
    thumbnail: 'https://img.youtube.com/vi/yskCJ7kpW3U/0.jpg'
  },
  {
    id: '3',
    title: 'Basic Drawing Techniques',
    description: 'Improve your drawing skills with essential techniques for animators.',
    videoUrl: 'https://www.youtube.com/embed/1Hb6eYpt7j4?rel=0',
    difficulty: 'Beginner',
    thumbnail: 'https://img.youtube.com/vi/1Hb6eYpt7j4/0.jpg'
  },
  {
    id: '4',
    title: 'Frame-by-Frame Animation Tips',
    description: 'Essential techniques for creating smooth frame-by-frame animations.',
    videoUrl: 'https://www.youtube.com/embed/pMC0Cx3Ukwk?rel=0',
    difficulty: 'Intermediate',
    thumbnail: 'https://img.youtube.com/vi/pMC0Cx3Ukwk/0.jpg'
  }
];

export const TutorialSidebar: React.FC<TutorialSidebarProps> = ({ isOpen, onClose, onOpenFloatingVideo }) => {
  const [activeTutorial, setActiveTutorial] = useState<Tutorial | null>(null);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 md:static md:inset-auto md:z-auto w-full md:w-96 h-full bg-white border-l border-gray-200 shadow-xl flex flex-col animate-in slide-in-from-right duration-300">

      {/* Header */}
      <div className="p-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
        <div className="flex items-center gap-2 font-bold text-gray-800">
          <BookOpen size={20} className="text-apple-blue" />
          <span>Learning Center</span>
        </div>
        <button onClick={onClose} className="p-2 -mr-2 text-gray-400 hover:text-gray-600 active:bg-gray-100 rounded-full">
          <X size={24} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto no-scrollbar relative">

        {activeTutorial ? (
          <div className="absolute inset-0 bg-white z-20 flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-300">
            {/* Floating Video Player Style */}
            <div className="p-4 bg-gray-900 text-white shadow-lg">
              <div className="flex items-center justify-between mb-3">
                <button
                  onClick={() => setActiveTutorial(null)}
                  className="text-xs font-semibold text-gray-300 hover:text-white flex items-center gap-1"
                >
                  ← Back
                </button>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => {
                      if (activeTutorial) {
                        onOpenFloatingVideo(activeTutorial);
                        setActiveTutorial(null);
                      }
                    }}
                    className="text-xs font-semibold text-gray-300 hover:text-white flex items-center gap-1.5 px-3 py-1.5 rounded-md hover:bg-white/10 transition-colors"
                    title="Pop out video"
                  >
                    <ExternalLink size={12} />
                    Pop Out
                  </button>
                  <span className="text-xs font-bold text-apple-yellow uppercase tracking-wider">Now Playing</span>
                </div>
              </div>

              <div className="aspect-video bg-black rounded-lg overflow-hidden shadow-2xl ring-1 ring-white/10">
                <iframe
                  width="100%"
                  height="100%"
                  src={activeTutorial.videoUrl}
                  title={activeTutorial.title}
                  frameBorder="0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                ></iframe>
              </div>

              <h3 className="text-lg font-bold mt-4 mb-1">{activeTutorial.title}</h3>
              <p className="text-gray-400 text-xs">{activeTutorial.description}</p>
            </div>

            <div className="p-5 flex-1 overflow-y-auto">
              <div className="p-4 bg-apple-yellow/10 rounded-xl border border-apple-yellow/20">
                <div className="flex items-center gap-2 text-apple-yellow font-bold text-sm mb-2">
                  <Trophy size={16} />
                  <span>Challenge</span>
                </div>
                <p className="text-sm text-gray-700 leading-relaxed">
                  Try to replicate the animation in the video on your canvas! Pause the video at keyframes and sketch what you see.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 flex flex-col gap-4">
            <div className="p-4 bg-gradient-to-br from-apple-blue to-apple-indigo rounded-2xl text-white shadow-md mb-2">
              <h3 className="font-bold text-lg mb-1">Master Animation</h3>
              <p className="text-xs opacity-90">Follow along with these guided lessons to improve your skills.</p>
            </div>

            {TUTORIALS.map(tutorial => (
              <div
                key={tutorial.id}
                className="group flex gap-3 p-3 rounded-xl hover:bg-gray-50 cursor-pointer transition-colors border border-transparent hover:border-gray-100 relative"
              >
                <div
                  onClick={() => setActiveTutorial(tutorial)}
                  className="flex gap-3 flex-1 min-w-0"
                >
                  <div className="relative w-24 h-16 rounded-lg overflow-hidden flex-shrink-0 bg-gray-200 shadow-sm">
                    <img src={tutorial.thumbnail} alt={tutorial.title} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/10 transition-colors">
                      <div className="w-6 h-6 rounded-full bg-white/90 flex items-center justify-center text-apple-blue shadow-sm scale-90 group-hover:scale-100 transition-transform">
                        <Play size={10} fill="currentColor" />
                      </div>
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="font-semibold text-sm text-gray-900 truncate group-hover:text-apple-blue transition-colors">{tutorial.title}</h4>
                    <p className="text-xs text-gray-500 line-clamp-2 mt-0.5">{tutorial.description}</p>
                    <span className={`
                              inline-block mt-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-sm
                              ${tutorial.difficulty === 'Beginner' ? 'bg-green-100 text-green-700' :
                        tutorial.difficulty === 'Intermediate' ? 'bg-yellow-100 text-yellow-700' :
                          'bg-red-100 text-red-700'}
                          `}>
                      {tutorial.difficulty}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-center justify-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenFloatingVideo(tutorial);
                    }}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-apple-blue hover:bg-apple-blue/10 transition-colors"
                    title="Pop out video"
                  >
                    <ExternalLink size={14} />
                  </button>
                  <ChevronRight size={14} className="text-gray-300 group-hover:text-apple-blue" />
                </div>
              </div>
            ))}
          </div>
        )
        }
      </div >
    </div >
  );
};
