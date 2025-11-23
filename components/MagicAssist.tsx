import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, Lightbulb, Gift, MessageCircle, X, ChevronDown, Wand2 } from 'lucide-react';
import { generateAnimationIdea, tellStoryAboutFrame } from '../services/geminiService';

interface MagicAssistProps {
  currentFrameData: string;
  onSurprise: () => void;
  onAIEdit: (prompt: string) => Promise<void>;
  isProcessing: boolean;
}

export const MagicAssist: React.FC<MagicAssistProps> = ({ currentFrameData, onSurprise, onAIEdit, isProcessing }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [result, setResult] = useState<{type: 'idea' | 'story' | 'error', text: string} | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editPrompt, setEditPrompt] = useState('');
  
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setEditMode(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleGetIdea = async () => {
    setIsLoading(true);
    setResult(null);
    const text = await generateAnimationIdea();
    setResult({ type: 'idea', text });
    setIsLoading(false);
  };

  const handleGetStory = async () => {
    setIsLoading(true);
    setResult(null);
    const text = await tellStoryAboutFrame(currentFrameData);
    setResult({ type: 'story', text });
    setIsLoading(false);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!editPrompt.trim()) return;
      
      setIsLoading(true);
      try {
        await onAIEdit(editPrompt);
        setIsOpen(false);
        setEditMode(false);
        setEditPrompt('');
      } catch (error) {
        setResult({ type: 'error', text: "Couldn't edit the image. Try again!" });
      } finally {
        setIsLoading(false);
      }
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => { setIsOpen(!isOpen); setEditMode(false); }}
        className={`
            flex items-center gap-2 px-4 py-2 rounded-full shadow-sm transition-all duration-300
            ${isOpen ? 'bg-gray-900 text-white' : 'bg-white text-gray-800 hover:bg-gray-50'}
            font-medium text-sm border border-gray-100
        `}
      >
        <Sparkles size={16} className={isProcessing ? 'animate-pulse text-apple-purple' : 'text-apple-purple'} />
        <span>Magic</span>
        <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-80 glass-panel rounded-2xl p-2 shadow-xl z-50 origin-top-right animate-in fade-in zoom-in-95 duration-200">
            
            {editMode ? (
                 <div className="p-3">
                    <div className="flex items-center gap-2 mb-3 text-gray-800 font-semibold text-sm">
                        <div className="w-8 h-8 rounded-full bg-apple-indigo/10 text-apple-indigo flex items-center justify-center">
                            <Wand2 size={16} />
                        </div>
                        Edit Frame
                        <button onClick={() => setEditMode(false)} className="ml-auto text-gray-400 hover:text-gray-600">
                            <X size={14} />
                        </button>
                    </div>
                    <form onSubmit={handleEditSubmit}>
                        <textarea
                            value={editPrompt}
                            onChange={(e) => setEditPrompt(e.target.value)}
                            placeholder="Ex: Add a retro filter, Make it look like a sketch, Add a sun in the corner..."
                            className="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-apple-indigo/20 focus:border-apple-indigo outline-none resize-none h-24 mb-3"
                            autoFocus
                        />
                        <button 
                            type="submit" 
                            disabled={isLoading || !editPrompt.trim()}
                            className="w-full py-2 bg-apple-indigo text-white rounded-lg font-semibold text-xs hover:bg-apple-indigo/90 disabled:opacity-50 transition-colors"
                        >
                            {isLoading ? 'Generating...' : 'Apply Magic Edit'}
                        </button>
                    </form>
                 </div>
            ) : (
                !result && !isLoading && (
                    <div className="flex flex-col gap-1">
                        <button 
                            onClick={handleGetIdea}
                            disabled={isLoading || isProcessing}
                            className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50/80 transition-colors text-left w-full"
                        >
                            <div className="w-8 h-8 rounded-full bg-apple-yellow/20 text-apple-yellow flex items-center justify-center">
                                <Lightbulb size={16} />
                            </div>
                            <div>
                                <div className="font-semibold text-sm text-gray-800">Get an Idea</div>
                                <div className="text-xs text-gray-500">Stuck? Let AI help.</div>
                            </div>
                        </button>

                        <button 
                            onClick={handleGetStory}
                            disabled={isLoading || isProcessing}
                            className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50/80 transition-colors text-left w-full"
                        >
                            <div className="w-8 h-8 rounded-full bg-apple-blue/20 text-apple-blue flex items-center justify-center">
                                <MessageCircle size={16} />
                            </div>
                            <div>
                                <div className="font-semibold text-sm text-gray-800">Feedback</div>
                                <div className="text-xs text-gray-500">Get encouragement.</div>
                            </div>
                        </button>

                        <div className="h-px bg-gray-100 my-1 mx-2" />
                        
                        <button 
                            onClick={() => setEditMode(true)}
                            disabled={isLoading || isProcessing}
                            className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50/80 transition-colors text-left w-full"
                        >
                            <div className="w-8 h-8 rounded-full bg-apple-indigo/10 text-apple-indigo flex items-center justify-center">
                                <Wand2 size={16} />
                            </div>
                            <div>
                                <div className="font-semibold text-sm text-gray-800">AI Edit</div>
                                <div className="text-xs text-gray-500">Transform your drawing</div>
                            </div>
                        </button>

                        <button 
                            onClick={() => { onSurprise(); setIsOpen(false); }}
                            disabled={isLoading || isProcessing}
                            className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50/80 transition-colors text-left w-full group"
                        >
                            <div className="w-8 h-8 rounded-full bg-apple-red/10 text-apple-red flex items-center justify-center group-hover:scale-110 transition-transform">
                                <Gift size={16} />
                            </div>
                            <div>
                                <div className="font-semibold text-sm text-gray-800">Melt Effect</div>
                                <div className="text-xs text-gray-500">Animate your drawing!</div>
                            </div>
                        </button>
                    </div>
                )
            )}

            {isLoading && !editMode && (
                <div className="p-8 text-center text-gray-400">
                    <Sparkles className="animate-spin mx-auto mb-2 text-apple-purple" size={24} />
                    <span className="text-xs font-medium">Working magic...</span>
                </div>
            )}

            {result && (
                <div className="p-4 relative">
                    <button 
                        onClick={() => setResult(null)} 
                        className="absolute top-2 right-2 text-gray-400 hover:text-gray-600"
                    >
                        <X size={14} />
                    </button>
                    <div className="mb-2">
                        {result.type === 'idea' && <Lightbulb size={20} className="text-apple-yellow" />}
                        {result.type === 'story' && <MessageCircle size={20} className="text-apple-blue" />}
                        {result.type === 'error' && <X size={20} className="text-apple-red" />}
                    </div>
                    <p className="text-gray-800 text-sm leading-relaxed font-medium">
                        "{result.text}"
                    </p>
                    <button 
                        onClick={() => setResult(null)}
                        className="mt-4 w-full py-2 bg-gray-100 rounded-lg text-xs font-semibold text-gray-600 hover:bg-gray-200"
                    >
                        Done
                    </button>
                </div>
            )}
        </div>
      )}
    </div>
  );
};