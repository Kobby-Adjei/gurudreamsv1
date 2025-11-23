
import React from 'react';
import { Plus, Clock, Trash2, Film, PlayCircle, MoreHorizontal } from 'lucide-react';
import { Project } from '../types';

interface HomeProps {
  projects: Project[];
  onCreateProject: () => void;
  onSelectProject: (project: Project) => void;
  onDeleteProject: (id: string) => void;
}

export const Home: React.FC<HomeProps> = ({ projects, onCreateProject, onSelectProject, onDeleteProject }) => {
  return (
    <div className="min-h-screen bg-paper-pattern p-6 md:p-12 overflow-y-auto">
      
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between mb-16 animate-enter">
          <div>
            <h1 className="text-4xl md:text-5xl font-bold text-[#1D1D1F] tracking-tight mb-3">Studio</h1>
            <p className="text-[#86868B] text-lg font-medium">Your sketchbook.</p>
          </div>
          <button 
            onClick={onCreateProject}
            className="mt-6 md:mt-0 bg-[#1D1D1F] hover:bg-black text-white px-6 py-3 rounded-full font-medium shadow-lg hover:shadow-xl transition-all hover:scale-105 active:scale-95 flex items-center gap-2"
          >
            <Plus size={20} />
            New Sketch
          </button>
        </div>

        {/* Projects Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8 md:gap-10">
          
          {/* New Project Card (Minimalist) */}
          <button 
            onClick={onCreateProject}
            className="group relative aspect-[4/3] bg-white rounded-2xl shadow-paper hover:shadow-paper-hover transition-all duration-300 flex flex-col items-center justify-center gap-4 border border-gray-100 hover:border-gray-200"
          >
             <div className="w-16 h-16 rounded-full bg-[#F5F5F7] group-hover:bg-blue-50 text-gray-400 group-hover:text-apple-blue flex items-center justify-center transition-colors duration-300">
                <Plus size={32} strokeWidth={1.5} />
             </div>
             <span className="font-medium text-gray-500 group-hover:text-apple-blue transition-colors">Create New</span>
          </button>

          {/* Existing Projects */}
          {projects.map((project, index) => (
            <div 
              key={project.id}
              className="group relative flex flex-col animate-enter"
              style={{ animationDelay: `${index * 50}ms` }}
            >
              {/* Card Container mimicking a sheet of paper */}
              <div 
                onClick={() => onSelectProject(project)}
                className="relative aspect-[4/3] bg-white rounded-2xl shadow-paper group-hover:shadow-paper-hover transition-all duration-300 cursor-pointer overflow-hidden border border-gray-100/50"
              >
                {project.frames.length > 0 ? (
                  <div className="w-full h-full p-4">
                      {/* Inner Paper Texture & Drawing */}
                      <div className="w-full h-full bg-[#FAFAF8] rounded-lg overflow-hidden relative">
                         <div className="absolute inset-0 opacity-[0.03] bg-[url('https://www.transparenttextures.com/patterns/cream-paper.png')] mix-blend-multiply pointer-events-none" />
                         <img 
                            src={project.previewImage || project.frames[0].dataUrl} 
                            alt={project.name} 
                            className="w-full h-full object-contain mix-blend-multiply opacity-90 transition-transform duration-700 group-hover:scale-105"
                          />
                      </div>
                  </div>
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-200">
                    <Film size={48} strokeWidth={1} />
                  </div>
                )}
                
                {/* Minimalist Play Overlay */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-black/5 backdrop-blur-[1px]">
                     <div className="w-12 h-12 rounded-full bg-white shadow-lg flex items-center justify-center text-[#1D1D1F] transform scale-90 group-hover:scale-100 transition-transform">
                        <PlayCircle size={24} strokeWidth={1.5} fill="rgba(0,0,0,0.05)" />
                     </div>
                </div>
              </div>

              {/* Info Section */}
              <div className="mt-4 flex items-start justify-between px-1">
                <div onClick={() => onSelectProject(project)} className="cursor-pointer">
                  <h3 className="font-semibold text-[#1D1D1F] text-base mb-0.5 truncate max-w-[180px]">
                    {project.name}
                  </h3>
                  <div className="flex items-center gap-2 text-xs text-[#86868B]">
                    <span>{new Date(project.lastModified).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                    <span>•</span>
                    <span>{project.frames.length} frames</span>
                  </div>
                </div>

                <div className="relative group/menu">
                    <button 
                      className="text-gray-300 hover:text-[#1D1D1F] p-1.5 rounded-full hover:bg-gray-100 transition-colors"
                    >
                      <MoreHorizontal size={18} />
                    </button>
                    {/* Minimal Popover Menu */}
                    <div className="absolute right-0 top-full mt-1 w-32 bg-white rounded-xl shadow-lg border border-gray-100 py-1 opacity-0 invisible group-hover/menu:opacity-100 group-hover/menu:visible transition-all z-10 transform origin-top-right scale-95 group-hover/menu:scale-100">
                        <button 
                            onClick={(e) => { e.stopPropagation(); onDeleteProject(project.id); }}
                            className="w-full text-left px-3 py-2 text-xs font-medium text-red-500 hover:bg-red-50 flex items-center gap-2"
                        >
                            <Trash2 size={12} /> Delete
                        </button>
                    </div>
                </div>
              </div>
            </div>
          ))}

          {projects.length === 0 && (
            <div className="col-span-full py-20 text-center">
                <p className="text-[#86868B] text-lg font-light">Your sketchbook is empty.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
