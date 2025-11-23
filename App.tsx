
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Mic, ArrowLeft, GraduationCap } from 'lucide-react';
import { Frame, AnimationState, DrawingSettings, ToolType, Project } from './types';
import { Canvas, CanvasHandle } from './components/Canvas';
import { Toolbar } from './components/Toolbar';
import { Timeline } from './components/Timeline';
import { MagicAssist } from './components/MagicAssist';
import { LayersPanel } from './components/LayersPanel';
import { CinemaView } from './components/CinemaView';
import { LiveVoice } from './components/LiveVoice';
import { Home } from './components/Home';
import { TutorialSidebar } from './components/TutorialSidebar';
import { Intro } from './components/Intro';
import { generateMeltAnimation } from './services/meltEffect';
import { editFrameWithAI } from './services/geminiService';

// Helper to create a transparent blank layer
const createBlankLayer = (width: number, height: number): string => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.toDataURL(); // Transparent by default
};

// Helper to create a composite white frame
const createWhiteComposite = (width: number, height: number): string => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
  }
  return canvas.toDataURL();
};

const createLayeredFrame = (width: number, height: number): Frame => {
  const transparent = createBlankLayer(width, height);
  return {
    id: uuidv4(),
    dataUrl: createWhiteComposite(width, height),
    layers: [transparent, transparent, transparent] // Back, Mid, Fore
  };
};

function App() {
  // --- Intro State ---
  const [showIntro, setShowIntro] = useState(true);

  // --- Navigation State ---
  const [currentView, setCurrentView] = useState<'home' | 'editor'>('home');
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>(() => {
    const saved = localStorage.getItem('animate_projects');
    return saved ? JSON.parse(saved) : [];
  });
  const [showTutorials, setShowTutorials] = useState(false);

  // --- Editor State ---
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const containerRef = useRef<HTMLDivElement>(null);

  const [frames, setFrames] = useState<Frame[]>([]);
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);
  const [activeLayerIndex, setActiveLayerIndex] = useState(1); // Default to Middle layer
  const [isPlaying, setIsPlaying] = useState(false);
  const [fps, setFps] = useState(8);
  const [onionSkin, setOnionSkin] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [showGrid, setShowGrid] = useState(false);
  const [showLayers, setShowLayers] = useState(false);
  const [cinemaMode, setCinemaMode] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);

  // History State managed by Canvas component
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const canvasRef = useRef<CanvasHandle>(null);

  const [drawingSettings, setDrawingSettings] = useState<DrawingSettings>({
    color: '#000000',
    brushSize: 5,
    tool: ToolType.PENCIL,
  });

  const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // --- Resize Observer ---
  useEffect(() => {
    if (currentView !== 'editor' || !containerRef.current) return;

    const updateSize = () => {
      if (containerRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        // Only update if dimensions actually changed to avoid loops
        setCanvasSize(prev => {
          if (prev.width === clientWidth && prev.height === clientHeight) return prev;
          return { width: clientWidth, height: clientHeight };
        });
      }
    };

    // Initial size
    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(containerRef.current);

    return () => observer.disconnect();
  }, [currentView, showTutorials]); // Re-run when layout might change significantly

  // --- Project Management ---

  useEffect(() => {
    localStorage.setItem('animate_projects', JSON.stringify(projects));
  }, [projects]);

  // Auto-save current project state when frames change
  useEffect(() => {
    if (currentProject && currentView === 'editor' && frames.length > 0) {
      setProjects(prev => prev.map(p =>
        p.id === currentProject.id
          ? {
            ...p,
            frames: frames,
            previewImage: frames[0].dataUrl,
            lastModified: Date.now(),
            fps: fps
          }
          : p
      ));
    }
  }, [frames, fps, currentProject, currentView]);

  const handleCreateProject = () => {
    // Default size for new projects, will be updated by resize observer when editor loads
    const width = 800;
    const height = 600;
    const newProject: Project = {
      id: uuidv4(),
      name: `Sketch ${projects.length + 1}`,
      lastModified: Date.now(),
      previewImage: '',
      frames: [createLayeredFrame(width, height)],
      fps: 8
    };
    setProjects(prev => [newProject, ...prev]);
    handleSelectProject(newProject);
  };

  const handleSelectProject = (project: Project) => {
    setCurrentProject(project);
    // If project has frames, use them. If not, create one with default size (will be resized)
    setFrames(project.frames.length > 0 ? project.frames : [createLayeredFrame(800, 600)]);
    setFps(project.fps);
    setCurrentFrameIndex(0);
    setHistoryState({ canUndo: false, canRedo: false });
    setCurrentView('editor');
    setShowTutorials(false);
  };

  const handleDeleteProject = (id: string) => {
    setProjects(prev => prev.filter(p => p.id !== id));
    if (currentProject?.id === id) {
      setCurrentView('home');
      setCurrentProject(null);
    }
  };

  const handleGoHome = () => {
    setIsPlaying(false);
    setCurrentView('home');
  };

  // --- Editor Logic ---

  useEffect(() => {
    if (isPlaying) {
      playIntervalRef.current = setInterval(() => {
        setCurrentFrameIndex((prev) => (prev + 1) % frames.length);
      }, 1000 / fps);

      if (audioRef.current) {
        const playPromise = audioRef.current.play();
        if (playPromise !== undefined) {
          playPromise.catch(e => {
            if (e.name !== 'AbortError') {
              console.error("Audio play failed:", e);
            }
          });
        }
      }
    } else {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
      if (audioRef.current) {
        audioRef.current.pause();
      }
    }

    return () => {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    };
  }, [isPlaying, frames.length, fps]);

  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  const handleDrawEnd = useCallback((newLayerData: string, newCompositeData: string) => {
    setFrames((prevFrames) => {
      const newFrames = [...prevFrames];
      const currentFrame = newFrames[currentFrameIndex];

      const currentLayers = currentFrame.layers || [
        createBlankLayer(canvasSize.width, canvasSize.height),
        createBlankLayer(canvasSize.width, canvasSize.height),
        createBlankLayer(canvasSize.width, canvasSize.height)
      ];

      const newLayers = [...currentLayers];
      newLayers[activeLayerIndex] = newLayerData;

      newFrames[currentFrameIndex] = {
        ...currentFrame,
        layers: newLayers,
        dataUrl: newCompositeData
      };
      return newFrames;
    });
  }, [currentFrameIndex, activeLayerIndex, canvasSize]);

  const handleAddFrame = () => {
    const newFrame = createLayeredFrame(canvasSize.width, canvasSize.height);
    setFrames((prev) => {
      const newFrames = [...prev];
      newFrames.splice(currentFrameIndex + 1, 0, newFrame);
      return newFrames;
    });
    setCurrentFrameIndex((prev) => prev + 1);
  };

  const handleDuplicateFrame = () => {
    const currentFrame = frames[currentFrameIndex];
    const newLayers = currentFrame.layers ? [...currentFrame.layers] : [currentFrame.dataUrl, createBlankLayer(canvasSize.width, canvasSize.height), createBlankLayer(canvasSize.width, canvasSize.height)];

    const newFrame: Frame = {
      id: uuidv4(),
      dataUrl: currentFrame.dataUrl,
      layers: newLayers
    };
    setFrames((prev) => {
      const newFrames = [...prev];
      newFrames.splice(currentFrameIndex + 1, 0, newFrame);
      return newFrames;
    });
    setCurrentFrameIndex((prev) => prev + 1);
  };

  const handleDeleteFrame = (index: number) => {
    if (frames.length <= 1) return;
    setFrames((prev) => prev.filter((_, i) => i !== index));
    if (currentFrameIndex >= index && currentFrameIndex > 0) {
      setCurrentFrameIndex((prev) => prev - 1);
    }
  };

  const handleClearFrame = () => {
    const newFrame = createLayeredFrame(canvasSize.width, canvasSize.height);
    setFrames(prev => {
      const nf = [...prev];
      nf[currentFrameIndex] = newFrame;
      return nf;
    });
  };

  const handleUploadAudio = (file: File) => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const url = URL.createObjectURL(file);
    setAudioUrl(url);
  };

  const handleRemoveAudio = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  };

  const handleSurprise = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      const currentFrameData = frames[currentFrameIndex].dataUrl;
      const meltFramesData = await generateMeltAnimation(currentFrameData, 20);
      if (meltFramesData.length === 0) {
        setIsProcessing(false);
        return;
      }
      const newFramesObj = meltFramesData.map(url => ({
        id: uuidv4(),
        dataUrl: url,
        layers: [url, createBlankLayer(canvasSize.width, canvasSize.height), createBlankLayer(canvasSize.width, canvasSize.height)]
      }));
      setFrames(prev => {
        const newF = [...prev];
        newF.splice(currentFrameIndex + 1, 0, ...newFramesObj);
        return newF;
      });
      setTimeout(() => setIsPlaying(true), 100);
    } catch (e) {
      console.error("Melt effect failed", e);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAIEdit = async (prompt: string) => {
    const currentFrame = frames[currentFrameIndex];
    const compositeData = currentFrame.dataUrl;
    const newImageData = await editFrameWithAI(compositeData, prompt);
    handleDrawEnd(newImageData, newImageData);
  };

  const handleColorPicked = (color: string) => {
    setDrawingSettings(prev => ({
      ...prev,
      color,
      tool: ToolType.PENCIL // Automatically switch back to a drawing tool
    }));
  };

  // --- Intro Handling ---
  if (showIntro) {
    return <Intro onComplete={() => setShowIntro(false)} />;
  }

  // --- Render View Routing ---

  if (currentView === 'home') {
    return (
      <Home
        projects={projects}
        onCreateProject={handleCreateProject}
        onSelectProject={handleSelectProject}
        onDeleteProject={handleDeleteProject}
      />
    );
  }

  // --- Editor Render ---

  return (
    <div className="w-screen h-[100dvh] overflow-hidden bg-paper-pattern text-[#1D1D1F] flex flex-row">

      {/* Cinema Mode Overlay */}
      {cinemaMode && (
        <CinemaView
          frameData={frames[currentFrameIndex].dataUrl}
          isPlaying={isPlaying}
          onTogglePlay={() => setIsPlaying(!isPlaying)}
          onClose={() => {
            setCinemaMode(false);
            setIsPlaying(false);
          }}
        />
      )}

      {/* Live Voice Overlay */}
      {isVoiceActive && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm animate-enter">
          <LiveVoice onClose={() => setIsVoiceActive(false)} />
        </div>
      )}

      <audio ref={audioRef} src={audioUrl || undefined} loop />

      {/* Main Content Area (Left Column) */}
      <div className="flex-1 flex flex-col relative min-w-0 h-full">

        {/* Top Bar */}
        <div className="absolute top-0 left-0 right-0 z-30 flex justify-between items-start p-4 md:p-6 pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-3">
            <button
              onClick={handleGoHome}
              className="w-10 h-10 bg-white/90 backdrop-blur-xl rounded-xl shadow-paper hover:shadow-paper-hover flex items-center justify-center text-gray-600 hover:text-apple-blue transition-all border border-white/60"
              title="Back to Projects"
            >
              <ArrowLeft size={20} />
            </button>

            <div className="w-10 h-10 bg-[#1D1D1F] rounded-xl shadow-lg flex items-center justify-center text-white font-bold text-lg">
              St
            </div>

            {/* Voice Chat Button */}
            <button
              onClick={() => setIsVoiceActive(true)}
              className="w-10 h-10 rounded-full bg-white/90 backdrop-blur-xl text-apple-blue hover:bg-apple-blue hover:text-white shadow-paper hover:shadow-paper-hover flex items-center justify-center transition-all border border-white/60"
              title="Voice Chat"
            >
              <Mic size={20} />
            </button>

            {/* Tutorials Toggle */}
            <button
              onClick={() => setShowTutorials(!showTutorials)}
              className={`w-10 h-10 rounded-full shadow-paper backdrop-blur-xl flex items-center justify-center transition-all border border-white/60 ${showTutorials ? 'bg-apple-blue text-white' : 'bg-white/90 text-gray-600 hover:text-apple-blue'}`}
              title="Learning Center"
            >
              <GraduationCap size={20} />
            </button>
          </div>

          <div className="pointer-events-auto">
            <MagicAssist
              currentFrameData={frames[currentFrameIndex].dataUrl}
              onSurprise={handleSurprise}
              onAIEdit={handleAIEdit}
              isProcessing={isProcessing}
            />
          </div>
        </div>

        {/* Layers Panel (Floating) */}
        {showLayers && (
          <div className="absolute top-20 right-6 z-40">
            <LayersPanel
              layers={frames[currentFrameIndex].layers || []}
              activeIndex={activeLayerIndex}
              onSelectLayer={setActiveLayerIndex}
              onClose={() => setShowLayers(false)}
            />
          </div>
        )}

        {/* Canvas Area */}
        <div className="flex-1 min-h-0 flex items-center justify-center z-0 pt-20 pb-4 px-4">
          <div className={`
                  relative shadow-paper-hover rounded-2xl md:rounded-sm overflow-hidden transition-all duration-500 ease-out bg-[#FAFAF8] border border-gray-200/50
                  w-full h-full
              `}>
            <div ref={containerRef} className="w-full h-full relative">
              {isPlaying && !cinemaMode ? (
                <img
                  src={frames[currentFrameIndex].dataUrl}
                  alt="Animation playback"
                  className="w-full h-full object-contain bg-[#FAFAF8]"
                />
              ) : (
                <div className="w-full h-full">
                  <Canvas
                    ref={canvasRef}
                    width={canvasSize.width}
                    height={canvasSize.height}
                    settings={drawingSettings}
                    layers={frames[currentFrameIndex].layers || [frames[currentFrameIndex].dataUrl, createBlankLayer(canvasSize.width, canvasSize.height), createBlankLayer(canvasSize.width, canvasSize.height)]}
                    activeLayerIndex={activeLayerIndex}
                    currentFrameId={frames[currentFrameIndex].id}
                    prevFrameData={currentFrameIndex > 0 ? frames[currentFrameIndex - 1].dataUrl : undefined}
                    onionSkin={onionSkin}
                    showGrid={showGrid}
                    onDrawEnd={handleDrawEnd}
                    isPlaying={isPlaying}
                    onHistoryChange={(canUndo, canRedo) => setHistoryState({ canUndo, canRedo })}
                    onPickColor={handleColorPicked}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Floating Tools (Desktop) */}
        <div className="absolute left-6 top-1/2 -translate-y-1/2 z-20 hidden md:block">
          <Toolbar
            settings={drawingSettings}
            onUpdateSettings={(s) => setDrawingSettings(prev => ({ ...prev, ...s }))}
            onClear={handleClearFrame}
            onUndo={() => canvasRef.current?.undo()}
            onRedo={() => canvasRef.current?.redo()}
            onToggleGrid={() => setShowGrid(!showGrid)}
            onToggleLayers={() => setShowLayers(!showLayers)}
            showGrid={showGrid}
            showLayers={showLayers}
            canUndo={historyState.canUndo}
            canRedo={historyState.canRedo}
            orientation="vertical"
          />
        </div>

        {/* Mobile Toolbar */}
        <div className="absolute top-20 left-4 z-20 md:hidden bottom-24 overflow-y-auto no-scrollbar pointer-events-auto max-h-[60vh]">
          <Toolbar
            settings={drawingSettings}
            onUpdateSettings={(s) => setDrawingSettings(prev => ({ ...prev, ...s }))}
            onClear={handleClearFrame}
            onUndo={() => canvasRef.current?.undo()}
            onRedo={() => canvasRef.current?.redo()}
            onToggleGrid={() => setShowGrid(!showGrid)}
            onToggleLayers={() => setShowLayers(!showLayers)}
            showGrid={showGrid}
            showLayers={showLayers}
            canUndo={historyState.canUndo}
            canRedo={historyState.canRedo}
            orientation="vertical"
          />
        </div>

        {/* Timeline */}
        <div className="flex-shrink-0 z-20 px-4 pb-6 flex justify-center w-full">
          <div className="w-full max-w-4xl">
            <Timeline
              frames={frames}
              currentFrameIndex={currentFrameIndex}
              isPlaying={isPlaying}
              fps={fps}
              onionSkin={onionSkin}
              onSelectFrame={setCurrentFrameIndex}
              onAddFrame={handleAddFrame}
              onDuplicateFrame={handleDuplicateFrame}
              onDeleteFrame={handleDeleteFrame}
              onTogglePlay={() => setIsPlaying(!isPlaying)}
              onChangeFps={setFps}
              onToggleOnionSkin={() => setOnionSkin(!onionSkin)}
              audioUrl={audioUrl}
              onUploadAudio={handleUploadAudio}
              onRemoveAudio={handleRemoveAudio}
              onEnterCinema={() => setCinemaMode(true)}
            />
          </div>
        </div>

      </div>

      {/* Tutorial Sidebar */}
      <TutorialSidebar isOpen={showTutorials} onClose={() => setShowTutorials(false)} />

    </div>
  );
}

export default App;
