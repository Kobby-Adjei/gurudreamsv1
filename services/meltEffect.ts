
export const generateMeltAnimation = async (
  startDataUrl: string,
  numFrames: number = 20
): Promise<string[]> => {
  return new Promise((resolve) => {
    const img = new Image();
    
    img.onload = () => {
      // CRITICAL FIX: Use naturalWidth to get the true dimensions of the source image
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;

      if (width === 0 || height === 0) {
          console.warn("Melt effect: Image has 0 dimensions, returning empty.");
          resolve([]);
          return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        resolve([]);
        return;
      }

      // Draw initial image to get pixel data
      ctx.drawImage(img, 0, 0);
      const srcData = ctx.getImageData(0, 0, width, height);
      const srcPixels = srcData.data;
      
      const frames: string[] = [];
      
      // Physics state
      const yOffsets = new Float32Array(width).fill(0);
      const velocities = new Float32Array(width).fill(0);
      
      // Initialize random drips (seeds)
      for(let x = 0; x < width; x++) {
          // Create "drips" that start faster
          if (Math.random() > 0.96) {
              velocities[x] = Math.random() * 8 + 4; // Fast drips start immediately
          } else {
              velocities[x] = Math.random() * 2; // General slow melt
          }
      }

      // Generate frames
      for (let f = 0; f < numFrames; f++) {
        const destData = ctx.createImageData(width, height);
        const destPixels = destData.data;

        // Fill background with white first (assuming paper background)
        // This prevents transparent voids appearing at the top
        for (let i = 0; i < destPixels.length; i += 4) {
            destPixels[i] = 255;     // R
            destPixels[i+1] = 255;   // G
            destPixels[i+2] = 255;   // B
            destPixels[i+3] = 255;   // A
        }
        
        // Update physics for this frame
        for (let x = 0; x < width; x++) {
            // Gravity acceleration - Make it accelerate faster for dramatic effect
            velocities[x] += 0.8 + Math.random() * 0.5;
            
            // Viscosity (smooth with neighbors) to create "globs" rather than noise
            if (x > 1 && x < width - 2) {
                const avgVel = (velocities[x-1] + velocities[x] + velocities[x+1]) / 3;
                velocities[x] = velocities[x] * 0.7 + avgVel * 0.3;
                
                const avgOffset = (yOffsets[x-1] + yOffsets[x] + yOffsets[x+1]) / 3;
                yOffsets[x] = yOffsets[x] * 0.9 + avgOffset * 0.1;
            }

            // Move drop
            yOffsets[x] += velocities[x];
            const currentOffset = Math.floor(yOffsets[x]);
            
            // Render the column based on offset
            // We iterate from bottom to top to handle the shifting logically, 
            // though source read order doesn't strictly matter if we don't write to src.
            for (let y = 0; y < height; y++) {
                const destY = y + currentOffset;
                
                // Only write if inside canvas bounds
                if (destY < height) {
                    const srcIdx = (y * width + x) * 4;
                    const destIdx = (destY * width + x) * 4;
                    
                    // Copy pixel data directly from ORIGINAL source
                    // We only copy if the source pixel isn't pure white (optimization)
                    // or just copy everything to be safe. Copying everything is safer for correctness.
                    
                    destPixels[destIdx] = srcPixels[srcIdx];
                    destPixels[destIdx+1] = srcPixels[srcIdx+1];
                    destPixels[destIdx+2] = srcPixels[srcIdx+2];
                    destPixels[destIdx+3] = srcPixels[srcIdx+3];
                }
            }
        }
        
        ctx.putImageData(destData, 0, 0);
        frames.push(canvas.toDataURL());
      }
      
      resolve(frames);
    };

    img.onerror = (e) => {
        console.error("Failed to load image for melting", e);
        resolve([]);
    };

    // Set src AFTER defining onload to avoid race conditions
    img.src = startDataUrl;
  });
};
